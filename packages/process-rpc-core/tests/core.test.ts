import { describe, expect, test } from "bun:test";
import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	InMemoryRpcGenerationFence,
	type JsonValue,
	MIN_RPC_FRAME_BYTES,
	negotiateRpcProtocol,
	PROCESS_RPC_SCHEMA_VERSION,
	RpcConnectionClosedError,
	type RpcEndpointOptions,
	RpcPeer,
	type RpcPeerIdentity,
	type RpcSocketTransport,
	resolveRpcLimits,
	rpcEnvelopeSchema,
} from "../src";

const clientIdentity: RpcPeerIdentity = {
	role: "client",
	peerId: "core-client",
	instanceId: "core-client-1",
	generation: 1,
};

const serverIdentity: RpcPeerIdentity = {
	role: "agents",
	peerId: "core-agents",
	instanceId: "core-agents-1",
	generation: 1,
};

interface LoopbackPeers {
	readonly client: RpcPeer;
	readonly server: RpcPeer;
	dispose(): void;
}

/**
 * Wires two `RpcPeer`s together through a pair of pure-JavaScript {@link RpcSocketTransport}s. This
 * exercises the transport-neutral core without any Node/Bun socket, proving a future
 * Swift/Capacitor bridge only has to implement the same four-method transport contract.
 */
function createLoopbackPeers(
	client: RpcEndpointOptions,
	server: RpcEndpointOptions,
): LoopbackPeers {
	const limits = resolveRpcLimits();
	let clientPeer: RpcPeer;
	let serverPeer: RpcPeer;
	let linkOpen = true;

	const closeLink = (notify: () => void): void => {
		if (!linkOpen) {
			return;
		}
		linkOpen = false;
		queueMicrotask(notify);
	};

	const clientTransport: RpcSocketTransport = {
		send(text) {
			if (!linkOpen) {
				throw new Error("Loopback link is closed.");
			}
			queueMicrotask(() => {
				if (linkOpen) {
					serverPeer.handleTextFrame(text);
				}
			});
		},
		close(code, reason) {
			closeLink(() => serverPeer.handleTransportClose(code, reason));
		},
		terminate() {
			closeLink(() => serverPeer.handleTransportClose(1006, "Loopback terminated."));
		},
		isOpen() {
			return linkOpen;
		},
	};

	const serverTransport: RpcSocketTransport = {
		send(text) {
			if (!linkOpen) {
				throw new Error("Loopback link is closed.");
			}
			queueMicrotask(() => {
				if (linkOpen) {
					clientPeer.handleTextFrame(text);
				}
			});
		},
		close(code, reason) {
			closeLink(() => clientPeer.handleTransportClose(code, reason));
		},
		terminate() {
			closeLink(() => clientPeer.handleTransportClose(1006, "Loopback terminated."));
		},
		isOpen() {
			return linkOpen;
		},
	};

	clientPeer = new RpcPeer({
		localIdentity: clientIdentity,
		remoteIdentity: serverIdentity,
		protocol: CURRENT_PROCESS_RPC_PROTOCOL,
		resolvedLimits: limits,
		transport: clientTransport,
		...client,
	});
	serverPeer = new RpcPeer({
		localIdentity: serverIdentity,
		remoteIdentity: clientIdentity,
		protocol: CURRENT_PROCESS_RPC_PROTOCOL,
		resolvedLimits: limits,
		transport: serverTransport,
		...server,
	});

	return {
		client: clientPeer,
		server: serverPeer,
		dispose() {
			clientPeer.terminate(1001, "Test complete.");
			serverPeer.terminate(1001, "Test complete.");
		},
	};
}

describe("@moshu/process-rpc-core protocol primitives", () => {
	test("negotiates the lower shared minor and rejects a major mismatch", () => {
		expect(negotiateRpcProtocol({ major: 1, minor: 4 }, { major: 1, minor: 2 })).toEqual({
			major: 1,
			minor: 2,
		});
		expect(negotiateRpcProtocol({ major: 1, minor: 0 }, { major: 2, minor: 0 })).toBeNull();
	});

	test("resolves limits and rejects a frame budget below the floor", () => {
		expect(resolveRpcLimits().maxFrameBytes).toBeGreaterThanOrEqual(MIN_RPC_FRAME_BYTES);
		expect(() => resolveRpcLimits({ maxFrameBytes: 1 })).toThrow(RangeError);
	});

	test("validates a request envelope through the shared Zod schema", () => {
		const envelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			type: "request",
			requestId: "req-1",
			traceId: "trace-1",
			method: "echo",
			deadlineAt: 1,
			payload: { hello: "world" },
		};
		expect(rpcEnvelopeSchema.safeParse(envelope).success).toBe(true);
	});

	test("fences stale generations while accepting the current one", () => {
		const fence = new InMemoryRpcGenerationFence();
		const first = fence.acquire({ ...clientIdentity, generation: 2 }, () => undefined);
		expect(first.accepted).toBe(true);
		const stale = fence.acquire({ ...clientIdentity, generation: 1 }, () => undefined);
		expect(stale).toMatchObject({ accepted: false, code: "STALE_GENERATION" });
	});
});

describe("@moshu/process-rpc-core RpcSocketTransport loopback", () => {
	test("routes a request/response round-trip over a pure-JS transport", async () => {
		const received: JsonValue[] = [];
		const loopback = createLoopbackPeers(
			{},
			{
				handlers: {
					requests: {
						echo: (payload) => payload,
					},
					events: {
						ping: (payload) => {
							received.push(payload);
						},
					},
				},
				methodAllowlist: {
					client: { requests: ["echo"], events: ["ping"] },
				},
			},
		);

		try {
			const response = await loopback.client.request("echo", { value: 42 });
			expect(response).toEqual({ value: 42 });

			loopback.client.emitEvent("ping", { tick: 1 });
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(received).toEqual([{ tick: 1 }]);
		} finally {
			loopback.dispose();
		}
	});

	test("propagates a transport close to pending requests and the closed promise", async () => {
		const loopback = createLoopbackPeers(
			{},
			{
				handlers: {
					requests: {
						never: () => new Promise<JsonValue>(() => undefined),
					},
				},
				methodAllowlist: {
					client: { requests: ["never"] },
				},
			},
		);

		const pending = loopback.client.request("never", {});
		// Drive the transport-close callback directly: this is exactly what an
		// RpcSocketTransport invokes when the underlying socket drops, so it deterministically
		// exercises how a peer tears down pending work without depending on send-frame ordering.
		loopback.client.handleTransportClose(1000, "Server closing.");
		await expect(pending).rejects.toBeInstanceOf(RpcConnectionClosedError);
		await expect(loopback.client.closed).resolves.toMatchObject({ code: 1000 });
		loopback.dispose();
	});
});
