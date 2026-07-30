import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
	type AskChatRuntime,
	AskChatRuntimeError,
	HeadlessAuthController,
	ModelRuntime,
	PiAgentRuntime,
	type ProviderRegistry,
	SecretVaultCredentialStore,
} from "@moshu/agent-runtime";
import type { AgentsServerBootstrapRecord } from "@moshu/contracts";
import {
	executorToolRpcTimeoutMs,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcEvents,
	productRpcMethods,
	remoteAccessMutationMethods,
	remoteAccessMutationRpcTimeoutMs,
	runtimeBoxProtocolMinVersion,
	runtimeBoxProtocolMaxVersion,
	runtimeDiagnosticsOutputSchema,
} from "@moshu/contracts";
import {
	currentAppDatabaseVersion,
	openAppDatabase,
	prepareCoordinatedDatabaseReset,
} from "@moshu/database";
import { PairingSessionNotFoundError } from "@moshu/database";
import { FileMcpSecretStore, McpLifecycleManager } from "@moshu/mcp-runtime";
import { FileSkillContentStore } from "@moshu/skill-runtime";
import {
	createRpcBearerAuthenticator,
	createRpcServer,
	type RpcServer,
	rpcJsonValueSchema,
	CURRENT_PROCESS_RPC_PROTOCOL,
} from "@moshu/process-rpc";

import { ChatApplicationService } from "./chat-application-service";
import { DurableActionAuthorizationService } from "./action-authorization-service";
import { AgentServerIdentity } from "./agent-server-identity";
import { DevTunnelService } from "./dev-tunnel-service";
import { resolveEffectiveSkills } from "./effective-skill-resolver";
import { RuntimeBoxRegistry } from "./runtime-box-registry";
import { RuntimeBoxGenerationFence } from "./runtime-box-generation-fence";
import { RuntimeIngressAuth } from "./runtime-ingress-auth";
import { FileProviderRegistryStore } from "./file-provider-registry-store";
import { McpActionDispatcher } from "./mcp-action-dispatcher";
import { createProviderAuthDiagnosticLog } from "./provider-auth-diagnostic-log";
import {
	agentsServerClientMethodAllowlist,
	agentsServerRuntimeMethodAllowlist,
	createRuntimeBoxesSnapshot,
	createProductRpcHandlers,
	ProductEventRouter,
} from "./product-rpc";

export interface AgentsServerInstance {
	readonly productRpcServer: RpcServer;
	readonly runtimeRpcServer: RpcServer;
	readonly devTunnelService: DevTunnelService;
	readonly runtimeBoxRegistry: RuntimeBoxRegistry;
	readonly actionJournalEpoch: string;
	readonly ready: Promise<void>;
	shutdown(): Promise<void>;
}

export interface CreateAgentsServerOptions {
	bootstrap: AgentsServerBootstrapRecord;
	serverVersion: string;
	createRuntime?: (
		providers: ProviderRegistry,
		modelRuntime: ModelRuntime,
		runtimeBoxRegistry: RuntimeBoxRegistry,
	) => AskChatRuntime;
	fetchProviderModels?: ConstructorParameters<
		typeof ChatApplicationService
	>[0]["fetchProviderModels"];
	agentSessionCleanupAttemptTimeoutMs?: number;
	agentSessionCleanupMaxInFlightAttempts?: number;
	agentSessionCleanupStartupTimeoutMs?: number;
	agentSessionCleanupStartupMaxAttempts?: number;
	shutdownTimeoutMs?: number;
	reportDiagnostic?: (message: string) => void;
}

