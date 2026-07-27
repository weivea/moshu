import { describe, expect, test } from "bun:test";

import { companionControlVersion, productRpcMethods } from "@moshu/contracts";
import {
	type JsonValue,
	type RpcCloseInfo,
	type RpcRequestOptions,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import type { BootstrapControlChannel } from "./bootstrap";
import {
	assertExpectedAgentsServerIdentity,
	type ExecutorReadyWriter,
	type ExecutorRpcPeer,
	type ExecutorSignalSource,
	runExecutorProcess,
} from "./index";

const expected = {
	role: "agents" as const,
	peerId: "moshu-local-agents",
	instanceId: "agents-2",
	generation: 2,
};

const bootstrapRecord = {
	channel: "moshu-companion-bootstrap",
	controlVersion: companionControlVersion,
	type: "START",
	role: "executor",
	nonce: "executor-generation-2",
	identity: {
		role: "executor",
		peerId: "moshu-local-executor",
		instanceId: "executor-2",
		generation: 2,
	},
	credential: Buffer.alloc(32, 8).toString("base64url"),
	agentsServer: {
		identity: expected,
		endpoint: {
			host: "127.0.0.1",
			port: 42_101,
			path: "/rpc",
		},
	},
} as const;

describe("executor agents-server identity", () => {
	test("accepts the exact authenticated generation", () => {
		expect(() => assertExpectedAgentsServerIdentity(expected, expected)).not.toThrow();
	});

	test.each([
		["instance", { ...expected, instanceId: "agents-1" }],
		["generation", { ...expected, generation: 1 }],
		["peer", { ...expected, peerId: "other-agents" }],
	])("rejects a stale or mismatched %s", (_name, actual) => {
		expect(() => assertExpectedAgentsServerIdentity(actual, expected)).toThrow(
			"did not match executor bootstrap",
		);
	});
});

describe("executor lifecycle", () => {
	test("cancels a stalled connect when the parent closes without emitting READY", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const connectStarted = deferred<void>();
		let connectSignal: AbortSignal | undefined;
		const readyRecords: string[] = [];
		const run = runExecutorProcess({
			...createBaseOptions(parent, signals, readyRecords),
			connectPeer: (options) => {
				connectSignal = options.signal;
				expect(options.expectedServerIdentity).toEqual(expected);
				connectStarted.resolve();
				return new Promise<ExecutorRpcPeer>(() => undefined);
			},
		});
		await connectStarted.promise;

		parent.close();
		await within(run);
		expect(connectSignal?.aborted).toBe(true);
		expect(readyRecords).toEqual([]);
		expect(parent.cancelCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test("cancels registration when the parent closes and force-terminates the peer", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const registrationStarted = deferred<void>();
		let registrationSignal: AbortSignal | undefined;
		const peer = new FakeExecutorPeer((_method, _payload, options) => {
			registrationSignal = options?.signal;
			registrationStarted.resolve();
			return new Promise<JsonValue>(() => undefined);
		});
		const readyRecords: string[] = [];
		const run = runExecutorProcess({
			...createBaseOptions(parent, signals, readyRecords),
			connectPeer: async () => peer,
		});
		await registrationStarted.promise;

		parent.close();
		await within(run);
		expect(registrationSignal?.aborted).toBe(true);
		expect(readyRecords).toEqual([]);
		expect(peer.closeCalls).toBe(1);
		expect(peer.terminateCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test("does not emit READY when parent EOF lands immediately after registration", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const peer = new FakeExecutorPeer((method) => {
			expect(method).toBe(productRpcMethods.executorRegister);
			parent.close();
			return rpcJsonValueSchema.parse({ schemaVersion: 1, accepted: true });
		});
		const readyRecords: string[] = [];

		await within(
			runExecutorProcess({
				...createBaseOptions(parent, signals, readyRecords),
				connectPeer: async () => peer,
			}),
		);
		expect(readyRecords).toEqual([]);
		expect(peer.terminateCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test.each(["SIGINT", "SIGTERM"] as const)(
		"cancels startup promptly on %s without emitting READY",
		async (signalName) => {
			const parent = createParentChannel();
			const signals = new FakeSignalSource();
			const connectStarted = deferred<void>();
			const readyRecords: string[] = [];
			const run = runExecutorProcess({
				...createBaseOptions(parent, signals, readyRecords),
				connectPeer: () => {
					connectStarted.resolve();
					return new Promise<ExecutorRpcPeer>(() => undefined);
				},
			});
			await connectStarted.promise;

			signals.emit(signalName);
			await within(run);
			expect(readyRecords).toEqual([]);
			expect(signals.listenerCount).toBe(0);
		},
	);

	test("checks lifecycle cancellation at the READY write boundary", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const readyRecords: string[] = [];
		const peer = new FakeExecutorPeer(() =>
			rpcJsonValueSchema.parse({ schemaVersion: 1, accepted: true }),
		);

		await within(
			runExecutorProcess({
				...createBaseOptions(parent, signals, readyRecords),
				connectPeer: async () => peer,
				readyWriter: {
					enqueue(record, signal) {
						signals.emit("SIGTERM");
						if (signal.aborted) {
							throw signal.reason;
						}
						readyRecords.push(record);
						return { drained: Promise.resolve() };
					},
				},
			}),
		);
		expect(readyRecords).toEqual([]);
		expect(peer.terminateCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test("force-terminates a remote peer that ignores graceful close", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const readyWritten = deferred<void>();
		const readyRecords: string[] = [];
		const peer = new FakeExecutorPeer(
			() => rpcJsonValueSchema.parse({ schemaVersion: 1, accepted: true }),
			true,
		);
		const run = runExecutorProcess({
			...createBaseOptions(parent, signals, readyRecords),
			connectPeer: async () => peer,
			readyWriter: {
				enqueue(record) {
					readyRecords.push(record);
					readyWritten.resolve();
					return { drained: Promise.resolve() };
				},
			},
		});
		await readyWritten.promise;

		signals.emit("SIGTERM");
		await within(run);
		expect(readyRecords).toHaveLength(1);
		expect(peer.closeCalls).toBe(1);
		expect(peer.terminateCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test.each(["parent EOF", "SIGTERM"] as const)(
		"treats READY as committed exactly once before delayed drain on %s",
		async (stopKind) => {
			const parent = createParentChannel();
			const signals = new FakeSignalSource();
			const readyEnqueued = deferred<void>();
			const drain = deferred<void>();
			const readyRecords: string[] = [];
			const peer = new FakeExecutorPeer(() =>
				rpcJsonValueSchema.parse({ schemaVersion: 1, accepted: true }),
			);
			const unhandled: unknown[] = [];
			const onUnhandled = (error: unknown): void => {
				unhandled.push(error);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				const run = runExecutorProcess({
					...createBaseOptions(parent, signals, readyRecords),
					connectPeer: async () => peer,
					readyWriter: {
						enqueue(record) {
							readyRecords.push(record);
							readyEnqueued.resolve();
							return { drained: drain.promise };
						},
					},
				});
				await readyEnqueued.promise;

				if (stopKind === "parent EOF") {
					parent.close();
				} else {
					signals.emit("SIGTERM");
				}
				await within(run);
				expect(readyRecords).toHaveLength(1);
				expect(peer.terminateCalls).toBe(1);
				drain.reject(new Error("late READY drain failure"));
				await Bun.sleep(10);
				expect(unhandled).toEqual([]);
				expect(signals.listenerCount).toBe(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		},
	);

	test("bounds cleanup when the parent monitor ignores cancellation", async () => {
		const parent = createParentChannel();
		const signals = new FakeSignalSource();
		const readyEnqueued = deferred<void>();
		const readyRecords: string[] = [];
		const peer = new FakeExecutorPeer(() =>
			rpcJsonValueSchema.parse({ schemaVersion: 1, accepted: true }),
		);
		const run = runExecutorProcess({
			...createBaseOptions(parent, signals, readyRecords),
			openControlChannel: async () => ({
				...parent.channel,
				cancelParentMonitor: () => new Promise<void>(() => undefined),
			}),
			connectPeer: async () => peer,
			cleanupTimeoutMs: 10,
			readyWriter: {
				enqueue(record) {
					readyRecords.push(record);
					readyEnqueued.resolve();
					return { drained: Promise.resolve() };
				},
			},
		});
		await readyEnqueued.promise;

		signals.emit("SIGTERM");
		await within(run, 100);
		expect(readyRecords).toHaveLength(1);
		expect(peer.terminateCalls).toBe(1);
		expect(signals.listenerCount).toBe(0);
	});

	test("observes cleanup promises without unhandled rejections", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const parent = createParentChannel();
			const signals = new FakeSignalSource();
			const connectStarted = deferred<void>();
			const run = runExecutorProcess({
				...createBaseOptions(parent, signals, []),
				connectPeer: () => {
					connectStarted.resolve();
					return new Promise<ExecutorRpcPeer>((_resolve, reject) => {
						setTimeout(() => reject(new Error("late connect failure")), 10);
					});
				},
			});
			await connectStarted.promise;
			parent.close();
			await within(run);
			await Bun.sleep(20);
			expect(unhandled).toEqual([]);
			expect(signals.listenerCount).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

class FakeExecutorPeer implements ExecutorRpcPeer {
	readonly remoteIdentity = expected;
	readonly #closed = deferred<RpcCloseInfo>();
	readonly closed = this.#closed.promise;
	closeCalls = 0;
	terminateCalls = 0;

	constructor(
		private readonly onRequest: (
			method: string,
			payload: JsonValue,
			options?: RpcRequestOptions,
		) => JsonValue | Promise<JsonValue>,
		private readonly ignoreClose = false,
	) {}

	async request(
		method: string,
		payload: JsonValue,
		options?: RpcRequestOptions,
	): Promise<JsonValue> {
		return this.onRequest(method, payload, options);
	}

	close(code = 1000, reason = "closed"): void {
		this.closeCalls += 1;
		if (!this.ignoreClose) {
			this.#closed.resolve({ code, reason });
		}
	}

	terminate(code = 1001, reason = "terminated"): void {
		this.terminateCalls += 1;
		this.#closed.resolve({ code, reason });
	}
}

class FakeSignalSource implements ExecutorSignalSource {
	readonly #listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>([
		["SIGINT", new Set()],
		["SIGTERM", new Set()],
	]);

	get listenerCount(): number {
		return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}

	add(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
		this.#listeners.get(signal)?.add(listener);
	}

	remove(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
		this.#listeners.get(signal)?.delete(listener);
	}

	emit(signal: "SIGINT" | "SIGTERM"): void {
		const listeners = [...(this.#listeners.get(signal) ?? [])];
		this.#listeners.get(signal)?.clear();
		for (const listener of listeners) {
			listener();
		}
	}
}

function createParentChannel(): {
	readonly channel: BootstrapControlChannel;
	readonly close: () => void;
	readonly fail: (error: unknown) => void;
	readonly cancelCalls: number;
} {
	const closed = deferred<void>();
	let settled = false;
	let cancelCalls = 0;
	const close = (): void => {
		if (!settled) {
			settled = true;
			closed.resolve();
		}
	};
	return {
		channel: {
			input: `${JSON.stringify(bootstrapRecord)}\n`,
			parentClosed: closed.promise,
			async cancelParentMonitor() {
				cancelCalls += 1;
				close();
			},
		},
		close,
		fail(error) {
			if (!settled) {
				settled = true;
				closed.reject(error);
			}
		},
		get cancelCalls() {
			return cancelCalls;
		},
	};
}

function createBaseOptions(
	parent: ReturnType<typeof createParentChannel>,
	signals: FakeSignalSource,
	readyRecords: string[],
): {
	readonly stdin: ReadableStream<Uint8Array>;
	readonly openControlChannel: (
		_stream: ReadableStream<Uint8Array>,
		_signal: AbortSignal,
	) => Promise<BootstrapControlChannel>;
	readonly signalSource: FakeSignalSource;
	readonly readyWriter: ExecutorReadyWriter;
} {
	return {
		stdin: new ReadableStream<Uint8Array>(),
		openControlChannel: async () => parent.channel,
		signalSource: signals,
		readyWriter: {
			enqueue(record) {
				readyRecords.push(record);
				return { drained: Promise.resolve() };
			},
		},
	};
}

function within<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Operation timed out.")), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	if (resolvePromise === undefined || rejectPromise === undefined) {
		throw new Error("Failed to create deferred promise.");
	}
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}
