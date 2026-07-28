import { describe, expect, test } from "bun:test";
import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	createRpcBearerAuthenticator,
	createRpcBearerHandshakeHeaders,
	InMemoryRpcGenerationFence,
	MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_TIMER_MS,
	MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES,
	MIN_RPC_FRAME_BYTES,
	negotiateRpcProtocol,
	PROCESS_RPC_SCHEMA_VERSION,
	type RpcEnvelope,
	RpcPeer,
	type RpcPeerIdentity,
	resolveRpcLimits,
	rpcEnvelopeSchema,
} from "../src";

const clientIdentity: RpcPeerIdentity = {
	role: "client",
	peerId: "desktop-primary",
	instanceId: "desktop-start-1",
	generation: 1,
};

const agentsIdentity: RpcPeerIdentity = {
	role: "agents",
	peerId: "agents-local",
	instanceId: "agents-start-1",
	generation: 1,
};

describe("process RPC protocol", () => {
	test("validates every strict versioned envelope", () => {
		const base = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
		};
		const envelopes: RpcEnvelope[] = [
			{ ...base, type: "hello", peer: clientIdentity },
			{
				...base,
				type: "hello-ack",
				connectionId: "connection-1",
				peer: agentsIdentity,
				acceptedPeer: clientIdentity,
			},
			{
				...base,
				type: "request",
				requestId: "request-1",
				traceId: "trace-1",
				method: "fixture.echo",
				deadlineAt: Date.now() + 1_000,
				payload: { value: "hello" },
			},
			{
				...base,
				type: "response",
				requestId: "request-1",
				traceId: "trace-1",
				result: { ok: true, payload: { value: "hello" } },
			},
			{
				...base,
				type: "event",
				eventId: "event-1",
				traceId: "trace-1",
				method: "fixture.changed",
				payload: ["one", "two"],
			},
			{
				...base,
				type: "cancel",
				requestId: "request-1",
				traceId: "trace-1",
				reason: "caller cancelled",
			},
			{
				...base,
				type: "heartbeat",
				heartbeatId: "heartbeat-1",
				kind: "ping",
				sentAt: Date.now(),
			},
			{
				...base,
				type: "protocol-error",
				code: "MALFORMED_FRAME",
				message: "Invalid JSON.",
				fatal: true,
			},
		];

		for (const envelope of envelopes) {
			expect(rpcEnvelopeSchema.parse(envelope)).toEqual(envelope);
		}
		expect(
			rpcEnvelopeSchema.safeParse({
				...envelopes[0],
				unexpected: true,
			}).success,
		).toBe(false);
	});

	test("negotiates only matching protocol majors", () => {
		expect(negotiateRpcProtocol({ major: 1, minor: 3 }, { major: 1, minor: 1 })).toEqual({
			major: 1,
			minor: 1,
		});
		expect(negotiateRpcProtocol({ major: 1, minor: 0 }, { major: 2, minor: 0 })).toBeNull();
	});

	test("bounds frame limits to the streaming receiver's supported range", () => {
		expect(resolveRpcLimits({ maxFrameBytes: MIN_RPC_FRAME_BYTES }).maxFrameBytes).toBe(
			MIN_RPC_FRAME_BYTES,
		);
		expect(resolveRpcLimits({ maxFrameBytes: MAX_RPC_FRAME_BYTES }).maxFrameBytes).toBe(
			MAX_RPC_FRAME_BYTES,
		);
		expect(() => resolveRpcLimits({ maxFrameBytes: MIN_RPC_FRAME_BYTES - 1 })).toThrow(
			`maxFrameBytes must be at least ${MIN_RPC_FRAME_BYTES}`,
		);
		expect(() => resolveRpcLimits({ maxFrameBytes: MAX_RPC_FRAME_BYTES + 1 })).toThrow(
			`maxFrameBytes cannot exceed ${MAX_RPC_FRAME_BYTES}`,
		);
		expect(() => resolveRpcLimits({ maxFrameBytes: 2 ** 31 })).toThrow(
			`maxFrameBytes cannot exceed ${MAX_RPC_FRAME_BYTES}`,
		);
	});

	test("bounds outbound buffering and every timer-backed limit", () => {
		expect(
			resolveRpcLimits({
				maxFrameBytes: MIN_RPC_FRAME_BYTES,
				maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
				requestTimeoutMs: MAX_RPC_TIMER_MS,
				maxRequestTimeoutMs: MAX_RPC_TIMER_MS,
				handshakeTimeoutMs: MAX_RPC_TIMER_MS,
				heartbeatIntervalMs: MAX_RPC_TIMER_MS - 1,
				heartbeatTimeoutMs: MAX_RPC_TIMER_MS,
			}),
		).toMatchObject({
			maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
			requestTimeoutMs: MAX_RPC_TIMER_MS,
			maxRequestTimeoutMs: MAX_RPC_TIMER_MS,
			handshakeTimeoutMs: MAX_RPC_TIMER_MS,
			heartbeatIntervalMs: MAX_RPC_TIMER_MS - 1,
			heartbeatTimeoutMs: MAX_RPC_TIMER_MS,
		});

		expect(() =>
			resolveRpcLimits({
				maxFrameBytes: MIN_RPC_FRAME_BYTES,
				maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES - 1,
			}),
		).toThrow("maxBufferedOutboundBytes cannot be less than maxFrameBytes");
		for (const name of [
			"requestTimeoutMs",
			"maxRequestTimeoutMs",
			"handshakeTimeoutMs",
			"heartbeatIntervalMs",
			"heartbeatTimeoutMs",
		] as const) {
			expect(() =>
				resolveRpcLimits({
					[name]: MAX_RPC_TIMER_MS + 1,
					...(name === "requestTimeoutMs" ? { maxRequestTimeoutMs: MAX_RPC_TIMER_MS + 1 } : {}),
				}),
			).toThrow(`${name} cannot exceed ${MAX_RPC_TIMER_MS}`);
		}
		expect(resolveRpcLimits({ maxConcurrentEvents: 1 }).maxConcurrentEvents).toBe(1);
		expect(() => resolveRpcLimits({ maxConcurrentEvents: 0 })).toThrow(
			"maxConcurrentEvents must be a positive safe integer",
		);
	});

	test("raises request deadlines only for explicitly configured methods", async () => {
		const sent: string[] = [];
		const peer = new RpcPeer({
			localIdentity: agentsIdentity,
			remoteIdentity: clientIdentity,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			resolvedLimits: resolveRpcLimits({
				heartbeatIntervalMs: 0,
				requestTimeoutMs: 1_000,
				maxRequestTimeoutMs: 5_000,
			}),
			requestTimeoutLimits: { "fixture.long": 10_000 },
			transport: {
				send: (text) => sent.push(text),
				close: () => undefined,
				terminate: () => undefined,
				isOpen: () => true,
			},
		});

		const pending = peer.request("fixture.long", {}, { timeoutMs: 6_000 });
		expect(() => peer.request("fixture.short", {}, { timeoutMs: 6_000 })).toThrow(
			"no greater than 5000",
		);
		const request = rpcEnvelopeSchema.parse(JSON.parse(sent[0] ?? ""));
		if (request.type !== "request") {
			throw new Error("Expected an RPC request envelope.");
		}
		peer.handleTextFrame(
			JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "response",
				requestId: request.requestId,
				traceId: request.traceId,
				result: { ok: true, payload: { accepted: true } },
			}),
		);
		await expect(pending).resolves.toEqual({ accepted: true });
		peer.close();
	});

	test("fits maximally escaped bounded handshake envelopes within the frame minimum", () => {
		const maximalIdentifier = "\0".repeat(256);
		const maximalIdentity: RpcPeerIdentity = {
			role: "executor",
			peerId: maximalIdentifier,
			instanceId: maximalIdentifier,
			generation: Number.MAX_SAFE_INTEGER,
		};
		const maximalProtocol = {
			major: Number.MAX_VALUE,
			minor: Number.MAX_VALUE,
		};
		const maximalAck: RpcEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: maximalProtocol,
			type: "hello-ack",
			connectionId: maximalIdentifier,
			peer: maximalIdentity,
			acceptedPeer: maximalIdentity,
		};
		const maximalProtocolError: RpcEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: maximalProtocol,
			type: "protocol-error",
			code: "AUTHENTICATION_FAILED",
			message: "\0".repeat(1_024),
			fatal: true,
			relatedId: maximalIdentifier,
		};

		expect(Buffer.byteLength(JSON.stringify(maximalAck))).toBeLessThanOrEqual(MIN_RPC_FRAME_BYTES);
		expect(Buffer.byteLength(JSON.stringify(maximalProtocolError))).toBeLessThanOrEqual(
			MIN_RPC_FRAME_BYTES,
		);
	});

	test("force-terminates the transport when graceful close throws", async () => {
		const closeError = new Error("graceful close failed");
		const observedErrors: unknown[] = [];
		let transportOpen = true;
		const peer = new RpcPeer({
			localIdentity: agentsIdentity,
			remoteIdentity: clientIdentity,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			resolvedLimits: resolveRpcLimits({ heartbeatIntervalMs: 0 }),
			transport: {
				send: () => undefined,
				close: () => {
					throw closeError;
				},
				terminate: () => {
					transportOpen = false;
				},
				isOpen: () => transportOpen,
			},
			onError: (error) => {
				observedErrors.push(error);
			},
		});

		peer.close(1000, "test close");
		expect(transportOpen).toBe(false);
		expect(peer.isClosed).toBe(true);
		expect(observedErrors).toEqual([closeError]);
		await expect(peer.closed).resolves.toEqual({ code: 1000, reason: "test close" });
	});

	test("terminates the exact peer when an outbound event send throws", () => {
		const sendError = new Error("socket dropped frame");
		let terminated = false;
		const peer = new RpcPeer({
			localIdentity: agentsIdentity,
			remoteIdentity: clientIdentity,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			resolvedLimits: resolveRpcLimits({ heartbeatIntervalMs: 0 }),
			transport: {
				send: () => {
					throw sendError;
				},
				close: () => undefined,
				terminate: () => {
					terminated = true;
				},
				isOpen: () => !terminated,
			},
		});

		expect(() => peer.emitEvent("chat.event", {})).toThrow(sendError);
		expect(terminated).toBe(true);
		expect(peer.isClosed).toBe(true);
	});

	test("force-terminates the physical transport after logical close", () => {
		let closeCalls = 0;
		let terminateCalls = 0;
		const peer = new RpcPeer({
			localIdentity: agentsIdentity,
			remoteIdentity: clientIdentity,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			resolvedLimits: resolveRpcLimits({ heartbeatIntervalMs: 0 }),
			transport: {
				send: () => undefined,
				close: () => {
					closeCalls += 1;
				},
				terminate: () => {
					terminateCalls += 1;
				},
				isOpen: () => true,
			},
		});

		peer.close();
		peer.terminate();
		expect(closeCalls).toBe(1);
		expect(terminateCalls).toBe(1);
	});

	test("retains generation high-water marks and rejects conflicts", () => {
		const fence = new InMemoryRpcGenerationFence();
		let fencedBy: RpcPeerIdentity | undefined;
		const first = fence.acquire(clientIdentity, (replacement) => {
			fencedBy = replacement;
		});
		expect(first.accepted).toBe(true);

		const replacement: RpcPeerIdentity = {
			...clientIdentity,
			instanceId: "desktop-start-2",
			generation: 2,
		};
		expect(fence.acquire(replacement, () => undefined).accepted).toBe(true);
		expect(fencedBy).toEqual(replacement);
		expect(
			fence.acquire(
				{ ...clientIdentity, instanceId: "other-start", generation: 2 },
				() => undefined,
			),
		).toMatchObject({ accepted: false, code: "GENERATION_CONFLICT" });
		expect(fence.acquire(clientIdentity, () => undefined)).toMatchObject({
			accepted: false,
			code: "STALE_GENERATION",
			currentGeneration: 2,
		});
	});

	test("binds bearer credentials to canonical peer identities", async () => {
		const credential = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		const authenticate = createRpcBearerAuthenticator([
			{
				credential,
				identity: clientIdentity,
			},
		]);

		await expect(
			Promise.resolve(
				authenticate(
					new Request("http://127.0.0.1/rpc", {
						headers: { authorization: `Bearer ${credential}` },
					}),
				),
			),
		).resolves.toEqual(clientIdentity);
		await expect(
			Promise.resolve(
				authenticate(
					new Request("http://127.0.0.1/rpc", {
						headers: {
							authorization: `Bearer ${crypto.randomUUID()}${crypto.randomUUID()}`,
						},
					}),
				),
			),
		).resolves.toBeNull();
	});

	test("accepts only canonical bounded base64url bootstrap credentials", async () => {
		const credential = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
			"base64url",
		);
		const authenticate = createRpcBearerAuthenticator([
			{
				credential,
				identity: clientIdentity,
			},
		]);
		const headers = await createRpcBearerHandshakeHeaders(credential)();
		await expect(
			Promise.resolve(
				authenticate(
					new Request("http://127.0.0.1/rpc", {
						headers,
					}),
				),
			),
		).resolves.toEqual(clientIdentity);
		const noncanonicalHeaders = new Headers(headers);
		noncanonicalHeaders.set("authorization", `${noncanonicalHeaders.get("authorization") ?? ""}=`);
		await expect(
			Promise.resolve(
				authenticate(
					new Request("http://127.0.0.1/rpc", {
						headers: noncanonicalHeaders,
					}),
				),
			),
		).resolves.toBeNull();

		const minimum = Buffer.alloc(MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES).toString("base64url");
		const maximum = Buffer.alloc(MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES).toString("base64url");
		expect(createRpcBearerHandshakeHeaders(minimum)).toBeFunction();
		expect(createRpcBearerHandshakeHeaders(maximum)).toBeFunction();
		for (const invalid of [
			Buffer.alloc(MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES - 1).toString("base64url"),
			Buffer.alloc(MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES + 1).toString("base64url"),
			`${minimum}=`,
			`${minimum} `,
			`${minimum}\n`,
			`${minimum.slice(0, -1)}B`,
			"é".repeat(32),
		]) {
			expect(() => createRpcBearerHandshakeHeaders(invalid)).toThrow();
		}

		expect(() =>
			createRpcBearerAuthenticator([
				{ credential, identity: clientIdentity },
				{ credential, identity: agentsIdentity },
			]),
		).toThrow("RPC bearer credentials must be unique");
	});

	test("rejects the Unicode-to-Latin-1 credential misbinding pair", () => {
		const unicodeCredential = "Ā".repeat(32);
		const latin1TransportView = Buffer.from(unicodeCredential, "utf8").toString("latin1");

		expect(latin1TransportView).not.toBe(unicodeCredential);
		expect(() => createRpcBearerHandshakeHeaders(unicodeCredential)).toThrow(
			"canonical unpadded base64url",
		);
		expect(() => createRpcBearerHandshakeHeaders(latin1TransportView)).toThrow(
			"canonical unpadded base64url",
		);
		expect(() =>
			createRpcBearerAuthenticator([
				{ credential: unicodeCredential, identity: clientIdentity },
				{ credential: latin1TransportView, identity: agentsIdentity },
			]),
		).toThrow("canonical unpadded base64url");
	});
});
