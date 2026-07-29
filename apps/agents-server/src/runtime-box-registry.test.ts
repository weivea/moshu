import { describe, expect, test } from "bun:test";
import {
	executorToolRpcTimeoutMs,
	productRpcMethods,
	type ExecutorToolInvokeInput,
	type ExecutorToolProgressEvent,
} from "@moshu/contracts";
import { type JsonValue, type RpcRequestOptions, rpcJsonValueSchema } from "@moshu/process-rpc";
import {
	RuntimeBoxInvocationError,
	type RuntimeBoxActionAuthorizer,
	type RuntimeBoxGatewayPeer,
	RuntimeBoxRegistry,
	RuntimeBoxUnavailableError,
} from "./runtime-box-registry";

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

describe("RuntimeBoxRegistry routing and invocation gateway", () => {
	test("notifies snapshot observers when registration and connection state changes", () => {
		let changes = 0;
		const gateway = new RuntimeBoxRegistry({ onChange: () => changes++ });
		const peer = new FakeRuntimeBoxPeer(async () => readOutput());
		registerRuntimeBox(gateway, peer);
		gateway.setActiveRuntimeBoxId("moshu-local-runtime-box");
		gateway.clear(peer);
		expect(changes).toBe(4);
	});

	test("fails closed before a Runtime Box registers", async () => {
		const gateway = new RuntimeBoxRegistry();
		await expect(gateway.invoke(invocation)).rejects.toBeInstanceOf(RuntimeBoxUnavailableError);
	});

	test("does not dispatch while a registered Runtime Box is still syncing", async () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async () => readOutput());
		gateway.register(peer, {
			schemaVersion: 1,
			runtimeBoxId: peer.remoteIdentity.peerId,
			kind: "local",
			displayName: "Local Runtime Box",
			runtimeBoxVersion: "0.0.1",
			platform: "darwin",
			arch: "arm64",
			capabilities: ["tool.read"],
		});
		await expect(gateway.invoke(invocation)).rejects.toBeInstanceOf(RuntimeBoxUnavailableError);
		gateway.markReady(peer);
		await expect(gateway.invoke(invocation)).resolves.toMatchObject({ tool: "read" });
	});

	test("invokes the default local Runtime Box with the bounded tool deadline", async () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async (method, payload, options) => {
			expect(method).toBe(productRpcMethods.runtimeBoxToolInvoke);
			expect(payload).toEqual(rpcJsonValueSchema.parse(invocation));
			expect(options?.timeoutMs).toBe(executorToolRpcTimeoutMs);
			expect(options?.signal?.aborted).toBe(false);
			return readOutput();
		});
		registerRuntimeBox(gateway, peer);

		const output = await gateway.invoke(invocation);
		expect(output.tool).toBe("read");
		expect(output.content[0]).toEqual({ type: "text", text: "contents" });
	});

	test("routes ordered progress only to the matching active peer and invocation", async () => {
		const gateway = new RuntimeBoxRegistry();
		const response = deferred<JsonValue>();
		const requestStarted = deferred<void>();
		const peer = new FakeRuntimeBoxPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(response.promise, options?.signal);
		});
		registerRuntimeBox(gateway, peer);
		const progress: string[] = [];
		const result = gateway.invoke(bashInvocation, {
			onProgress: (event) => progress.push(event.content[0]?.text ?? ""),
		});
		await requestStarted.promise;

		expect(gateway.handleProgress(peer, bashProgress(0))).toBe(true);
		expect(
			gateway.handleProgress(new FakeRuntimeBoxPeer(async () => readOutput()), bashProgress(1)),
		).toBe(false);
		response.resolve(bashOutput());
		await result;
		expect(progress).toEqual(["progress-0"]);
		expect(gateway.handleProgress(peer, bashProgress(1))).toBe(false);
	});

	test("a progress sequence gap cancels the invocation", async () => {
		const gateway = new RuntimeBoxRegistry();
		const requestStarted = deferred<void>();
		const peer = new FakeRuntimeBoxPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
		});
		registerRuntimeBox(gateway, peer);
		const result = gateway.invoke(bashInvocation);
		await requestStarted.promise;

		expect(gateway.handleProgress(peer, bashProgress(2))).toBe(false);
		await expect(result).rejects.toThrow("progress sequence mismatch");
	});

	test("disconnect and replacement abort in-flight work without routing stale progress", async () => {
		const gateway = new RuntimeBoxRegistry();
		const requestStarted = deferred<void>();
		const oldPeer = new FakeRuntimeBoxPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
		});
		registerRuntimeBox(gateway, oldPeer);
		const result = gateway.invoke(invocation);
		await requestStarted.promise;

		const newPeer = new FakeRuntimeBoxPeer(async () => readOutput());
		registerRuntimeBox(gateway, newPeer);
		await expect(result).rejects.toThrow("connection was replaced");
		expect(gateway.handleProgress(oldPeer, bashProgress(0))).toBe(false);
		expect(gateway.isReady()).toBe(true);

		gateway.clear(oldPeer);
		expect(gateway.isReady()).toBe(true);
		gateway.clear(newPeer);
		expect(gateway.isReady()).toBe(false);
	});

	test("rejects duplicate invocation identities while the first request is active", async () => {
		const gateway = new RuntimeBoxRegistry();
		const requestStarted = deferred<void>();
		const response = deferred<JsonValue>();
		const peer = new FakeRuntimeBoxPeer((_method, _payload, options) => {
			requestStarted.resolve(undefined);
			return rejectWhenAborted(response.promise, options?.signal);
		});
		registerRuntimeBox(gateway, peer);
		const first = gateway.invoke(invocation);
		await requestStarted.promise;

		await expect(gateway.invoke(invocation)).rejects.toBeInstanceOf(RuntimeBoxInvocationError);
		response.resolve(readOutput());
		await first;
	});

	test("keeps multiple Runtime Boxes registered and routes by stable ID", async () => {
		const gateway = new RuntimeBoxRegistry({ isDeviceKeyActive: () => true });
		const localPeer = new FakeRuntimeBoxPeer(async () => readOutput());
		const remotePeer = new FakeRuntimeBoxPeer(
			async (_method, payload) => {
				expect(payload).toEqual(rpcJsonValueSchema.parse(invocation));
				return readOutput();
			},
			"remote-linux-box",
			"remote-key",
		);
		registerRuntimeBox(gateway, localPeer);
		registerRuntimeBox(gateway, remotePeer, "remote");

		expect(gateway.listInfo().map((entry) => entry.runtimeBox.runtimeBoxId)).toEqual([
			"moshu-local-runtime-box",
			"remote-linux-box",
		]);
		await gateway.invokeForRuntimeBox("remote-linux-box", invocation);
		expect(gateway.isReady("moshu-local-runtime-box")).toBe(true);
		expect(gateway.isReady("remote-linux-box")).toBe(true);
	});

	test("validates Project paths on the owning Runtime Box", async () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async (method, payload, options) => {
			expect(method).toBe(productRpcMethods.runtimeBoxProjectValidatePath);
			expect(payload).toEqual({ path: "/workspace/project" });
			expect(options?.timeoutMs).toBe(30_000);
			return rpcJsonValueSchema.parse({
				normalizedPath: "/workspace/project",
				displayName: "project",
				gitRootPath: "/workspace/project",
				gitBranch: "main",
			});
		});
		registerRuntimeBox(gateway, peer);

		await expect(
			gateway.validateProjectPath("moshu-local-runtime-box", {
				path: "/workspace/project",
			}),
		).resolves.toEqual({
			normalizedPath: "/workspace/project",
			displayName: "project",
			gitRootPath: "/workspace/project",
			gitBranch: "main",
		});
	});

	test("authorizes, completes, and acknowledges a one-time Action grant", async () => {
		const calls: string[] = [];
		const authorizer = {
			authorize(
				runtimeBoxId: string,
				input: ExecutorToolInvokeInput,
				targetIdentity,
				executionScope,
			) {
				calls.push("authorize");
				return {
					...input,
					authorization: {
						actionId: crypto.randomUUID(),
						grantId: crypto.randomUUID(),
						grantToken: Buffer.alloc(32, 4).toString("base64url"),
						parameterDigest: "a".repeat(64),
						originInstanceId: "agents-instance",
						originGeneration: 1,
						targetRuntimeBoxId: runtimeBoxId,
						targetInstanceId: targetIdentity.instanceId,
						targetGeneration: targetIdentity.generation,
						executionScope,
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				};
			},
			complete() {
				calls.push("complete");
			},
			fail() {
				calls.push("fail");
			},
			cancel() {
				calls.push("cancel");
			},
			cancelUndispatched() {
				calls.push("cancel-undispatched");
			},
			markOutcomeUnknown() {
				calls.push("unknown");
			},
			reconcile(_runtimeBoxId, items, acknowledgedInvocationIds) {
				return {
					ackedInvocationIds: items.map((item) => item.invocationId),
					confirmedAcknowledgementIds: [...acknowledgedInvocationIds],
				};
			},
			markServerAcked() {
				calls.push("ack");
			},
			markReceiptConfirmed() {
				calls.push("receipt");
			},
		} satisfies RuntimeBoxActionAuthorizer;
		const gateway = new RuntimeBoxRegistry({ actionAuthorizer: authorizer });
		const peer = new FakeRuntimeBoxPeer(async (method, payload) => {
			if (method === productRpcMethods.runtimeBoxInvocationsAck) {
				return rpcJsonValueSchema.parse({
					ackedInvocationIds: [invocation.invocationId],
				});
			}
			expect(method).toBe(productRpcMethods.runtimeBoxToolInvoke);
			expect(payload).toHaveProperty("authorization.grantId");
			return readOutput();
		});
		registerRuntimeBox(gateway, peer);

		await gateway.invoke(invocation);
		expect(calls).toEqual(["authorize", "complete", "ack", "receipt"]);
	});

	test("cancels an authorized Action without dispatch when the caller aborts", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const authorizer = {
			authorize(runtimeBoxId, input, targetIdentity, executionScope) {
				calls.push("authorize");
				controller.abort(new Error("caller stopped"));
				return {
					...input,
					authorization: {
						actionId: crypto.randomUUID(),
						grantId: crypto.randomUUID(),
						grantToken: Buffer.alloc(32, 9).toString("base64url"),
						parameterDigest: "d".repeat(64),
						originInstanceId: "agents",
						originGeneration: 1,
						targetRuntimeBoxId: runtimeBoxId,
						targetInstanceId: targetIdentity.instanceId,
						targetGeneration: targetIdentity.generation,
						executionScope,
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				};
			},
			complete() {},
			fail() {},
			cancel() {},
			cancelUndispatched() {
				calls.push("cancel-undispatched");
			},
			markOutcomeUnknown() {},
			reconcile() {
				return { ackedInvocationIds: [], confirmedAcknowledgementIds: [] };
			},
			markServerAcked() {},
			markReceiptConfirmed() {},
		} satisfies RuntimeBoxActionAuthorizer;
		let requests = 0;
		const gateway = new RuntimeBoxRegistry({ actionAuthorizer: authorizer });
		const peer = new FakeRuntimeBoxPeer(async () => {
			requests += 1;
			return readOutput();
		});
		registerRuntimeBox(gateway, peer);

		await expect(gateway.invoke(invocation, { signal: controller.signal })).rejects.toThrow(
			"caller stopped",
		);
		expect(requests).toBe(0);
		expect(calls).toEqual(["authorize", "cancel-undispatched"]);
	});

	test("rejects registration after the authenticated device key is revoked", () => {
		let keyActive = true;
		const registry = new RuntimeBoxRegistry({
			isDeviceKeyActive: (_runtimeBoxId, keyId) => keyActive && keyId === "remote-key",
		});
		const first = new FakeRuntimeBoxPeer(async () => readOutput(), "remote-box", "remote-key");
		registerRuntimeBox(registry, first, "remote");
		registry.clear(first);
		keyActive = false;
		const afterRevocation = new FakeRuntimeBoxPeer(
			async () => readOutput(),
			"remote-box",
			"remote-key",
		);
		expect(() => registerRuntimeBox(registry, afterRevocation, "remote")).toThrow(
			"device key is not active",
		);
	});
});

