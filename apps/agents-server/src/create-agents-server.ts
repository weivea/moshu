import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	productRpcEvents,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcMethods,
	remoteAccessMutationMethods,
	remoteAccessMutationRpcTimeoutMs,
	runtimeBoxProtocolMaxVersion,
	runtimeBoxProtocolMinVersion,
	runtimeDiagnosticsOutputSchema,
} from "@moshu/contracts";
import {
	currentAppDatabaseVersion,
	openAppDatabase,
	PairingSessionNotFoundError,
	prepareCoordinatedDatabaseReset,
} from "@moshu/database";
import { FileMcpSecretStore, McpLifecycleManager } from "@moshu/mcp-runtime";
import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	createRpcBearerAuthenticator,
	createRpcServer,
	type RpcPeer,
	type RpcServer,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import { FileSkillContentStore } from "@moshu/skill-runtime";
import { DurableActionAuthorizationService } from "./action-authorization-service";
import { AgentServerIdentity } from "./agent-server-identity";
import { ApprovalService } from "./approval-service";
import { ChatApplicationService } from "./chat-application-service";
import { DevTunnelService } from "./dev-tunnel-service";
import { resolveEffectiveSkills } from "./effective-skill-resolver";
import { FileProviderRegistryStore } from "./file-provider-registry-store";
import { McpActionDispatcher } from "./mcp-action-dispatcher";
import { MobileIngressAuth } from "./mobile-ingress-auth";
import { MobileIngressGenerationFence } from "./mobile-ingress-generation-fence";
import { MobileAttentionOutboxDrainer } from "./mobile-attention-drainer";
import {
	agentsServerClientMethodAllowlist,
	agentsServerMobileMethodAllowlist,
	agentsServerRuntimeMethodAllowlist,
	broadcastApprovalActivityChanged,
	broadcastMobileAttentionChanged,
	createProductRpcHandlers,
	createRuntimeBoxesSnapshot,
	ProductEventRouter,
	publishRetiredChatSessions,
} from "./product-rpc";
import { ProjectApplicationService } from "./project-application-service";
import { createProviderAuthDiagnosticLog } from "./provider-auth-diagnostic-log";
import { RuntimeBoxGenerationFence } from "./runtime-box-generation-fence";
import { RuntimeBoxRegistry } from "./runtime-box-registry";
import { RuntimeIngressAuth } from "./runtime-ingress-auth";

