import {
	companionBootstrapChannel,
	companionControlVersion,
	type ExecutorReadyRecord,
	executorRegisterInputSchema,
	executorRegisterOutputSchema,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcMethods,
} from "@moshu/contracts";
import {
	type ConnectRpcClientOptions,
	connectRpcClient,
	createRpcBearerHandshakeHeaders,
	isSameRpcPeerIdentity,
	type RpcPeer,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import {
	type BootstrapControlChannel,
	openBootstrapControlChannel,
	parseExecutorBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";

const PROCESS_VERSION = "0.0.1";

export type ExecutorRpcPeer = Pick<
	RpcPeer,
	"close" | "closed" | "remoteIdentity" | "request" | "terminate"
>;

export interface ExecutorSignalSource {
	add(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
	remove(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export interface ExecutorReadyPublication {
	readonly drained: Promise<void>;
}

export interface ExecutorReadyWriter {
	enqueue(record: string, signal: AbortSignal): ExecutorReadyPublication;
}

export interface RunExecutorProcessOptions {
	readonly stdin?: ReadableStream<Uint8Array>;
	readonly openControlChannel?: (
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	) => Promise<BootstrapControlChannel>;
	readonly connectPeer?: (options: ConnectRpcClientOptions) => Promise<ExecutorRpcPeer>;
	readonly readyWriter?: ExecutorReadyWriter;
	readonly signalSource?: ExecutorSignalSource;
	readonly cleanupTimeoutMs?: number;
}

const processSignalSource: ExecutorSignalSource = {
	add(signal, listener) {
		process.once(signal, listener);
	},
	remove(signal, listener) {
		process.off(signal, listener);
	},
};

export async function runExecutorProcess(options: RunExecutorProcessOptions = {}): Promise<void> {
	const lifecycle = new AbortController();
	const signalSource = options.signalSource ?? processSignalSource;
	const openControlChannel = options.openControlChannel ?? openBootstrapControlChannel;
	const connectPeer = options.connectPeer ?? connectRpcClient;
	const readyWriter = options.readyWriter ?? processReadyWriter;
	const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 250;
	if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
		throw new TypeError("cleanupTimeoutMs must be a positive safe integer.");
	}
	const stdin = options.stdin ?? Bun.stdin.stream();
	let controlChannel: BootstrapControlChannel | undefined;
	let parentObservation: Promise<void> = Promise.resolve();
	let lateConnectionObservation: Promise<void> = Promise.resolve();
	let peer: ExecutorRpcPeer | undefined;

	const stop = (reason: ExecutorLifecycleStop): void => {
		if (!lifecycle.signal.aborted) {
			lifecycle.abort(reason);
		}
	};
	const onSigint = (): void => stop(new ExecutorLifecycleStop("SIGINT", true));
	const onSigterm = (): void => stop(new ExecutorLifecycleStop("SIGTERM", true));
	signalSource.add("SIGINT", onSigint);
	signalSource.add("SIGTERM", onSigterm);

	try {
		controlChannel = await raceWithLifecycle(
			openControlChannel(stdin, lifecycle.signal),
			lifecycle.signal,
		);
		parentObservation = controlChannel.parentClosed.then(
			() => stop(new ExecutorLifecycleStop("Parent control channel closed.", true)),
			(error: unknown) =>
				stop(
					new ExecutorLifecycleStop("Parent control channel failed.", false, {
						cause: error,
					}),
				),
		);
		throwIfLifecycleStopped(lifecycle.signal);
		const bootstrap = parseExecutorBootstrapRecord(controlChannel.input);

		const connection = Promise.resolve(
			connectPeer({
				url: createAgentsServerUrl(bootstrap.agentsServer.endpoint),
				identity: bootstrap.identity,
				expectedServerIdentity: bootstrap.agentsServer.identity,
				signal: lifecycle.signal,
				getHandshakeHeaders: createRpcBearerHandshakeHeaders(bootstrap.credential),
				methodAllowlist: { agents: {} },
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
				onClose() {
					stop(new ExecutorLifecycleStop("Agents-server RPC connection closed.", false));
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
		assertExpectedAgentsServerIdentity(peer.remoteIdentity, bootstrap.agentsServer.identity);
		throwIfLifecycleStopped(lifecycle.signal);

		const registration = await raceWithLifecycle(
			peer.request(
				productRpcMethods.executorRegister,
				rpcJsonValueSchema.parse(
					executorRegisterInputSchema.parse({ schemaVersion: 1, status: "ready" }),
				),
				{ signal: lifecycle.signal },
			),
			lifecycle.signal,
		);
		executorRegisterOutputSchema.parse(registration);
		await Promise.resolve();
		throwIfLifecycleStopped(lifecycle.signal);

		const ready: ExecutorReadyRecord = {
			channel: companionBootstrapChannel,
			controlVersion: companionControlVersion,
			type: "READY",
			role: "executor",
			pid: process.pid,
			processVersion: PROCESS_VERSION,
			nonce: bootstrap.nonce,
			identity: bootstrap.identity,
			agentsServer: bootstrap.agentsServer,
		};
		throwIfLifecycleStopped(lifecycle.signal);
		const publication = readyWriter.enqueue(serializeReadyRecord(ready), lifecycle.signal);
		await raceWithLifecycle(publication.drained, lifecycle.signal);
		await waitForLifecycleStop(lifecycle.signal);
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
			lifecycle.abort(new ExecutorLifecycleStop("Executor startup cleanup.", true));
		}
		const cleanupDeadline = Date.now() + cleanupTimeoutMs;
		const cancelParentMonitor = Promise.resolve()
			.then(() => controlChannel?.cancelParentMonitor())
			.catch(() => undefined);
		await settlesWithin(cancelParentMonitor, cleanupDeadline);
		shutdownPeer(peer);
		await settlesWithin(parentObservation, cleanupDeadline);
		void lateConnectionObservation;
	}
}

export function assertExpectedAgentsServerIdentity(
	actual: Parameters<typeof isSameRpcPeerIdentity>[0],
	expected: Parameters<typeof isSameRpcPeerIdentity>[1],
): void {
	if (!isSameRpcPeerIdentity(actual, expected)) {
		throw new Error("Authenticated agents-server identity did not match executor bootstrap.");
	}
}

function createAgentsServerUrl(endpoint: {
	host: "127.0.0.1";
	port: number;
	path: "/rpc";
}): string {
	return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}

const processReadyWriter: ExecutorReadyWriter = {
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

function shutdownPeer(peer: ExecutorRpcPeer | undefined): void {
	if (peer === undefined) {
		return;
	}
	void peer.closed.then(
		() => undefined,
		() => undefined,
	);
	try {
		peer.close(1000, "Executor shutting down.");
	} finally {
		peer.terminate(1001, "Executor transport shutdown deadline reached.");
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

function getLifecycleStop(reason: unknown): ExecutorLifecycleStop | undefined {
	return reason instanceof ExecutorLifecycleStop ? reason : undefined;
}

class ExecutorLifecycleStop extends Error {
	constructor(
		message: string,
		readonly normal: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ExecutorLifecycleStop";
	}
}

if (import.meta.main) {
	await runExecutorProcess().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "executor bootstrap failed.");
		process.exit(1);
	});
}
