import { describe, expect, test } from "bun:test";
import {
	executorToolRpcTimeoutMs,
	productRpcMethods,
	type ExecutorToolInvokeInput,
	type ExecutorToolProgressEvent,
} from "@moshu/contracts";
import { type JsonValue, type RpcRequestOptions, rpcJsonValueSchema } from "@moshu/process-rpc";
import {
	ExecutorInvocationError,
	ExecutorReadiness,
	type ExecutorGatewayPeer,
	ExecutorUnavailableError,
} from "./executor-readiness";

const invocation: ExecutorToolInvokeInput = {
	schemaVersion: 1,
	invocationId: "f284b9da-8b66-4daa-9f02-c84d3bc21d87",
	runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
	toolCallId: "tool-call-1",
	cwd: "/tmp/workspace",
	call: {
		tool: "read",
		arguments: { path: "README.md" },
	},
};

const bashInvocation: ExecutorToolInvokeInput = {
	...invocation,
	call: {
		tool: "bash",
		arguments: { command: "printf progress" },
	},
};

function readOutput() {
	return rpcJsonValueSchema.parse({
		schemaVersion: 1,
		invocationId: invocation.invocationId,
		tool: "read",
		content: [{ type: "text", text: "contents" }],
	});
}

function bashOutput() {
	return rpcJsonValueSchema.parse({
		schemaVersion: 1,
		invocationId: invocation.invocationId,
		tool: "bash",
		content: [{ type: "text", text: "complete" }],
	});
}

function bashProgress(sequence: number): ExecutorToolProgressEvent {
	return {
		schemaVersion: 1,
		invocationId: invocation.invocationId,
		tool: "bash",
		sequence,
		content: [{ type: "text", text: `progress-${sequence}` }],
	};
}

describe("ExecutorReadiness invocation gateway", () => {
	test("fails closed before an executor registers", async () => {
		const gateway = new ExecutorReadiness();
		await expect(gateway.invoke(invocation)).rejects.toBeInstanceOf(ExecutorUnavailableError);
	});

	test("invokes only the registered peer with the bounded tool deadline", async () => {
		const gateway = new ExecutorReadiness();
		const peer = new FakeExecutorPeer(async (method, payload, options) => {
			expect(method).toBe(productRpcMethods.executorToolInvoke);
			expect(payload).toEqual(rpcJsonValueSchema.parse(invocation));
			expect(options?.timeoutMs).toBe(executorToolRpcTimeoutMs);
			expect(options?.signal?.aborted).toBe(false);
			return readOutput();
		});
		gateway.register(peer);

		const output = await gateway.invoke(invocation);
		expect(output.tool).toBe("read");
		expect(output.content[0]).toEqual({ type: "text", text: "contents" });
	});

	test("routes ordered progress only to the matching active peer and invocation", async () => {
		const gateway = new ExecutorReadiness();
		const response = deferred<JsonValue>();
		const requestStarted = deferred<void>();
		const peer = new FakeExecutorPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(response.promise, options?.signal);
		});
		gateway.register(peer);
		const progress: string[] = [];
		const result = gateway.invoke(bashInvocation, {
			onProgress: (event) => progress.push(event.content[0]?.text ?? ""),
		});
		await requestStarted.promise;

		expect(gateway.handleProgress(peer, bashProgress(0))).toBe(true);
		expect(
			gateway.handleProgress(new FakeExecutorPeer(async () => readOutput()), bashProgress(1)),
		).toBe(false);
		response.resolve(bashOutput());
		await result;
		expect(progress).toEqual(["progress-0"]);
		expect(gateway.handleProgress(peer, bashProgress(1))).toBe(false);
	});

	test("a progress sequence gap cancels the invocation", async () => {
		const gateway = new ExecutorReadiness();
		const requestStarted = deferred<void>();
		const peer = new FakeExecutorPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
		});
		gateway.register(peer);
		const result = gateway.invoke(bashInvocation);
		await requestStarted.promise;

		expect(gateway.handleProgress(peer, bashProgress(2))).toBe(false);
		await expect(result).rejects.toThrow("progress sequence mismatch");
	});

	test("disconnect and replacement abort in-flight work without routing stale progress", async () => {
		const gateway = new ExecutorReadiness();
		const requestStarted = deferred<void>();
		const oldPeer = new FakeExecutorPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
		});
		gateway.register(oldPeer);
		const result = gateway.invoke(invocation);
		await requestStarted.promise;

		const newPeer = new FakeExecutorPeer(async () => readOutput());
		gateway.register(newPeer);
		await expect(result).rejects.toThrow("connection was replaced");
		expect(gateway.handleProgress(oldPeer, bashProgress(0))).toBe(false);
		expect(gateway.isReady()).toBe(true);

		gateway.clear(oldPeer);
		expect(gateway.isReady()).toBe(true);
		gateway.clear(newPeer);
		expect(gateway.isReady()).toBe(false);
	});

	test("rejects duplicate invocation identities while the first request is active", async () => {
		const gateway = new ExecutorReadiness();
		const requestStarted = deferred<void>();
		const response = deferred<JsonValue>();
		const peer = new FakeExecutorPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(response.promise, options?.signal);
		});
		gateway.register(peer);
		const first = gateway.invoke(invocation);
		await requestStarted.promise;

		await expect(gateway.invoke(invocation)).rejects.toBeInstanceOf(ExecutorInvocationError);
		response.resolve(readOutput());
		await first;
	});
});

class FakeExecutorPeer implements ExecutorGatewayPeer {
	isClosed = false;
	readonly remoteIdentity = {
		role: "executor" as const,
		peerId: "moshu-local-executor",
		instanceId: crypto.randomUUID(),
		generation: 1,
	};

	constructor(
		private readonly handleRequest: (
			method: string,
			payload: JsonValue,
			options?: RpcRequestOptions,
		) => Promise<JsonValue>,
	) {}

	request(method: string, payload: JsonValue, options?: RpcRequestOptions): Promise<JsonValue> {
		return this.handleRequest(method, payload, options);
	}
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	if (!resolve) {
		throw new Error("Failed to initialize deferred");
	}
	return { promise, resolve };
}

function rejectWhenAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
		}
	});
}
