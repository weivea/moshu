import { describe, expect, test } from "bun:test";
import {
	type ExecutorToolInvokeInput,
	type ExecutorToolProgressEvent,
	executorToolRpcTimeoutMs,
	productRpcMethods,
} from "@moshu/contracts";
import { openAppDatabase } from "@moshu/database";
import {
	type JsonValue,
	RpcConnectionClosedError,
	type RpcRequestOptions,
	RpcTimeoutError,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import {
	type RuntimeBoxActionAuthorizer,
	type RuntimeBoxGatewayPeer,
	RuntimeBoxInvocationError,
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

const projectRequestCases = [
	[
		"path validation",
		productRpcMethods.runtimeBoxProjectValidatePath,
		(registry: RuntimeBoxRegistry, signal?: AbortSignal) =>
			registry.validateProjectPath(
				"moshu-local-runtime-box",
				{ path: "/workspace/project" },
				signal,
			),
	],
	[
		"root AGENTS.md loading",
		productRpcMethods.runtimeBoxProjectReadRootAgents,
		(registry: RuntimeBoxRegistry, signal?: AbortSignal) =>
			registry.readProjectRootAgents(
				"moshu-local-runtime-box",
				{ projectPath: "/workspace/project" },
				signal,
			),
	],
] as const;

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

	test("projects an explicit upgrade-required compatibility state", () => {
		const gateway = new RuntimeBoxRegistry({
			descriptors: [
				{
					schemaVersion: 1,
					runtimeBoxId: "remote-old",
					kind: "remote",
					displayName: "Remote Old",
					runtimeBoxVersion: "0.0.0",
					platform: "linux",
					arch: "x64",
					capabilities: [],
				},
			],
		});
		gateway.markUpgradeRequired("remote-old");
		expect(gateway.listInfo()[0]).toMatchObject({
			state: "upgrade_required",
			compatibility: "upgrade_required",
			requiredProtocolMinVersion: 5,
			requiredProtocolMaxVersion: 5,
		});
	});

	test("hydrates persisted upgrade-required compatibility after server restart", () => {
		const gateway = new RuntimeBoxRegistry({
			descriptors: [
				{
					schemaVersion: 1,
					runtimeBoxId: "remote-old",
					kind: "remote",
					displayName: "Remote Old",
					runtimeBoxVersion: "0.0.0",
					platform: "linux",
					arch: "x64",
					capabilities: [],
				},
			],
			compatibilities: [
				{
					runtimeBoxId: "remote-old",
					state: "upgrade_required",
					generation: 7,
					protocolVersion: 2,
				},
			],
		});
		expect(gateway.listInfo()[0]).toMatchObject({
			state: "upgrade_required",
			compatibility: "upgrade_required",
		});
	});

	test("fences a connected peer when an authenticated newer generation requires upgrade", () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async () => readOutput());
		registerRuntimeBox(gateway, peer);
		gateway.markUpgradeRequired(peer.remoteIdentity.peerId);
		expect(peer.isClosed).toBe(true);
		expect(gateway.listInfo()[0]).toMatchObject({
			state: "upgrade_required",
			compatibility: "upgrade_required",
		});
	});

	test("rejects transport security that was not negotiated by the ingress", () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async () => readOutput());
		expect(() =>
			gateway.register(
				peer,
				{
					schemaVersion: 1,
					runtimeBoxId: peer.remoteIdentity.peerId,
					kind: "local",
					displayName: "Local Runtime Box",
					runtimeBoxVersion: "0.0.1",
					platform: "darwin",
					arch: "arm64",
					capabilities: [],
				},
				{ protocolVersion: 5, transportSecurity: "noise-xx" },
			),
		).toThrow("was not negotiated");
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
				status: "available",
				normalizedPath: "/workspace/project",
				displayName: "project",
				gitRootPath: "/workspace/project",
				gitBranch: "main",
				rootAgents: { status: "missing" },
				confirmationToken: "a".repeat(64),
			});
		});

		registerRuntimeBox(gateway, peer);

		await expect(
			gateway.validateProjectPath("moshu-local-runtime-box", {
				path: "/workspace/project",
			}),
		).resolves.toEqual({
			status: "available",
			normalizedPath: "/workspace/project",
			displayName: "project",
			gitRootPath: "/workspace/project",
			gitBranch: "main",
			rootAgents: { status: "missing" },
			confirmationToken: "a".repeat(64),
		});
	});

	test("loads root AGENTS.md through the owning ready Box and propagates cancellation", async () => {
		const gateway = new RuntimeBoxRegistry();
		const controller = new AbortController();
		const peer = new FakeRuntimeBoxPeer(async (method, payload, options) => {
			expect(method).toBe(productRpcMethods.runtimeBoxProjectReadRootAgents);
			expect(payload).toEqual({ projectPath: "/workspace/project" });
			expect(options).toMatchObject({ timeoutMs: 30_000, signal: controller.signal });
			return rpcJsonValueSchema.parse({ status: "loaded", body: "root guidance" });
		});
		registerRuntimeBox(gateway, peer);

		await expect(
			gateway.readProjectRootAgents(
				"moshu-local-runtime-box",
				{ projectPath: "/workspace/project" },
				controller.signal,
			),
		).resolves.toEqual({ status: "loaded", body: "root guidance" });
	});

	test.each(projectRequestCases)(
		"maps a disconnect or replacement during %s to Runtime Box unavailable",
		async (_name, expectedMethod, invoke) => {
			for (const transition of ["disconnect", "replacement"] as const) {
				const gateway = new RuntimeBoxRegistry();
				const requestStarted = deferred<void>();
				const peer = new FakeRuntimeBoxPeer(async (method, _payload, options) => {
					expect(method).toBe(expectedMethod);
					requestStarted.resolve(undefined);
					return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
				});
				registerRuntimeBox(gateway, peer);
				const pending = invoke(gateway);
				await requestStarted.promise;

				if (transition === "disconnect") {
					gateway.clear(peer);
				} else {
					registerRuntimeBox(gateway, new FakeRuntimeBoxPeer(async () => readOutput()));
				}

				await expect(pending).rejects.toBeInstanceOf(RuntimeBoxUnavailableError);
			}
		},
	);

	test.each(projectRequestCases)(
		"maps an RPC connection close during %s to Runtime Box unavailable",
		async (_name, expectedMethod, invoke) => {
			const gateway = new RuntimeBoxRegistry();
			const peer = new FakeRuntimeBoxPeer(async (method) => {
				expect(method).toBe(expectedMethod);
				throw new RpcConnectionClosedError(1006, "peer closed");
			});
			registerRuntimeBox(gateway, peer);

			await expect(invoke(gateway)).rejects.toBeInstanceOf(RuntimeBoxUnavailableError);
		},
	);

	test.each(projectRequestCases)(
		"preserves caller cancellation and deadlines during %s",
		async (_name, expectedMethod, invoke) => {
			const cancellationGateway = new RuntimeBoxRegistry();
			const requestStarted = deferred<void>();
			const cancellationPeer = new FakeRuntimeBoxPeer(async (method, _payload, options) => {
				expect(method).toBe(expectedMethod);
				requestStarted.resolve(undefined);
				return rejectWhenAborted(new Promise<JsonValue>(() => undefined), options?.signal);
			});
			registerRuntimeBox(cancellationGateway, cancellationPeer);
			const controller = new AbortController();
			const cancellation = invoke(cancellationGateway, controller.signal);
			await requestStarted.promise;
			const cancellationReason = new Error("caller cancelled");
			controller.abort(cancellationReason);
			expect(await cancellation.catch((error: unknown) => error)).toBe(cancellationReason);

			const deadlineGateway = new RuntimeBoxRegistry();
			const deadlinePeer = new FakeRuntimeBoxPeer(async (method) => {
				expect(method).toBe(expectedMethod);
				throw new RpcTimeoutError("project-request", 30_000);
			});
			registerRuntimeBox(deadlineGateway, deadlinePeer);
			await expect(invoke(deadlineGateway)).rejects.toBeInstanceOf(RpcTimeoutError);
		},
	);

	test("does not inspect Project paths before the Runtime Box is ready", async () => {
		const gateway = new RuntimeBoxRegistry();
		const peer = new FakeRuntimeBoxPeer(async () => {
			throw new Error("Path inspection must not dispatch before readiness.");
		});
		gateway.register(peer, {
			schemaVersion: 1,
			runtimeBoxId: peer.remoteIdentity.peerId,
			kind: "local",
			displayName: "Local Runtime Box",
			runtimeBoxVersion: "0.0.1",
			platform: "darwin",
			arch: "arm64",
			capabilities: [],
		});

		await expect(
			gateway.validateProjectPath(peer.remoteIdentity.peerId, {
				path: "/workspace/project",
			}),
		).rejects.toBeInstanceOf(RuntimeBoxUnavailableError);
	});

	test("authorizes, completes, and acknowledges a one-time Action grant", async () => {
		const calls: string[] = [];
		const executionContexts: unknown[] = [];
		const authorizer = {
			authorize(
				runtimeBoxId: string,
				input: ExecutorToolInvokeInput,
				targetIdentity,
				executionContext,
			) {
				calls.push("authorize");
				executionContexts.push(executionContext);
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
						...executionContext,
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
		const gateway = new RuntimeBoxRegistry({
			actionAuthorizer: authorizer,
			isDeviceKeyActive: () => true,
		});
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
		await gateway.invoke(invocation, {
			executionContext: { executionScope: "project-root", projectPathRevision: 9 },
		});
		const remotePeer = new FakeRuntimeBoxPeer(
			async (method) => {
				if (method === productRpcMethods.runtimeBoxInvocationsAck) {
					return rpcJsonValueSchema.parse({
						ackedInvocationIds: [invocation.invocationId],
					});
				}
				return readOutput();
			},
			"remote-box",
			"remote-key",
		);
		registerRuntimeBox(gateway, remotePeer, "remote");
		await gateway.invokeForRuntimeBox("remote-box", invocation);
		expect(executionContexts).toEqual([
			{ executionScope: "request-cwd" },
			{ executionScope: "project-root", projectPathRevision: 9 },
			{ executionScope: "runtime-box-workspace" },
		]);
		expect(calls).toEqual([
			"authorize",
			"complete",
			"ack",
			"receipt",
			"authorize",
			"complete",
			"ack",
			"receipt",
			"authorize",
			"complete",
			"ack",
			"receipt",
		]);
	});

	test("cancels an authorized Action without dispatch when the caller aborts", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const authorizer = {
			authorize(runtimeBoxId, input, targetIdentity, executionContext) {
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
						...executionContext,
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

	test("full-syncs before ready, applies read-own-write deltas, and marks offline cache stale", async () => {
		const database = openAppDatabase(":memory:");
		const epoch = crypto.randomUUID();
		const skillVersion = crypto.randomUUID();
		const mcpVersion = crypto.randomUUID();
		const skillHash = "a".repeat(64);
		const mcpHash = "b".repeat(64);
		let revision = 1;
		const peer = new FakeRuntimeBoxPeer(async (method) => {
			if (method === productRpcMethods.runtimeBoxInventoryGetSnapshot) {
				return rpcJsonValueSchema.parse({
					runtimeBoxId: "moshu-local-runtime-box",
					runtimeBoxGeneration: 1,
					inventoryEpoch: epoch,
					inventoryRevision: revision,
					generatedAt: new Date().toISOString(),
					capabilities: ["inventory.v1"],
					resources: [
						{
							resourceKind: "skill",
							stableResourceId: "release-helper",
							configRevision: 1,
							version: skillVersion,
							contentHash: skillHash,
							health: "ready",
						},
					],
				});
			}
			if (method === productRpcMethods.runtimeBoxMcpServersUpsert) {
				revision = 2;
				return rpcJsonValueSchema.parse({
					stableResourceId: "database-tools",
					configRevision: 1,
					version: mcpVersion,
					contentHash: mcpHash,
					inventoryEpoch: epoch,
					inventoryRevision: 2,
					descriptor: {
						resourceKind: "mcp",
						stableResourceId: "database-tools",
						version: mcpVersion,
						contentHash: mcpHash,
						health: "stopped",
						credentialConfigured: false,
						mcpTools: [],
					},
					deleted: false,
				});
			}
			if (method === productRpcMethods.runtimeBoxInventoryGetChanges) {
				return rpcJsonValueSchema.parse({
					inventoryEpoch: epoch,
					fromRevisionExclusive: 1,
					throughRevision: 2,
					oldestAvailableRevision: 1,
					changes: [
						{
							revision: 2,
							category: "mcp",
							operation: "upsert",
							stableResourceId: "database-tools",
							descriptor: {
								resourceKind: "mcp",
								stableResourceId: "database-tools",
								version: mcpVersion,
								contentHash: mcpHash,
								health: "stopped",
								credentialConfigured: false,
								mcpTools: [],
							},
						},
					],
				});
			}
			throw new Error(`Unexpected Runtime Box method: ${method}`);
		});
		const registry = new RuntimeBoxRegistry({
			inventoryRepository: database.runtimeBoxInventory,
			inventoryPollIntervalMs: 60_000,
		});
		try {
			registry.register(peer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			expect(() => registry.markReady(peer)).toThrow("inventory");
			await registry.synchronizeInventory(peer);
			registry.markReady(peer);
			expect(registry.getInventory("moshu-local-runtime-box")).toMatchObject({
				stale: false,
				inventoryRevision: 1,
				resources: [{ stableResourceId: "release-helper" }],
			});

			await registry.upsertMcpServer("moshu-local-runtime-box", {
				commandId: crypto.randomUUID(),
				stableResourceId: "database-tools",
				displayName: "Database Tools",
				enabled: false,
				transport: {
					type: "stdio",
					command: "/usr/bin/printf",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			expect(registry.getInventory("moshu-local-runtime-box")).toMatchObject({
				stale: false,
				inventoryRevision: 2,
				resources: [{ stableResourceId: "database-tools" }, { stableResourceId: "release-helper" }],
			});

			registry.clear(peer);
			expect(registry.getInventory("moshu-local-runtime-box")).toMatchObject({
				stale: true,
				resources: [{ stableResourceId: "database-tools" }, { stableResourceId: "release-helper" }],
			});
		} finally {
			await registry.shutdown();
			database.close();
		}
	});

	test("does not let a replaced peer commit a late inventory delta", async () => {
		const database = openAppDatabase(":memory:");
		const epoch = crypto.randomUUID();
		const version = crypto.randomUUID();
		const changesStarted = deferred<void>();
		const changesResponse = deferred<JsonValue>();
		const oldPeer = new FakeRuntimeBoxPeer(async (method) => {
			if (method === productRpcMethods.runtimeBoxInventoryGetSnapshot) {
				return rpcJsonValueSchema.parse({
					runtimeBoxId: "moshu-local-runtime-box",
					runtimeBoxGeneration: 1,
					inventoryEpoch: epoch,
					inventoryRevision: 1,
					generatedAt: new Date().toISOString(),
					capabilities: ["inventory.v1"],
					resources: [
						{
							resourceKind: "skill",
							stableResourceId: "stable-skill",
							configRevision: 1,
							version,
							contentHash: "a".repeat(64),
							health: "ready",
						},
					],
				});
			}
			if (method === productRpcMethods.runtimeBoxInventoryGetChanges) {
				changesStarted.resolve(undefined);
				return changesResponse.promise;
			}
			throw new Error(`Unexpected method ${method}`);
		});
		const registry = new RuntimeBoxRegistry({
			inventoryRepository: database.runtimeBoxInventory,
			inventoryPollIntervalMs: 60_000,
		});
		try {
			registry.register(oldPeer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			await registry.synchronizeInventory(oldPeer);
			registry.markReady(oldPeer);
			registry.handleInventoryChanged(oldPeer, {
				inventoryEpoch: epoch,
				inventoryRevision: 2,
				categories: ["mcp"],
			});
			await changesStarted.promise;

			const newPeer = new FakeRuntimeBoxPeer(async () => {
				throw new Error("Replacement should not be queried in this test.");
			});
			registry.register(newPeer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			changesResponse.resolve(
				rpcJsonValueSchema.parse({
					inventoryEpoch: epoch,
					fromRevisionExclusive: 1,
					throughRevision: 2,
					oldestAvailableRevision: 1,
					changes: [
						{
							revision: 2,
							category: "mcp",
							operation: "upsert",
							stableResourceId: "late-mcp",
							descriptor: {
								resourceKind: "mcp",
								stableResourceId: "late-mcp",
								version: crypto.randomUUID(),
								contentHash: "b".repeat(64),
								health: "ready",
								credentialConfigured: false,
								mcpTools: [],
							},
						},
					],
				}),
			);
			await Bun.sleep(10);
			expect(database.runtimeBoxInventory.list("moshu-local-runtime-box")).toMatchObject({
				inventoryRevision: 1,
				stale: true,
				resources: [{ stableResourceId: "stable-skill" }],
			});
		} finally {
			await registry.shutdown();
			database.close();
		}
	});

	test("falls back to a snapshot when delta pagination cannot make progress", async () => {
		const database = openAppDatabase(":memory:");
		const epoch = crypto.randomUUID();
		let snapshotCalls = 0;
		let changeCalls = 0;
		const peer = new FakeRuntimeBoxPeer(async (method) => {
			if (method === productRpcMethods.runtimeBoxInventoryGetSnapshot) {
				snapshotCalls += 1;
				return rpcJsonValueSchema.parse({
					runtimeBoxId: "moshu-local-runtime-box",
					runtimeBoxGeneration: 1,
					inventoryEpoch: epoch,
					inventoryRevision: snapshotCalls,
					generatedAt: new Date().toISOString(),
					capabilities: ["inventory.v1"],
					resources: [],
				});
			}
			if (method === productRpcMethods.runtimeBoxInventoryGetChanges) {
				changeCalls += 1;
				return rpcJsonValueSchema.parse({
					inventoryEpoch: epoch,
					fromRevisionExclusive: 1,
					throughRevision: 2,
					oldestAvailableRevision: 1,
					changes: [],
					nextCursor: "no-progress",
				});
			}
			throw new Error(`Unexpected method ${method}`);
		});
		const registry = new RuntimeBoxRegistry({
			inventoryRepository: database.runtimeBoxInventory,
			inventoryPollIntervalMs: 60_000,
		});
		try {
			registry.register(peer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			await registry.synchronizeInventory(peer);
			registry.markReady(peer);
			registry.handleInventoryChanged(peer, {
				inventoryEpoch: epoch,
				inventoryRevision: 2,
				categories: ["mcp"],
			});
			await Bun.sleep(150);
			expect(changeCalls).toBe(1);
			expect(snapshotCalls).toBe(2);
			expect(database.runtimeBoxInventory.list("moshu-local-runtime-box")).toMatchObject({
				inventoryRevision: 2,
				stale: false,
			});
		} finally {
			await registry.shutdown();
			database.close();
		}
	});

	test("polling recovers an inventory change when its hint is lost", async () => {
		const database = openAppDatabase(":memory:");
		const epoch = crypto.randomUUID();
		const version = crypto.randomUUID();
		let changeCalls = 0;
		const peer = new FakeRuntimeBoxPeer(async (method, payload) => {
			if (method === productRpcMethods.runtimeBoxInventoryGetSnapshot) {
				return rpcJsonValueSchema.parse({
					runtimeBoxId: "moshu-local-runtime-box",
					runtimeBoxGeneration: 1,
					inventoryEpoch: epoch,
					inventoryRevision: 1,
					generatedAt: new Date().toISOString(),
					capabilities: ["inventory.v1"],
					resources: [],
				});
			}
			if (method === productRpcMethods.runtimeBoxInventoryGetChanges) {
				changeCalls += 1;
				const fromRevisionExclusive = inventoryRevisionFromPayload(payload);
				return rpcJsonValueSchema.parse({
					inventoryEpoch: epoch,
					fromRevisionExclusive,
					throughRevision: 2,
					oldestAvailableRevision: 1,
					changes:
						fromRevisionExclusive === 1
							? [
									{
										revision: 2,
										category: "skill",
										operation: "upsert",
										stableResourceId: "hint-was-lost",
										descriptor: {
											resourceKind: "skill",
											stableResourceId: "hint-was-lost",
											configRevision: 1,
											version,
											contentHash: "a".repeat(64),
											health: "ready",
										},
									},
								]
							: [],
				});
			}
			throw new Error(`Unexpected method ${method}`);
		});
		const registry = new RuntimeBoxRegistry({
			inventoryRepository: database.runtimeBoxInventory,
			inventoryPollIntervalMs: 10,
			inventoryRandom: () => 0,
		});
		try {
			registry.register(peer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			await registry.synchronizeInventory(peer);
			registry.markReady(peer);
			await Bun.sleep(50);
			expect(changeCalls).toBeGreaterThan(0);
			expect(database.runtimeBoxInventory.list("moshu-local-runtime-box")).toMatchObject({
				inventoryRevision: 2,
				stale: false,
				resources: [{ stableResourceId: "hint-was-lost" }],
			});
		} finally {
			await registry.shutdown();
			database.close();
		}
	});

	test("falls back to a full snapshot after the delta log was compacted", async () => {
		const database = openAppDatabase(":memory:");
		const epoch = crypto.randomUUID();
		const version = crypto.randomUUID();
		let snapshotCalls = 0;
		const peer = new FakeRuntimeBoxPeer(async (method, payload) => {
			if (method === productRpcMethods.runtimeBoxInventoryGetSnapshot) {
				snapshotCalls += 1;
				return rpcJsonValueSchema.parse({
					runtimeBoxId: "moshu-local-runtime-box",
					runtimeBoxGeneration: 1,
					inventoryEpoch: epoch,
					inventoryRevision: snapshotCalls === 1 ? 1 : 4,
					generatedAt: new Date().toISOString(),
					capabilities: ["inventory.v1"],
					resources:
						snapshotCalls === 1
							? []
							: [
									{
										resourceKind: "skill",
										stableResourceId: "after-compaction",
										configRevision: 1,
										version,
										contentHash: "b".repeat(64),
										health: "ready",
									},
								],
				});
			}
			if (method === productRpcMethods.runtimeBoxInventoryGetChanges) {
				return rpcJsonValueSchema.parse({
					inventoryEpoch: epoch,
					fromRevisionExclusive: inventoryRevisionFromPayload(payload),
					throughRevision: 4,
					oldestAvailableRevision: 3,
					changes: [],
				});
			}
			throw new Error(`Unexpected method ${method}`);
		});
		const registry = new RuntimeBoxRegistry({
			inventoryRepository: database.runtimeBoxInventory,
			inventoryPollIntervalMs: 60_000,
		});
		try {
			registry.register(peer, database.runtimeBoxes.get("moshu-local-runtime-box"));
			await registry.synchronizeInventory(peer);
			registry.markReady(peer);
			registry.handleInventoryChanged(peer, {
				inventoryEpoch: epoch,
				inventoryRevision: 4,
				categories: ["skill"],
			});
			await Bun.sleep(150);
			expect(snapshotCalls).toBe(2);
			expect(database.runtimeBoxInventory.list("moshu-local-runtime-box")).toMatchObject({
				inventoryRevision: 4,
				stale: false,
				resources: [{ stableResourceId: "after-compaction" }],
			});
		} finally {
			await registry.shutdown();
			database.close();
		}
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

function inventoryRevisionFromPayload(payload: JsonValue): number {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		typeof payload.fromRevisionExclusive !== "number"
	) {
		throw new Error("Inventory changes request is missing fromRevisionExclusive.");
	}
	return payload.fromRevisionExclusive;
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
