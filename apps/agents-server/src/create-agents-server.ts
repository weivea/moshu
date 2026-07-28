import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
	type AskChatRuntime,
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
	productRpcMethods,
} from "@moshu/contracts";
import { openAppDatabase, prepareCoordinatedDatabaseReset } from "@moshu/database";
import { createRpcBearerAuthenticator, createRpcServer, type RpcServer } from "@moshu/process-rpc";

import { ChatApplicationService } from "./chat-application-service";
import { ExecutorReadiness } from "./executor-readiness";
import { FileProviderRegistryStore } from "./file-provider-registry-store";
import { createProviderAuthDiagnosticLog } from "./provider-auth-diagnostic-log";
import {
	agentsServerMethodAllowlist,
	createProductRpcHandlers,
	ProductEventRouter,
} from "./product-rpc";

export interface AgentsServerInstance {
	readonly rpcServer: RpcServer;
	readonly executorReadiness: ExecutorReadiness;
	readonly ready: Promise<void>;
	shutdown(): Promise<void>;
}

export interface CreateAgentsServerOptions {
	bootstrap: AgentsServerBootstrapRecord;
	serverVersion: string;
	createRuntime?: (
		providers: ProviderRegistry,
		modelRuntime: ModelRuntime,
		executorGateway: ExecutorReadiness,
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

	const database = openAppDatabase(options.bootstrap.paths.productDatabase);
	let chatService: ChatApplicationService | undefined;
	let rpcServer: RpcServer | undefined;
	let unsubscribe: (() => void) | undefined;
	let authController: HeadlessAuthController | undefined;
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
		const executorReadiness = new ExecutorReadiness();
		const runtime =
			options.createRuntime?.(providers, modelRuntime, executorReadiness) ??
			new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				executorGateway: executorReadiness,
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
		chatService = new ChatApplicationService({
			sessions: database.sessions,
			runs: database.runs,
			providers,
			runtime,
			...(options.fetchProviderModels === undefined
				? {}
				: { fetchProviderModels: options.fetchProviderModels }),
			isRuntimeReady: () => executorReadiness.isReady(),
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

		rpcServer = createRpcServer({
			identity: options.bootstrap.serverIdentity,
			authenticate: createRpcBearerAuthenticator(options.bootstrap.peerBindings),
			acceptedPeerRoles: ["client", "executor"],
			handlers: createProductRpcHandlers({
				chatService,
				executorReadiness,
				eventRouter,
				serverVersion: options.serverVersion,
				authController,
			}),
			methodAllowlist: agentsServerMethodAllowlist,
			limits: {
				maxFrameBytes: productRpcMaxFrameBytes,
				maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
			},
			requestTimeoutLimits: {
				[productRpcMethods.executorToolInvoke]: executorToolRpcTimeoutMs,
			},
			onClose(_info, peer) {
				executorReadiness.clear(peer);
				eventRouter.releasePeer(peer);
			},
			onError(error) {
				console.error("agents-server RPC error.", error);
			},
		});
		const service = chatService;
		unsubscribe = service.subscribe((event) => {
			const server = rpcServer;
			if (server !== undefined) {
				eventRouter.publish(server.peers, event, service.getClientRequestId(event.runId));
			}
		});

		let shutdownPromise: Promise<void> | undefined;
		return {
			rpcServer,
			executorReadiness,
			ready,
			shutdown() {
				if (shutdownPromise !== undefined) {
					return shutdownPromise;
				}
				shutdownPromise = (async () => {
					unsubscribe?.();
					rpcServer?.stop();
					await authController?.dispose();
					await chatService?.shutdown();
					database.close();
				})();
				return shutdownPromise;
			},
		};
	} catch (error) {
		unsubscribe?.();
		rpcServer?.stop();
		await authController?.dispose();
		await chatService?.shutdown();
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
