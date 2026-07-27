import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
	type AskChatRuntime,
	BunSqliteSaver,
	createAskChatRuntime,
	type ProviderRegistry,
} from "@moshu/agent-runtime";
import type { AgentsServerBootstrapRecord } from "@moshu/contracts";
import { productRpcMaxBufferedOutboundBytes, productRpcMaxFrameBytes } from "@moshu/contracts";
import { openAppDatabase, prepareCoordinatedDatabaseReset } from "@moshu/database";
import { createRpcBearerAuthenticator, createRpcServer, type RpcServer } from "@moshu/process-rpc";

import { ChatApplicationService } from "./chat-application-service";
import { ExecutorReadiness } from "./executor-readiness";
import { FileProviderRegistryStore } from "./file-provider-registry-store";
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
	createRuntime?: (providers: ProviderRegistry, checkpointer: BunSqliteSaver) => AskChatRuntime;
	testProviderConnection?: ConstructorParameters<
		typeof ChatApplicationService
	>[0]["testProviderConnection"];
	fetchProviderModels?: ConstructorParameters<
		typeof ChatApplicationService
	>[0]["fetchProviderModels"];
	checkpointDeletionAttemptTimeoutMs?: number;
	checkpointDeletionMaxInFlightAttempts?: number;
	checkpointDeletionStartupTimeoutMs?: number;
	checkpointDeletionStartupMaxAttempts?: number;
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
	for (const filename of Object.values(options.bootstrap.paths)) {
		mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
	}
	const reset = prepareCoordinatedDatabaseReset({
		productDatabase: options.bootstrap.paths.productDatabase,
		checkpointDatabase: options.bootstrap.paths.checkpointDatabase,
	});
	if (reset.reset) {
		const previousSchema =
			reset.previousProductVersion === undefined
				? "unavailable after interrupted reset"
				: String(reset.previousProductVersion);
		reportDiagnostic(
			`Reset local product and checkpoint stores (${reset.reason}, previous product schema ${previousSchema}).`,
		);
	}

	const database = openAppDatabase(options.bootstrap.paths.productDatabase);
	let checkpointSaver: BunSqliteSaver | undefined;
	let chatService: ChatApplicationService | undefined;
	let rpcServer: RpcServer | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		checkpointSaver = new BunSqliteSaver(options.bootstrap.paths.checkpointDatabase);
		const providers = new FileProviderRegistryStore(options.bootstrap.paths.providerConfig);
		const runtime =
			options.createRuntime?.(providers, checkpointSaver) ??
			createAskChatRuntime({ checkpointer: checkpointSaver });
		const executorReadiness = new ExecutorReadiness();
		const eventRouter = new ProductEventRouter();
		chatService = new ChatApplicationService({
			sessions: database.sessions,
			runs: database.runs,
			providers,
			runtime,
			isRuntimeReady: () => executorReadiness.isReady(),
			logger: {
				error(message, error) {
					console.error(message, error);
				},
				info(message) {
					reportDiagnostic(message);
				},
			},
			...(options.checkpointDeletionAttemptTimeoutMs === undefined
				? {}
				: {
						checkpointDeletionAttemptTimeoutMs: options.checkpointDeletionAttemptTimeoutMs,
					}),
			...(options.checkpointDeletionMaxInFlightAttempts === undefined
				? {}
				: {
						checkpointDeletionMaxInFlightAttempts: options.checkpointDeletionMaxInFlightAttempts,
					}),
			...(options.checkpointDeletionStartupTimeoutMs === undefined
				? {}
				: {
						checkpointDeletionStartupTimeoutMs: options.checkpointDeletionStartupTimeoutMs,
					}),
			...(options.checkpointDeletionStartupMaxAttempts === undefined
				? {}
				: {
						checkpointDeletionStartupMaxAttempts: options.checkpointDeletionStartupMaxAttempts,
					}),
			...(options.testProviderConnection === undefined
				? {}
				: { testProviderConnection: options.testProviderConnection }),
			...(options.fetchProviderModels === undefined
				? {}
				: { fetchProviderModels: options.fetchProviderModels }),
			...(options.shutdownTimeoutMs === undefined
				? {}
				: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
		});
		const ready = chatService.drainPendingCheckpointDeletions({ batchSize: 64 });

		rpcServer = createRpcServer({
			identity: options.bootstrap.serverIdentity,
			authenticate: createRpcBearerAuthenticator(options.bootstrap.peerBindings),
			acceptedPeerRoles: ["client", "executor"],
			handlers: createProductRpcHandlers({
				chatService,
				executorReadiness,
				eventRouter,
				serverVersion: options.serverVersion,
			}),
			methodAllowlist: agentsServerMethodAllowlist,
			limits: {
				maxFrameBytes: productRpcMaxFrameBytes,
				maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
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
					await chatService?.shutdown();
					checkpointSaver?.close();
					database.close();
				})();
				return shutdownPromise;
			},
		};
	} catch (error) {
		unsubscribe?.();
		rpcServer?.stop();
		await chatService?.shutdown();
		checkpointSaver?.close();
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