class FakeRuntimeBoxPeer implements RuntimeBoxGatewayPeer {
	isClosed = false;
	readonly remoteIdentity;

	constructor(
		private readonly handleRequest: (
			method: string,
			payload: JsonValue,
			options?: RpcRequestOptions,
		) => Promise<JsonValue>,
		peerId = "moshu-local-runtime-box",
		deviceKeyId?: string,
	) {
		this.remoteIdentity = {
			role: "runtime-box" as const,
			peerId,
			instanceId: crypto.randomUUID(),
			generation: 1,
			...(deviceKeyId === undefined ? {} : { deviceKeyId }),
		};
	}

	request(method: string, payload: JsonValue, options?: RpcRequestOptions): Promise<JsonValue> {
		return this.handleRequest(method, payload, options);
	}

	close(): void {
		this.isClosed = true;
	}
}

function registerRuntimeBox(
	registry: RuntimeBoxRegistry,
	peer: FakeRuntimeBoxPeer,
	kind: "local" | "remote" = "local",
): void {
	registry.register(peer, {
		schemaVersion: 1,
		runtimeBoxId: peer.remoteIdentity.peerId,
		kind,
		displayName: kind === "local" ? "Local Runtime Box" : "Remote Runtime Box",
		runtimeBoxVersion: "0.0.1",
		platform: kind === "local" ? "darwin" : "linux",
		arch: "arm64",
		capabilities: ["tool.read", "tool.bash"],
	});
	registry.markReady(peer);
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