export async function createAgentsServer(
	options: CreateAgentsServerOptions,
): Promise<AgentsServerInstance> {
	const reportDiagnostic =
		options.reportDiagnostic ??
		((message: string): void => {
			console.error(message);
		});
	assertAbsoluteDataPaths(options.bootstrap);
	mkdirSync(dirname(options.bootstrap.paths.productDatabase), { recursive: true, mode: 0o700 });
	mkdirSync(options.bootstrap.paths.agentDataDirectory, { recursive: true, mode: 0o700 });
	const reset = prepareCoordinatedDatabaseReset({
		productDatabase: options.bootstrap.paths.productDatabase,
	});
	if (reset.reset) {
		const previousSchema =
			reset.previousProductVersion === undefined
				? "unavailable after interrupted reset"
				: String(reset.previousProductVersion);
		reportDiagnostic(
			`Reset the local product store (${reset.reason}, previous product schema ${previousSchema}).`,
		);
	}

	const agentServerMcpSecrets = new FileMcpSecretStore(
		join(options.bootstrap.paths.agentDataDirectory, "mcp-secrets"),
	);
	const agentServerMcpWorkspaces = join(
		options.bootstrap.paths.agentDataDirectory,
		"mcp-workspaces",
	);
	mkdirSync(agentServerMcpWorkspaces, { recursive: true, mode: 0o700 });
	chmodSync(agentServerMcpWorkspaces, 0o700);
	const agentServerSkillContent = new FileSkillContentStore(
		join(options.bootstrap.paths.agentDataDirectory, "server-skills"),
	);
	const database = openAppDatabase(options.bootstrap.paths.productDatabase, {
		agentServerMcpSecrets,
		agentServerSkillContent,
		prepareAgentServerMcpStdioCwd(stableResourceId) {
			const directory = join(agentServerMcpWorkspaces, stableResourceId);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			return directory;
		},
	});
	agentServerMcpSecrets.cleanupOrphans(new Set(database.agentServerMcps.listSecretLocators()));
	database.agentServerMcps.drainPendingSecretDeletions();
	database.agentServerSkills.reconcileContent();
	const recoveredActions = database.actions.recoverOnStartup();
	if (recoveredActions.cancelled > 0 || recoveredActions.outcomeUnknown > 0) {
		reportDiagnostic(
			`Recovered ${recoveredActions.cancelled} undispatched Actions and ` +
				`${recoveredActions.outcomeUnknown} Actions with unknown outcomes.`,
		);
	}
	let chatService: ChatApplicationService | undefined;
	let productRpcServer: RpcServer | undefined;
	let runtimeRpcServer: RpcServer | undefined;
	let devTunnelService: DevTunnelService | undefined;
	let unsubscribe: (() => void) | undefined;
	let authController: HeadlessAuthController | undefined;
	let agentServerMcpLifecycle: McpLifecycleManager | undefined;
	try {
		const agentDataDirectory = options.bootstrap.paths.agentDataDirectory;
		const credentials = new SecretVaultCredentialStore(
			join(agentDataDirectory, "credentials", "vault.json"),
		);
		const modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const providers = new FileProviderRegistryStore(
			join(agentDataDirectory, "providers.json"),
			modelRuntime,
			credentials,
		);
		await providers.initialize();
		const serverMcpLifecycle = new McpLifecycleManager(database.agentServerMcps, {
			reportDiagnostic,
		});
		agentServerMcpLifecycle = serverMcpLifecycle;
		await serverMcpLifecycle.start();
		const activeRuntimeBox = database.runtimeBoxes.getActive();
		let publishRuntimeBoxesChanged = () => undefined;
		const actionAuthorizer = new DurableActionAuthorizationService(
			database.actions,
			options.bootstrap.serverIdentity,
		);
		const runtimeBoxRegistry = new RuntimeBoxRegistry({
			descriptors: database.runtimeBoxes.list(),
			compatibilities: database.runtimeBoxes.listCompatibility(),
			activeRuntimeBoxId: activeRuntimeBox.runtimeBoxId,
			onRegister: (descriptor) => database.runtimeBoxes.upsertRegistration(descriptor),
			onChange: () => publishRuntimeBoxesChanged(),
			actionAuthorizer,
			inventoryRepository: database.runtimeBoxInventory,
			reportDiagnostic,
			isDeviceKeyActive: (runtimeBoxId, deviceKeyId) => {
				try {
					database.runtimeBoxPairings.getActiveDeviceKey(runtimeBoxId, deviceKeyId);
					return true;
				} catch (error) {
					if (error instanceof PairingSessionNotFoundError) {
						return false;
					}
					throw error;
				}
			},
		});
		publishRuntimeBoxesChanged = () => {
			const server = productRpcServer;
			if (server === undefined) {
				return;
			}
			const payload = rpcJsonValueSchema.parse(
				createRuntimeBoxesSnapshot(
					database.runtimeBoxes,
					runtimeBoxRegistry,
					database.runtimeBoxPairings,
				),
			);
			for (const peer of server.peers) {
				if (peer.remoteIdentity.role !== "client") {
					continue;
				}
				try {
					peer.emitEvent(productRpcEvents.runtimeBoxesChanged, payload);
				} catch (error) {
					peer.close(1011, "Runtime Box snapshot publication failed.");
					console.error("Failed to publish Runtime Box snapshot.", error);
				}
			}
		};
		const agentServerIdentity = AgentServerIdentity.open(
			join(agentDataDirectory, "runtime-ingress", "identity.json"),
		);
		const mcpActionDispatcher = new McpActionDispatcher(
			agentServerIdentity.agentServerId,
			runtimeBoxRegistry,
			serverMcpLifecycle,
			actionAuthorizer,
		);
		const runtime =
			options.createRuntime?.(providers, modelRuntime, runtimeBoxRegistry) ??
			new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				runtimeBoxGateway: runtimeBoxRegistry,
				mcpToolGateway: mcpActionDispatcher,
			});
		const writeAuthDiagnostic = createProviderAuthDiagnosticLog(
			join(agentDataDirectory, "diagnostics", "provider-auth.jsonl"),
		);
		authController = new HeadlessAuthController(modelRuntime, {
			onCredentialChanged: (providerId) => providers.onCredentialChanged(providerId),
			reportDiagnostic(event) {
				writeAuthDiagnostic(event);
				console.error(`[provider-auth] ${JSON.stringify(event)}`);
			},
		});
		const eventRouter = new ProductEventRouter();
		const runtimeIngressAuth = new RuntimeIngressAuth({
			pairings: database.runtimeBoxPairings,
			runtimeBoxes: database.runtimeBoxes,
			identity: agentServerIdentity,
			rpcIdentity: options.bootstrap.serverIdentity,
			actionJournalEpoch: database.runtimeBoxes.getActionJournalEpoch(),
			localAuthenticator: createRpcBearerAuthenticator(
				options.bootstrap.peerBindings.filter((binding) => binding.identity.role === "runtime-box"),
			),
			onUpgradeRequired: (runtimeBoxId) => runtimeBoxRegistry.markUpgradeRequired(runtimeBoxId),
		});
		chatService = new ChatApplicationService({
			sessions: database.sessions,
			runs: database.runs,
			actions: database.actions,
			providers,
			runtime,
			...(options.fetchProviderModels === undefined
				? {}
				: { fetchProviderModels: options.fetchProviderModels }),
			isRuntimeReady: (runtimeBoxId) => runtimeBoxRegistry.isReady(runtimeBoxId),
			getActiveRuntimeBoxId: () => database.runtimeBoxes.getActive().runtimeBoxId,
			resolveRuntimeResources: async (runtimeBoxId, signal) => {
				const profile = database.runtimeProfiles.getOrCreate("moshu.default", runtimeBoxId);
				const globalProfile = database.agentGlobalProfiles.getOrCreate("moshu.default");
				const validation = await runtimeBoxRegistry.validateResources(
					runtimeBoxId,
					{ refs: profile.resources },
					signal,
				);
				if (!validation.valid) {
					throw new AskChatRuntimeError({
						kind: "runtime_box_unavailable",
						message: validation.issues[0]?.message ?? "Runtime Profile resource validation failed.",
						retryable: true,
					});
				}
				const skills = await resolveEffectiveSkills({
					runtimeBoxId,
					serverRefs: globalProfile.serverSkillRefs,
					boxRefs: profile.resources,
					serverSkills: database.agentServerSkills,
					runtimeBoxes: runtimeBoxRegistry,
					signal,
				});
				const serverMcpResources = database.agentServerMcps
					.resolveRefs(globalProfile.serverMcpRefs)
					.map((resource) => ({
						owner: { kind: "agent-server" as const },
						stableResourceId: resource.stableResourceId,
						version: resource.version,
						contentHash: resource.contentHash,
						tools: resource.tools,
					}));
				const runtimeBoxMcpResources = validation.resources
					.filter((resource) => resource.resourceKind === "mcp")
					.map((resource) => ({
						owner: { kind: "runtime-box" as const, runtimeBoxId },
						stableResourceId: resource.stableResourceId,
						version: resource.version,
						contentHash: resource.contentHash,
						tools: resource.mcpTools,
					}));
				return { skills, mcpResources: [...serverMcpResources, ...runtimeBoxMcpResources] };
			},
			logger: {
				error(message, error) {
					console.error(message, error);
				},
				info(message) {
					reportDiagnostic(message);
				},
			},
			...(options.agentSessionCleanupAttemptTimeoutMs === undefined
				? {}
				: {
						agentSessionCleanupAttemptTimeoutMs: options.agentSessionCleanupAttemptTimeoutMs,
					}),
			...(options.agentSessionCleanupMaxInFlightAttempts === undefined
				? {}
				: {
						agentSessionCleanupMaxInFlightAttempts: options.agentSessionCleanupMaxInFlightAttempts,
					}),
			...(options.agentSessionCleanupStartupTimeoutMs === undefined
				? {}
				: {
						agentSessionCleanupStartupTimeoutMs: options.agentSessionCleanupStartupTimeoutMs,
					}),
			...(options.agentSessionCleanupStartupMaxAttempts === undefined
				? {}
				: {
						agentSessionCleanupStartupMaxAttempts: options.agentSessionCleanupStartupMaxAttempts,
					}),
			...(options.shutdownTimeoutMs === undefined
				? {}
				: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
		});
		const ready = chatService.drainPendingAgentSessionCleanups({ batchSize: 64 });
		const requireDevTunnelService = (): DevTunnelService => {
			if (devTunnelService === undefined) {
				throw new Error("Dev Tunnel service is not initialized.");
			}
			return devTunnelService;
		};

		const handlers = createProductRpcHandlers({
			chatService,
			runtimeBoxRegistry,
			runtimeBoxes: database.runtimeBoxes,
			runtimeBoxPairings: database.runtimeBoxPairings,
			projects: database.projects,
			runtimeBoxInventory: database.runtimeBoxInventory,
			runtimeProfiles: database.runtimeProfiles,
			agentGlobalProfiles: database.agentGlobalProfiles,
			agentServerMcps: database.agentServerMcps,
			agentServerSkills: database.agentServerSkills,
			runtimeIngressAuth,
			getDevTunnelService: requireDevTunnelService,
			eventRouter,
			serverVersion: options.serverVersion,
			authController,
			getRuntimeDiagnostics: () => {
				const integrity = database.client
					.query<{ integrity_check: string }, []>("PRAGMA quick_check")
					.get()?.integrity_check;
				const runtimeBoxes = runtimeBoxRegistry.listInfo();
				return runtimeDiagnosticsOutputSchema.parse({
					generatedAt: new Date().toISOString(),
					server: {
						version: options.serverVersion,
						identity: options.bootstrap.serverIdentity,
						processRpcProtocol: CURRENT_PROCESS_RPC_PROTOCOL,
						runtimeProtocolMinVersion: runtimeBoxProtocolMinVersion,
						runtimeProtocolMaxVersion: runtimeBoxProtocolMaxVersion,
						transportSecurity: "relay-tls",
						noiseUpgradeAvailable: false,
					},
					database: {
						schemaVersion: currentAppDatabaseVersion,
						integrity: integrity === "ok" ? "ok" : "error",
					},
					runtimeBoxes,
					inventories: runtimeBoxes.map((item) => {
						const inventory = database.runtimeBoxInventory.list(item.runtimeBox.runtimeBoxId);
						return {
							runtimeBoxId: inventory.runtimeBoxId,
							...(inventory.inventoryEpoch === undefined
								? {}
								: { inventoryEpoch: inventory.inventoryEpoch }),
							...(inventory.inventoryRevision === undefined
								? {}
								: { inventoryRevision: inventory.inventoryRevision }),
							stale: inventory.stale,
							resourceCount: inventory.resources.length,
						};
					}),
					remoteAccess: requireDevTunnelService().getStatus(),
				});
			},
		});
		productRpcServer = createRpcServer({
			identity: options.bootstrap.serverIdentity,
			authenticate: createRpcBearerAuthenticator(
				options.bootstrap.peerBindings.filter((binding) => binding.identity.role === "client"),
			),
			acceptedPeerRoles: ["client"],
			handlers,
			methodAllowlist: agentsServerClientMethodAllowlist,
			limits: {
				maxFrameBytes: productRpcMaxFrameBytes,
				maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
			},
			requestTimeoutLimits: Object.fromEntries(
				remoteAccessMutationMethods.map((method) => [method, remoteAccessMutationRpcTimeoutMs]),
			),
			onClose(_info, peer) {
				eventRouter.releasePeer(peer);
			},
			onError(error) {
				console.error("agents-server product RPC error.", error);
			},
		});
		const createRuntimeRpcServer = (port?: number): RpcServer =>
			createRpcServer({
				identity: options.bootstrap.serverIdentity,
				hostname: "127.0.0.1",
				...(port === undefined ? {} : { port }),
				path: "/runtime",
				maxRequestBodyBytes: 32 * 1024,
				authenticate: runtimeIngressAuth.authenticate,
				handleHttpRequest: runtimeIngressAuth.handleHttpRequest,
				acceptedPeerRoles: ["runtime-box"],
				generationFence: new RuntimeBoxGenerationFence(database.runtimeBoxes),
				handlers,
				methodAllowlist: agentsServerRuntimeMethodAllowlist,
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
				requestTimeoutLimits: {
					[productRpcMethods.runtimeBoxToolInvoke]: executorToolRpcTimeoutMs,
					[productRpcMethods.runtimeBoxMcpToolInvoke]: executorToolRpcTimeoutMs,
				},
				onTraffic(direction, bytes, peer) {
					if (peer.remoteIdentity.deviceKeyId !== undefined) {
						devTunnelService?.recordTraffic(direction, bytes);
					}
				},
				onClose(_info, peer) {
					runtimeBoxRegistry.clear(peer);
				},
				onError(error) {
					console.error("agents-server Runtime ingress RPC error.", error);
				},
			});
		const persistedRuntimePort = database.remoteAccess.get().runtimeIngressPort;
		let portConflict: { expectedPort: number; boundPort: number } | undefined;
		try {
			runtimeRpcServer = createRuntimeRpcServer(persistedRuntimePort);
		} catch (error) {
			if (persistedRuntimePort === undefined || !isAddressInUseError(error)) {
				throw error;
			}
			runtimeRpcServer = createRuntimeRpcServer();
			portConflict = {
				expectedPort: persistedRuntimePort,
				boundPort: runtimeRpcServer.port,
			};
			reportDiagnostic(
				`Runtime ingress port ${persistedRuntimePort} is unavailable; Remote Access requires repair.`,
			);
		}
		if (persistedRuntimePort === undefined) {
			database.remoteAccess.setRuntimeIngressPort(runtimeRpcServer.port);
		}
		devTunnelService = new DevTunnelService({
			repository: database.remoteAccess,
			runtimeIngressPort: runtimeRpcServer.port,
			reportDiagnostic,
			...(portConflict === undefined ? {} : { portConflict }),
		});
		void devTunnelService.start().catch((error: unknown) => {
			reportDiagnostic(error instanceof Error ? error.message : "Dev Tunnel startup failed.");
		});
		const service = chatService;
		unsubscribe = service.subscribe((event) => {
			const server = productRpcServer;
			if (server !== undefined) {
				eventRouter.publish(server.peers, event, service.getClientRequestId(event.runId));
			}
		});

		let shutdownPromise: Promise<void> | undefined;
		return {
			productRpcServer,
			runtimeRpcServer,
			devTunnelService,
			runtimeBoxRegistry,
			actionJournalEpoch: database.runtimeBoxes.getActionJournalEpoch(),
			ready,
			shutdown() {
				if (shutdownPromise !== undefined) {
					return shutdownPromise;
				}
				const execution = (async () => {
					unsubscribe?.();
					productRpcServer?.stop();
					runtimeRpcServer?.stop();
					await devTunnelService?.shutdown();
					await authController?.dispose();
					await chatService?.shutdown();
					await runtimeBoxRegistry.shutdown();
					await agentServerMcpLifecycle?.shutdown();
					database.close();
				})();
				shutdownPromise = execution;
				void execution.catch(() => {
					if (shutdownPromise === execution) {
						shutdownPromise = undefined;
					}
				});
				return execution;
			},
		};
	} catch (error) {
		unsubscribe?.();
		await devTunnelService?.shutdown();
		productRpcServer?.stop();
		runtimeRpcServer?.stop();
		await authController?.dispose();
		await chatService?.shutdown();
		await agentServerMcpLifecycle?.shutdown();
		database.close();
		throw error;
	}
}

function assertAbsoluteDataPaths(bootstrap: AgentsServerBootstrapRecord): void {
	for (const [name, filename] of Object.entries(bootstrap.paths)) {
		if (!isAbsolute(filename)) {
			throw new Error(`agents-server ${name} path must be absolute.`);
		}
	}
}

function isAddressInUseError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as Error & { code?: unknown }).code === "EADDRINUSE"
	);
}
