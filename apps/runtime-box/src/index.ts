import { isAbsolute, join } from "node:path";
import {
	agentsRuntimeBoxRequestMethods,
	companionBootstrapChannel,
	companionControlVersion,
	type RuntimeBoxReadyRecord,
	executorToolNames,
	executorToolRpcTimeoutMs,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcEvents,
	productRpcMethods,
	currentRuntimeBoxProtocolVersion,
	runtimeBoxRegisterInputSchema,
	runtimeBoxRegisterOutputSchema,
	moshuReleaseVersion,
} from "@moshu/contracts";
import {
	type ConnectRpcClientOptions,
	connectRpcClient,
	createRpcBearerHandshakeHeaders,
	isSameRpcPeerIdentity,
	type RpcPeer,
	type RpcRequestHandler,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import {
	createExecutorToolRequestHandler,
	createInvocationAcknowledgementHandler,
} from "./tool-handler";
import {
	reconcileInvocationJournal,
	RuntimeBoxInvocationJournal,
	watchInvocationReconciliation,
} from "./invocation-journal";
import { validateProjectPathRequestHandler } from "./project-path";
import { createRuntimeResourceRequestHandlers } from "./resource-handler";
import { RuntimeResourceStore } from "./runtime-resource-store";
import { createExecutorToolRuntime, type ExecutorToolRuntime } from "./tools/index";
import { runRuntimeBoxCli } from "./cli";
import { extractEmbeddedRuntimeBoxAssets, type EmbeddedRuntimeBoxAssets } from "./embedded-assets";
import { configurePhotonWasmPath } from "./tools/photon";
import { McpLifecycleManager } from "./mcp-lifecycle-manager";
import { createMcpToolRequestHandler } from "./mcp-tool-handler";

import {
	type BootstrapControlChannel,
	openBootstrapControlChannel,
	parseRuntimeBoxBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";

const PROCESS_VERSION = moshuReleaseVersion;

export type RuntimeBoxRpcPeer = Pick<
	RpcPeer,
	"close" | "closed" | "remoteIdentity" | "request" | "terminate"
> &
	Partial<Pick<RpcPeer, "emitEvent" | "isClosed">>;

export interface RuntimeBoxSignalSource {
	add(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
	remove(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export interface RuntimeBoxReadyPublication {
	readonly drained: Promise<void>;
}

export interface RuntimeBoxReadyWriter {
	enqueue(record: string, signal: AbortSignal): RuntimeBoxReadyPublication;
}

export interface RunRuntimeBoxProcessOptions {
	readonly stdin?: ReadableStream<Uint8Array>;
	readonly openControlChannel?: (
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	) => Promise<BootstrapControlChannel>;
	readonly connectPeer?: (options: ConnectRpcClientOptions) => Promise<RuntimeBoxRpcPeer>;
	readonly readyWriter?: RuntimeBoxReadyWriter;
	readonly signalSource?: RuntimeBoxSignalSource;
	readonly cleanupTimeoutMs?: number;
	readonly toolRuntime?: ExecutorToolRuntime;
	readonly invocationJournal?: RuntimeBoxInvocationJournal;
	readonly resourceStore?: RuntimeResourceStore | null;
}

const processSignalSource: RuntimeBoxSignalSource = {
	add(signal, listener) {
		process.once(signal, listener);
	},
	remove(signal, listener) {
		process.off(signal, listener);
	},
};

export async function runRuntimeBoxProcess(
	options: RunRuntimeBoxProcessOptions = {},
): Promise<void> {
	const lifecycle = new AbortController();
	const signalSource = options.signalSource ?? processSignalSource;
	const openControlChannel = options.openControlChannel ?? openBootstrapControlChannel;
	const connectPeer = options.connectPeer ?? connectRpcClient;
	const readyWriter = options.readyWriter ?? processReadyWriter;
	const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 250;
	const activeExecutions = new Set<Promise<unknown>>();
	if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
		throw new TypeError("cleanupTimeoutMs must be a positive safe integer.");
	}
	const stdin = options.stdin ?? Bun.stdin.stream();
	let controlChannel: BootstrapControlChannel | undefined;
	let parentObservation: Promise<void> = Promise.resolve();
	let lateConnectionObservation: Promise<void> = Promise.resolve();
	let reconciliationObservation: Promise<void> = Promise.resolve();
	let peer: RuntimeBoxRpcPeer | undefined;
	let resourceStore: RuntimeResourceStore | undefined;
	let mcpLifecycle: McpLifecycleManager | undefined;
	let ownsResourceStore = false;
	let recordTransportClose: (reason: RuntimeBoxLifecycleStop) => void = () => undefined;
	const transportClosed = new Promise<RuntimeBoxLifecycleStop>((resolve) => {
		recordTransportClose = resolve;
	});
	const stop = (reason: RuntimeBoxLifecycleStop): void => {
		if (!lifecycle.signal.aborted) {
			lifecycle.abort(reason);
		}
	};
	const onSigint = (): void => stop(new RuntimeBoxLifecycleStop("SIGINT", true));
	const onSigterm = (): void => stop(new RuntimeBoxLifecycleStop("SIGTERM", true));
	signalSource.add("SIGINT", onSigint);
	signalSource.add("SIGTERM", onSigterm);

	try {
		controlChannel = await raceWithLifecycle(
			openControlChannel(stdin, lifecycle.signal),
			lifecycle.signal,
		);
		parentObservation = controlChannel.parentClosed.then(
			() => stop(new RuntimeBoxLifecycleStop("Parent control channel closed.", true)),
			(error: unknown) =>
				stop(
					new RuntimeBoxLifecycleStop("Parent control channel failed.", false, {
						cause: error,
					}),
				),
		);
		throwIfLifecycleStopped(lifecycle.signal);
		const bootstrap = parseRuntimeBoxBootstrapRecord(controlChannel.input);
		if (!isAbsolute(bootstrap.dataDirectory)) {
			throw new Error("Runtime Box data directory must be absolute.");
		}
		const invocationJournal =
			options.invocationJournal ??
			new RuntimeBoxInvocationJournal(
				join(bootstrap.dataDirectory, "journal", bootstrap.actionJournalEpoch),
			);
		resourceStore =
			options.resourceStore === null
				? undefined
				: (options.resourceStore ??
					new RuntimeResourceStore(join(bootstrap.dataDirectory, "resources")));
		ownsResourceStore = options.resourceStore === undefined;
		if (resourceStore !== undefined) {
			mcpLifecycle = new McpLifecycleManager(resourceStore);
			await mcpLifecycle.start(lifecycle.signal);
		}
		const resourceCapabilities = [
			"inventory.v1",
			"mcp.config.v1",
			"mcp.tools.v1",
			"skills.store.v1",
		] as const;
		const runtimeCapabilities = [
			...executorToolNames.map((tool) => `tool.${tool}`),
			"projects.validate-path",
			...resourceCapabilities,
		];
		const resourceHandlers =
			resourceStore === undefined
				? {}
				: createRuntimeResourceRequestHandlers(resourceStore, {
						runtimeBoxId: bootstrap.identity.peerId,
						generation: bootstrap.identity.generation,
						capabilities: runtimeCapabilities,
					});
		const toolRequestHandler =
			options.toolRuntime === undefined
				? undefined
				: createExecutorToolRequestHandler(options.toolRuntime, {
						journal: invocationJournal,
						activeExecutions,
						lifecycleSignal: lifecycle.signal,
					});
		const mcpToolHandler =
			mcpLifecycle === undefined
				? undefined
				: createMcpToolRequestHandler(mcpLifecycle, invocationJournal, {
						activeExecutions,
						lifecycleSignal: lifecycle.signal,
					});
		const runtimeRequestHandlers: Record<string, RpcRequestHandler> = {
			[productRpcMethods.runtimeBoxProjectValidatePath]: validateProjectPathRequestHandler,
			[productRpcMethods.runtimeBoxInvocationsAck]:
				createInvocationAcknowledgementHandler(invocationJournal),
			...resourceHandlers,
		};
		if (toolRequestHandler !== undefined) {
			runtimeRequestHandlers[productRpcMethods.runtimeBoxToolInvoke] = toolRequestHandler;
		}
		if (mcpToolHandler !== undefined) {
			runtimeRequestHandlers[productRpcMethods.runtimeBoxMcpToolInvoke] = mcpToolHandler;
		}

		const connection = Promise.resolve(
			connectPeer({
				url: createAgentsServerUrl(bootstrap.agentsServer.endpoint),
				identity: bootstrap.identity,
				expectedServerIdentity: bootstrap.agentsServer.identity,
				signal: lifecycle.signal,
				getHandshakeHeaders: createRpcBearerHandshakeHeaders(bootstrap.credential),
				methodAllowlist: { agents: { requests: agentsRuntimeBoxRequestMethods } },
				handlers: { requests: runtimeRequestHandlers },
				...(toolRequestHandler === undefined && mcpToolHandler === undefined
					? {}
					: {
							requestTimeoutLimits: {
								[productRpcMethods.runtimeBoxToolInvoke]: executorToolRpcTimeoutMs,
								[productRpcMethods.runtimeBoxMcpToolInvoke]: executorToolRpcTimeoutMs,
							},
						}),
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
				onClose() {
					recordTransportClose(
						new RuntimeBoxLifecycleStop("Agents-server RPC connection closed.", false),
					);
				},
			}),
		);
		lateConnectionObservation = connection.then(
			(candidate) => {
				if (lifecycle.signal.aborted && candidate !== peer) {
					shutdownPeer(candidate);
				}
			},
			() => undefined,
		);
		peer = await raceWithLifecycle(connection, lifecycle.signal);
		resourceStore?.setInventoryChangedListener((hint) => {
			if (peer?.isClosed === true || peer?.emitEvent === undefined) {
				return;
			}
			try {
				peer.emitEvent(productRpcEvents.runtimeBoxInventoryChanged, rpcJsonValueSchema.parse(hint));
			} catch (error) {
				console.error(
					error instanceof Error
						? `Runtime Box inventory hint failed: ${error.message}`
						: "Runtime Box inventory hint failed.",
				);
			}
		});
		assertExpectedAgentsServerIdentity(peer.remoteIdentity, bootstrap.agentsServer.identity);
		throwIfLifecycleStopped(lifecycle.signal);

		const registration = await raceWithLifecycle(
			peer.request(
				productRpcMethods.runtimeBoxRegister,
				rpcJsonValueSchema.parse(
					runtimeBoxRegisterInputSchema.parse({
						schemaVersion: 1,
						status: "ready",
						protocolVersion: currentRuntimeBoxProtocolVersion,
						transportSecurity: "relay-tls",
						runtimeBox: {
							schemaVersion: 1,
							runtimeBoxId: bootstrap.identity.peerId,
							kind: "local",
							displayName: "Local Runtime Box",
							runtimeBoxVersion: PROCESS_VERSION,
							platform: process.platform,
							arch: process.arch,
							capabilities: runtimeCapabilities,
						},
					}),
				),
				{ signal: lifecycle.signal },
			),
			lifecycle.signal,
		);
		const registrationOutput = runtimeBoxRegisterOutputSchema.parse(registration);
		if (registrationOutput.runtimeBoxId !== bootstrap.identity.peerId) {
			throw new Error("Agents-server registered a different Runtime Box identity.");
		}
		await reconcileInvocationJournal(peer, invocationJournal, lifecycle.signal);
		await peer.request(productRpcMethods.runtimeBoxReady, {}, { signal: lifecycle.signal });
		reconciliationObservation = watchInvocationReconciliation(
			peer,
			invocationJournal,
			lifecycle.signal,
			{
				onError: (error) =>
					console.error(
						error instanceof Error ? error.message : "Runtime Box Action reconciliation failed.",
					),
			},
		);
		await Promise.resolve();
		throwIfLifecycleStopped(lifecycle.signal);

		const ready: RuntimeBoxReadyRecord = {
			channel: companionBootstrapChannel,
			controlVersion: companionControlVersion,
			type: "READY",
			role: "runtime-box",
			pid: process.pid,
			processVersion: PROCESS_VERSION,
			nonce: bootstrap.nonce,
			identity: bootstrap.identity,
			agentsServer: bootstrap.agentsServer,
		};
		throwIfLifecycleStopped(lifecycle.signal);
		const publication = readyWriter.enqueue(serializeReadyRecord(ready), lifecycle.signal);
		await raceWithLifecycle(publication.drained, lifecycle.signal);
		const terminal = await Promise.race([
			waitForLifecycleStop(lifecycle.signal).then(() => ({ kind: "lifecycle" }) as const),
			transportClosed.then((reason) => ({ kind: "transport", reason }) as const),
		]);
		if (terminal.kind === "transport") {
			await waitForActiveExecutions(activeExecutions);
			throw terminal.reason;
		}
		throwIfLifecycleStopped(lifecycle.signal);
	} catch (error) {
		const stopReason = getLifecycleStop(lifecycle.signal.reason);
		if (stopReason?.normal === true) {
			return;
		}
		throw stopReason ?? error;
	} finally {
		signalSource.remove("SIGINT", onSigint);
		signalSource.remove("SIGTERM", onSigterm);
		if (!lifecycle.signal.aborted) {
			lifecycle.abort(new RuntimeBoxLifecycleStop("Runtime Box startup cleanup.", true));
		}
		const cleanupDeadline = Date.now() + cleanupTimeoutMs;
		const cancelParentMonitor = Promise.resolve()
			.then(() => controlChannel?.cancelParentMonitor())
			.catch(() => undefined);
		await settlesWithin(cancelParentMonitor, cleanupDeadline);
		shutdownPeer(peer);
		await waitForActiveExecutions(activeExecutions, 5_000);
		await mcpLifecycle?.shutdown();
		resourceStore?.setInventoryChangedListener(undefined);
		if (ownsResourceStore) {
			resourceStore?.close();
		}
		await settlesWithin(parentObservation, cleanupDeadline);
		await settlesWithin(reconciliationObservation, cleanupDeadline);
		void lateConnectionObservation;
	}

	async function waitForActiveExecutions(
		executions: Set<Promise<unknown>>,
		timeoutMs?: number,
	): Promise<void> {
		if (executions.size === 0) {
			return;
		}
		const settled = Promise.allSettled([...executions]).then(() => undefined);
		if (timeoutMs === undefined) {
			await settled;
			return;
		}
		await Promise.race([
			settled,
			Bun.sleep(timeoutMs).then(() => {
				throw new Error("Runtime Box active invocation cleanup timed out.");
			}),
		]);
	}
}

export function assertExpectedAgentsServerIdentity(
	actual: Parameters<typeof isSameRpcPeerIdentity>[0],
	expected: Parameters<typeof isSameRpcPeerIdentity>[1],
): void {
	if (!isSameRpcPeerIdentity(actual, expected)) {
		throw new Error("Authenticated agents-server identity did not match Runtime Box bootstrap.");
	}
}

function createAgentsServerUrl(endpoint: {
	host: "127.0.0.1";
	port: number;
	path: "/runtime";
}): string {
	return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}

const processReadyWriter: RuntimeBoxReadyWriter = {
	enqueue(record, signal) {
		throwIfLifecycleStopped(signal);
		let resolveDrain: (() => void) | undefined;
		let rejectDrain: ((error: unknown) => void) | undefined;
		const drained = new Promise<void>((resolve, reject) => {
			resolveDrain = resolve;
			rejectDrain = reject;
		});
		try {
			process.stdout.write(record, (error) => {
				if (error === null || error === undefined) {
					resolveDrain?.();
				} else {
					rejectDrain?.(error);
				}
			});
		} catch (error) {
			resolveDrain?.();
			throw error;
		}
		return { drained };
	},
};

function shutdownPeer(peer: RuntimeBoxRpcPeer | undefined): void {
	if (peer === undefined) {
		return;
	}
	void peer.closed.then(
		() => undefined,
		() => undefined,
	);
	try {
		peer.close(1000, "RuntimeBox shutting down.");
	} finally {
		peer.terminate(1001, "RuntimeBox transport shutdown deadline reached.");
	}
}

function raceWithLifecycle<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(getLifecycleStop(signal.reason) ?? signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(getLifecycleStop(signal.reason) ?? signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(operation).then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
		}
	});
}

function waitForLifecycleStop(signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function settlesWithin(operation: PromiseLike<unknown>, deadline: number): Promise<void> {
	const timeoutMs = Math.max(0, Math.min(2_147_483_647, deadline - Date.now()));
	if (timeoutMs === 0) {
		void Promise.resolve(operation).catch(() => undefined);
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		void Promise.resolve(operation).then(finish, finish);
	});
}

function throwIfLifecycleStopped(signal: AbortSignal): void {
	if (signal.aborted) {
		throw getLifecycleStop(signal.reason) ?? signal.reason;
	}
}

function getLifecycleStop(reason: unknown): RuntimeBoxLifecycleStop | undefined {
	return reason instanceof RuntimeBoxLifecycleStop ? reason : undefined;
}

class RuntimeBoxLifecycleStop extends Error {
	constructor(
		message: string,
		readonly normal: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "RuntimeBoxLifecycleStop";
	}
}

export async function runRuntimeBoxMain(
	args: readonly string[],
	embeddedAssets?: EmbeddedRuntimeBoxAssets,
): Promise<number> {
	let toolRuntime: Promise<ExecutorToolRuntime> | undefined;
	const createToolRuntime = (): Promise<ExecutorToolRuntime> => {
		if (toolRuntime !== undefined) {
			return toolRuntime;
		}
		toolRuntime = (async () => {
			if (embeddedAssets === undefined) {
				return createExecutorToolRuntime();
			}
			const extracted = await extractEmbeddedRuntimeBoxAssets(embeddedAssets);
			configurePhotonWasmPath(extracted.photonWasm);
			return createExecutorToolRuntime({ rg: extracted.rg, fd: extracted.fd });
		})();
		return toolRuntime;
	};
	if (args.length === 0) {
		await runRuntimeBoxProcess({ toolRuntime: await createToolRuntime() });
		return 0;
	}
	return runRuntimeBoxCli(args, console.log, { createToolRuntime });
}

if (import.meta.main) {
	const exitCode = await runRuntimeBoxMain(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "Runtime Box command failed.");
		return 1;
	});
	process.exit(exitCode);
}