export interface AgentsServerInstance {
	readonly productRpcServer: RpcServer;
	readonly runtimeRpcServer: RpcServer;
	readonly mobileRpcServer: RpcServer;
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
	mkdirSync(dirname(options.bootstrap.paths.productDatabase), {
		recursive: true,
		mode: 0o700,
	});
	mkdirSync(options.bootstrap.paths.agentDataDirectory, {
		recursive: true,
		mode: 0o700,
	});
	const piSessionsDirectory = findAppOwnedPiSessionsDirectory(
		options.bootstrap.paths.agentDataDirectory,
	);
	const reset = prepareCoordinatedDatabaseReset({
		productDatabase: options.bootstrap.paths.productDatabase,
		beforeReset: () => {
			if (piSessionsDirectory !== undefined) {
				rmSync(piSessionsDirectory, { recursive: true });
			}
		},
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
	let projectService: ProjectApplicationService | undefined;
	let productRpcServer: RpcServer | undefined;
	let runtimeRpcServer: RpcServer | undefined;
	let mobileRpcServer: RpcServer | undefined;
	let devTunnelService: DevTunnelService | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeApprovals: (() => void) | undefined;
	let approvalSweepTimer: ReturnType<typeof setInterval> | undefined;
	let attentionDrainerHandle: { stop: () => void } | undefined;
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
		// The approval service is the durable execution gate + event hub for real Tool/Action
		// approvals. Injecting it into the authorizer makes side-effecting Actions wait for a client
		// decision (or a Session Allow-all policy) before any grant is issued or Runtime Box invoked.
		const approvalService = new ApprovalService(database.approvals, database.runs);
		const approvalRecovery = approvalService.recoverOnStartup();
		if (approvalRecovery.expired > 0) {
			reportDiagnostic(
				`Expired ${approvalRecovery.expired} pending Tool approvals that could not resume after restart.`,
			);
		}
		if (approvalRecovery.policiesReset > 0) {
			reportDiagnostic(
				`Reset ${approvalRecovery.policiesReset} Session Allow-all policies to off after restart (SEC-003).`,
			);
		}
		const actionAuthorizer = new DurableActionAuthorizationService(
			database.actions,
			database.runs,
			options.bootstrap.serverIdentity,
			{ allowSideEffects: true, approvalGate: approvalService },
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
			for (const peer of server.peers) {
				if (peer.remoteIdentity.role !== "client") {
					continue;
				}
				// The snapshot's `active` selection is per-client, so build it for each client peer.
				const payload = rpcJsonValueSchema.parse(
					createRuntimeBoxesSnapshot(
						database.runtimeBoxes,
						runtimeBoxRegistry,
						database.runtimeBoxPairings,
						peer.remoteIdentity.peerId,
					),
				);
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
		// Centralized retirement notification: every Session delete/retire path (Project retirement AND
		// direct product-rpc session.delete) funnels through here so live event subscriptions are always
		// torn down and retired-session invalidations are always published. Patching only one handler
		// would leave the other path leaking subscriptions.
		// Product events fan out to every product-client peer regardless of ingress: Desktop clients on
		// the Product RPC server and authenticated Mobile clients on the dedicated Mobile ingress. The
		// event hub still applies per-Session subscription authorization, so combining the peer sets only
		// widens the candidate set, never the visibility rules.
		const productEventPeers = (): readonly RpcPeer[] => [
			...(productRpcServer?.peers ?? []),
			...(mobileRpcServer?.peers ?? []),
		];
		const notifySessionsRetired = (sessionIds: readonly string[]): void => {
			eventRouter.retireSessions(sessionIds);
			// Session "Allow all" is session-scoped and server-owned: when a Session is retired its
			// policy and any pending approvals are reset so the grant can never leak into a new Session.
			for (const sessionId of sessionIds) {
				try {
					approvalService.resetForSession(sessionId);
				} catch (error) {
					const message = error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
					reportDiagnostic(`Approval reset for retired Session failed: ${message}`);
				}
			}
			try {
				publishRetiredChatSessions(productEventPeers(), sessionIds, reportDiagnostic);
			} catch (error) {
				const message = error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
				reportDiagnostic(
					`Session retirement publication failed; replay will recover it: ${message}`,
				);
			}
		};
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
		// Dedicated Mobile ingress auth — its own pairing repository, device identity path, and pre-auth
		// HTTP endpoints. It never shares the Runtime ingress bearer/local path: a Mobile client always
		// authenticates with a signed Ed25519 device challenge, so there is no fallback to Product or
		// Runtime credentials.
		const mobileIngressAuth = new MobileIngressAuth({
			pairings: database.mobilePairings,
			identity: agentServerIdentity,
			rpcIdentity: options.bootstrap.serverIdentity,
			actionJournalEpoch: database.runtimeBoxes.getActionJournalEpoch(),
			// A pairing QR is only publishable once the Mobile ingress port is live with a public URL AND
			// Remote Access is still enabled. disable() persists enabled=false before the async stop
			// clears readiness/URL, so the enabled flag is folded directly into the URL provider (and
			// re-checked via isRemoteAccessEnabled) to fail closed during that transition window.
			getMobilePublicUrl: () => {
				if (devTunnelService?.getStatus().enabled !== true) {
					return undefined;
				}
				const ingress = devTunnelService
					?.getIngressReadiness()
					.find((entry) => entry.kind === "mobile");
				return ingress?.ready ? ingress.publicUrl : undefined;
			},
			isRemoteAccessEnabled: () => devTunnelService?.getStatus().enabled === true,
		});
		const mobileGenerationFence = new MobileIngressGenerationFence(database.mobileDevices);
		// Revoking a Mobile device immediately tears down any live peer for that client id; the durable
		// revoke flag then blocks any future challenge/upgrade so a stale connection cannot be revived.
		const disconnectMobileDevice = (mobileClientId: string, reason: string): void => {
			for (const peer of mobileRpcServer?.peers ?? []) {
				if (peer.remoteIdentity.peerId === mobileClientId && !peer.isClosed) {
					peer.close(1008, reason);
				}
			}
		};
		const initializedProjectService = new ProjectApplicationService({
			projects: database.projects,
			runs: database.runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: runtimeBoxRegistry,
			onSessionsRetired: (sessionIds) => {
				notifySessionsRetired(sessionIds);
				void chatService?.drainPendingAgentSessionCleanups({ batchSize: 64 });
			},
			reportDiagnostic,
		});
		projectService = initializedProjectService;
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
			getActiveRuntimeBoxIdForClient: (clientId) =>
				database.runtimeBoxes.getActiveForClient(clientId).runtimeBoxId,
			onSessionsRetired: notifySessionsRetired,
			withProjectSessionCreation: (projectId, createSession, signal) =>
				initializedProjectService.withSessionCreation(projectId, createSession, signal),
			withProjectRunPreflight: (projectId, createRun, signal) =>
				initializedProjectService.withRunPreflight(projectId, createRun, signal),
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
				return {
					skills,
					mcpResources: [...serverMcpResources, ...runtimeBoxMcpResources],
				};
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
		const ready = Promise.all([
			chatService.drainPendingAgentSessionCleanups({ batchSize: 64 }),
			projectService.drainPendingDeletions(),
		]).then(() => undefined);
		const requireDevTunnelService = (): DevTunnelService => {
			if (devTunnelService === undefined) {
				throw new Error("Dev Tunnel service is not initialized.");
			}
			return devTunnelService;
		};

		const handlers = createProductRpcHandlers({
			chatService,
			approvalService,
			runtimeBoxRegistry,
			runtimeBoxes: database.runtimeBoxes,
			runtimeBoxPairings: database.runtimeBoxPairings,
			mobileIngressAuth,
			mobileDevices: database.mobileDevices,
			mobileAttention: database.mobileAttention,
			disconnectMobileDevice,
			projectService,
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
		// Physically separate Mobile ingress listener: its own loopback port and `/mobile` path, its own
		// authenticator (device-signature only), generation fence, and strict allowlist. It shares the
		// process handler map but never the Runtime/Product accepted-role set, so a Mobile peer can only
		// ever reach the Mobile allowlist surface.
		const createMobileRpcServer = (port?: number): RpcServer =>
			createRpcServer({
				identity: options.bootstrap.serverIdentity,
				hostname: "127.0.0.1",
				...(port === undefined ? {} : { port }),
				path: "/mobile",
				maxRequestBodyBytes: 32 * 1024,
				authenticate: mobileIngressAuth.authenticate,
				handleHttpRequest: mobileIngressAuth.handleHttpRequest,
				acceptedPeerRoles: ["mobile-client"],
				generationFence: mobileGenerationFence,
				handlers,
				methodAllowlist: agentsServerMobileMethodAllowlist,
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
				onTraffic(direction, bytes, peer) {
					if (peer.remoteIdentity.deviceKeyId !== undefined) {
						devTunnelService?.recordTraffic(direction, bytes);
					}
				},
				onClose(_info, peer) {
					eventRouter.releasePeer(peer);
				},
				onError(error) {
					console.error("agents-server Mobile ingress RPC error.", error);
				},
			});
		const persistedMobilePort = database.remoteAccess.get().mobileIngressPort;
		try {
			mobileRpcServer = createMobileRpcServer(persistedMobilePort);
		} catch (error) {
			if (persistedMobilePort === undefined || !isAddressInUseError(error)) {
				throw error;
			}
			mobileRpcServer = createMobileRpcServer();
			reportDiagnostic(
				`Mobile ingress port ${persistedMobilePort} is unavailable; rebound to ${mobileRpcServer.port}.`,
			);
		}
		if (persistedMobilePort === undefined) {
			database.remoteAccess.setMobileIngressPort(mobileRpcServer.port);
		} else if (persistedMobilePort !== mobileRpcServer.port) {
			database.remoteAccess.replaceMobileIngressPort(mobileRpcServer.port);
		}
		devTunnelService = new DevTunnelService({
			repository: database.remoteAccess,
			runtimeIngressPort: runtimeRpcServer.port,
			mobileIngressPort: mobileRpcServer.port,
			reportDiagnostic,
			...(portConflict === undefined ? {} : { portConflict }),
		});
		void devTunnelService.start().catch((error: unknown) => {
			reportDiagnostic(error instanceof Error ? error.message : "Dev Tunnel startup failed.");
		});
		const service = chatService;
		// The durable Mobile attention feed is fed by a transactional outbox: the approval and Run
		// repositories write a desensitized outbox row in the SAME transaction as the business write, so
		// a crash between the business commit and the feed projection can never permanently lose unread.
		// This independent, idempotent drainer projects committed outbox rows into the feed and enforces
		// retention. It drains once at startup (replaying anything a crash left behind), on each relevant
		// live event, and on a bounded periodic backstop. `onAppended` pushes the mobile-only
		// `attention.changed` hint only when a NEW row was projected; losing that hint never affects
		// durable recovery because the phone re-reads the feed on reconnect.
		const attentionDrainer = new MobileAttentionOutboxDrainer({
			attention: database.mobileAttention,
			outbox: database.mobileAttentionOutbox,
			onAppended: () => broadcastMobileAttentionChanged(productEventPeers()),
			reportDiagnostic,
		});
		attentionDrainerHandle = attentionDrainer.start();
		unsubscribe = service.subscribe((event) => {
			eventRouter.publish(productEventPeers(), event, service.getClientRequestId(event.runId));
			// A Run terminal transition committed its attention outbox row atomically; project it now.
			if (event.type === "run.status") {
				attentionDrainer.drain();
			}
		});
		// Fan approval state changes out to the multi-client event hub: Session-scoped events reach
		// that Session's subscribers, and a no-payload activity hint tells every client to refresh its
		// cross-session pending-approvals snapshot.
		unsubscribeApprovals = approvalService.subscribe((event) => {
			const peers = productEventPeers();
			if (event.type === "sessionApprovalPolicy.changed") {
				eventRouter.publishSessionApprovalPolicy(peers, {
					schemaVersion: 1,
					policy: event.policy,
				});
			} else {
				eventRouter.publishApproval(peers, {
					schemaVersion: 1,
					kind: event.type === "approval.created" ? "created" : "updated",
					request: event.request,
				});
				// A newly-created approval that entered "pending" committed its attention outbox row
				// atomically with the approval insert; project it now.
				if (event.type === "approval.created") {
					attentionDrainer.drain();
				}
			}
			broadcastApprovalActivityChanged(peers);
		});
		// Lazily-expired approvals are settled on read, but a periodic sweep bounds the worst-case time
		// a waiting Action lingers past its deadline when no client is actively polling.
		approvalSweepTimer = setInterval(() => {
			try {
				approvalService.sweepExpired();
			} catch (error) {
				const message = error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
				reportDiagnostic(`Approval expiry sweep failed: ${message}`);
			}
		}, 30_000);
		approvalSweepTimer.unref?.();

		let shutdownPromise: Promise<void> | undefined;
		return {
			productRpcServer,
			runtimeRpcServer,
			mobileRpcServer,
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
					unsubscribeApprovals?.();
					attentionDrainerHandle?.stop();
					if (approvalSweepTimer !== undefined) {
						clearInterval(approvalSweepTimer);
					}
					productRpcServer?.stop();
					runtimeRpcServer?.stop();
					mobileRpcServer?.stop();
					await devTunnelService?.shutdown();
					await authController?.dispose();
					await projectService?.shutdown();
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
		unsubscribeApprovals?.();
		attentionDrainerHandle?.stop();
		await devTunnelService?.shutdown();
		productRpcServer?.stop();
		runtimeRpcServer?.stop();
		mobileRpcServer?.stop();
		await authController?.dispose();
		await projectService?.shutdown();
		await chatService?.shutdown();
		await agentServerMcpLifecycle?.shutdown();
		database.close();
		throw error;
	}
}

function findAppOwnedPiSessionsDirectory(agentDataDirectory: string): string | undefined {
	const root = resolve(agentDataDirectory);
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		throw new Error("Agent data directory must be a regular directory.");
	}
	const sessionsDirectory = join(root, "sessions");
	if (!existsSync(sessionsDirectory)) {
		return undefined;
	}
	const sessionsMetadata = lstatSync(sessionsDirectory);
	if (!sessionsMetadata.isDirectory() || sessionsMetadata.isSymbolicLink()) {
		throw new Error("Pi Session storage must be a regular directory.");
	}
	return sessionsDirectory;
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
