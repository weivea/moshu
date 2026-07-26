import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer as createTcpServer, Socket, type Server as TcpServer } from "node:net";

import {
	type ConnectRpcClientOptions,
	CURRENT_PROCESS_RPC_PROTOCOL,
	connectRpcClient,
	createRpcBearerHandshakeHeaders,
	createRpcServer,
	type JsonValue,
	MIN_RPC_FRAME_BYTES,
	PROCESS_RPC_SCHEMA_VERSION,
	RpcCancelledError,
	RpcConnectionClosedError,
	type RpcEnvelope,
	RpcFrameTooLargeError,
	type RpcHandshakeHeadersProvider,
	type RpcPeer,
	type RpcPeerIdentity,
	RpcRemoteError,
	type RpcRequestEnvelope,
	RpcRequestLimitError,
	type RpcServer,
	type RpcServerBaseOptions,
	type RpcServerOptions,
	RpcTimeoutError,
	rpcEnvelopeSchema,
	rpcHelloAckEnvelopeSchema,
	rpcProtocolErrorEnvelopeSchema,
} from "../src";
import {
	connectStreamingWebSocketClient,
	RPC_WEBSOCKET_MAX_BUFFERED_CHUNKS,
	RPC_WEBSOCKET_MAX_FRAGMENTS,
} from "../src/streaming-websocket-client";

const agentsIdentity: RpcPeerIdentity = {
	role: "agents",
	peerId: "agents-local",
	instanceId: "agents-start-1",
	generation: 1,
};

const defaultLimits = {
	heartbeatIntervalMs: 0,
	requestTimeoutMs: 1_000,
	maxRequestTimeoutMs: 5_000,
	handshakeTimeoutMs: 1_000,
} as const;

const servers: RpcServer[] = [];
const peers: RpcPeer[] = [];
const sockets: WebSocket[] = [];
const credentialsByServer = new WeakMap<RpcServer, Map<string, RpcPeerIdentity>>();

afterEach(async () => {
	for (const peer of peers.splice(0)) {
		peer.close();
	}
	for (const socket of sockets.splice(0)) {
		if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
			socket.terminate();
		}
	}
	for (const server of servers.splice(0)) {
		server.stop();
	}
});

describe("Bun WebSocket process RPC", () => {
	test("requires authentication unless insecure mode is explicit", () => {
		expect(() =>
			createRpcServer({
				identity: agentsIdentity,
				limits: defaultLimits,
			} as RpcServerOptions),
		).toThrow("require exactly one of authenticate or dangerouslyAllowUnauthenticated");

		const explicitlyInsecure = createRpcServer({
			identity: agentsIdentity,
			limits: defaultLimits,
			dangerouslyAllowUnauthenticated: true,
		});
		expect(explicitlyInsecure.url).toStartWith("ws://127.0.0.1:");
		explicitlyInsecure.stop();
	});

	test("rejects missing credentials and authenticated identity spoofing before fencing", async () => {
		const server = startServer();
		const canonicalIdentity: RpcPeerIdentity = {
			role: "client",
			peerId: "protected-client",
			instanceId: "protected-start-1",
			generation: 1,
		};

		await expect(
			connectRpcClient({
				url: server.url,
				identity: {
					role: "executor",
					peerId: "spoofed-executor",
					instanceId: "spoofed-start",
					generation: 999,
				},
				limits: defaultLimits,
			}),
		).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

		const credential = authorizeIdentity(server, canonicalIdentity);
		await expect(
			connectRpcClient({
				url: server.url,
				identity: {
					...canonicalIdentity,
					role: "executor",
				},
				limits: defaultLimits,
				getHandshakeHeaders: credential.getHandshakeHeaders,
			}),
		).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
		await expect(
			connectRpcClient({
				url: server.url,
				identity: {
					...canonicalIdentity,
					instanceId: "poison-start",
					generation: 999,
				},
				limits: defaultLimits,
				getHandshakeHeaders: credential.getHandshakeHeaders,
			}),
		).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });

		const legitimate = await connectRpcClient({
			url: server.url,
			identity: canonicalIdentity,
			limits: defaultLimits,
			getHandshakeHeaders: credential.getHandshakeHeaders,
		});
		peers.push(legitimate);
		expect(legitimate.remoteIdentity).toEqual(agentsIdentity);
		expect(server.findPeer("client", canonicalIdentity.peerId)?.remoteIdentity).toEqual(
			canonicalIdentity,
		);
	});

	test("cleans upgrade listeners and releases handshake credential references", async () => {
		const server = startServer();
		const listenerIdentity = createClientIdentity("listener-cleanup");
		const listenerCredential = authorizeIdentity(server, listenerIdentity);
		const connection = await connectStreamingWebSocketClient({
			url: server.url,
			headers: { authorization: listenerCredential.authorization },
			handshakeTimeoutMs: defaultLimits.handshakeTimeoutMs,
			maxPayloadBytes: 1_024,
		});
		const rawSocket: unknown = Reflect.get(connection.socket, "_socket");
		if (!(rawSocket instanceof Socket)) {
			throw new TypeError("Expected the streaming WebSocket to expose its raw socket.");
		}

		expect(rawSocket.listenerCount("connect")).toBe(0);
		expect(rawSocket.listenerCount("secureConnect")).toBe(0);
		expect(rawSocket.listenerCount("timeout")).toBe(0);
		const handshakeListenerNames = new Set([
			"onConnect",
			"onTimeout",
			"onData",
			"onError",
			"onEnd",
			"onClose",
		]);
		for (const event of ["data", "error", "end", "close"] as const) {
			expect(
				rawSocket.listeners(event).some((listener) => handshakeListenerNames.has(listener.name)),
			).toBe(false);
		}
		connection.socket.terminate();

		const weakIdentity = createClientIdentity("credential-release");
		const { peer, providerReference, headersReference } = await connectWithWeakHandshakeReferences(
			server,
			weakIdentity,
		);
		peers.push(peer);
		await expectWeakReferencesCollected([providerReference, headersReference]);
		expect(peer.isClosed).toBe(false);
	});

	test("validates the exact server identity before activating event handlers", async () => {
		const identity = createClientIdentity("exact-server-identity");
		const staleServerIdentity: RpcPeerIdentity = {
			...agentsIdentity,
			instanceId: "stale-agents-start",
			generation: agentsIdentity.generation - 1,
		};
		const event = JSON.stringify({
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: CURRENT_PROCESS_RPC_PROTOCOL,
			type: "event",
			eventId: "stale-pre-resolution-event",
			traceId: "stale-pre-resolution-event",
			method: "fixture.pre-resolution",
			payload: { stale: true },
		});
		const rawServer = await startRawHandshakeBurstServer(identity, staleServerIdentity, [
			createServerWebSocketFrame(Buffer.from(event), 0x1, true),
		]);
		let handlerInvocations = 0;
		try {
			await expect(
				connectRpcClient({
					url: rawServer.url,
					identity,
					expectedServerIdentity: agentsIdentity,
					limits: defaultLimits,
					handlers: {
						events: {
							"fixture.pre-resolution": () => {
								handlerInvocations += 1;
							},
						},
					},
					methodAllowlist: {
						agents: { events: ["fixture.pre-resolution"] },
					},
				}),
			).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
			await within(rawServer.closed);
			await Bun.sleep(10);
			expect(handlerInvocations).toBe(0);
			expect(rawServer.isClean()).toBe(true);
		} finally {
			await rawServer.stop();
		}
	});

	test("contains receiver errors racing a failed hello acknowledgement and releases listeners", async () => {
		const uncaught: unknown[] = [];
		const unhandled: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		const initialUncaughtListeners = process.listenerCount("uncaughtException");
		const initialUnhandledListeners = process.listenerCount("unhandledRejection");
		process.on("uncaughtException", onUncaught);
		process.on("unhandledRejection", onUnhandled);
		try {
			const attacks = [
				createServerWebSocketFrame(Buffer.alloc(MIN_RPC_FRAME_BYTES + 1, 0x61), 0x1, true),
				createServerWebSocketFrame(Buffer.from([0xc3, 0x28]), 0x1, true),
			];
			for (const [index, attack] of attacks.entries()) {
				const identity = createClientIdentity(`failed-ack-race-${index}`);
				const rawServer = await startRawHandshakeBurstServer(
					identity,
					{
						...agentsIdentity,
						instanceId: `unexpected-agents-${index}`,
						generation: agentsIdentity.generation + index + 1,
					},
					[attack],
					true,
				);
				try {
					await expect(
						connectRpcClient({
							url: rawServer.url,
							identity,
							expectedServerIdentity: agentsIdentity,
							limits: {
								...defaultLimits,
								maxFrameBytes: MIN_RPC_FRAME_BYTES,
							},
						}),
					).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
					await within(rawServer.closed);
					expect(rawServer.isClean()).toBe(true);
				} finally {
					await rawServer.stop();
				}
			}
			await Bun.sleep(20);
			expect(uncaught).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
			process.off("unhandledRejection", onUnhandled);
		}
		expect(process.listenerCount("uncaughtException")).toBe(initialUncaughtListeners);
		expect(process.listenerCount("unhandledRejection")).toBe(initialUnhandledListeners);
	});

	test("aborts a stalled hello handshake and releases its signal listener", async () => {
		const identity = createClientIdentity("aborted-stalled-hello");
		const controller = new AbortController();
		const rawServer = await startStalledHelloServer();
		try {
			const connecting = connectRpcClient({
				url: rawServer.url,
				identity,
				expectedServerIdentity: agentsIdentity,
				signal: controller.signal,
				limits: {
					...defaultLimits,
					handshakeTimeoutMs: 5_000,
				},
			});
			await rawServer.upgraded;
			expect(getEventListeners(controller.signal, "abort").length).toBeGreaterThan(0);

			const startedAt = performance.now();
			controller.abort(new Error("Parent control channel closed."));
			await expect(within(connecting, 250)).rejects.toMatchObject({
				code: "INTERNAL_ERROR",
			});
			expect(performance.now() - startedAt).toBeLessThan(250);
			await within(rawServer.closed);
			await Bun.sleep(0);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			expect(rawServer.isClean()).toBe(true);
		} finally {
			await rawServer.stop();
		}
	});

	test("does not resolve credentials for an already-aborted connection", async () => {
		const controller = new AbortController();
		controller.abort(new Error("Executor parent exited."));
		let providerCalls = 0;

		await expect(
			connectRpcClient({
				url: "ws://127.0.0.1:1/rpc",
				identity: createClientIdentity("pre-aborted"),
				expectedServerIdentity: agentsIdentity,
				signal: controller.signal,
				getHandshakeHeaders: () => {
					providerCalls += 1;
					return { authorization: "unused" };
				},
			}),
		).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(providerCalls).toBe(0);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	test("enforces an absolute HTTP upgrade deadline against drip-fed headers", async () => {
		const dripServer = await startRawTcpServer((socket) => {
			let interval: ReturnType<typeof setInterval> | undefined;
			socket.once("data", () => {
				interval = setInterval(() => {
					if (!socket.destroyed) {
						socket.write("H");
					}
				}, 10);
			});
			socket.once("close", () => {
				if (interval !== undefined) {
					clearInterval(interval);
					interval = undefined;
				}
			});
			return () => interval === undefined;
		});
		const startedAt = performance.now();
		try {
			await expect(
				connectStreamingWebSocketClient({
					url: dripServer.url,
					handshakeTimeoutMs: 60,
					maxPayloadBytes: MIN_RPC_FRAME_BYTES,
				}),
			).rejects.toMatchObject({ code: "HANDSHAKE_TIMEOUT" });
			const elapsedMs = performance.now() - startedAt;
			expect(elapsedMs).toBeGreaterThanOrEqual(40);
			expect(elapsedMs).toBeLessThan(250);
			await within(dripServer.closed);
			expect(dripServer.isClean()).toBe(true);
		} finally {
			await dripServer.stop();
		}
	});

	test("accepts the exact protocol frame minimum", async () => {
		const limits = {
			...defaultLimits,
			maxFrameBytes: MIN_RPC_FRAME_BYTES,
		};
		const server = startServer({ limits });
		const client = await connectClient(server, createClientIdentity("minimum-frame"), {
			limits,
		});
		expect(client.isClosed).toBe(false);
	});

	test("rejects incompatible protocol and schema versions during handshake", async () => {
		const server = startServer();
		const badProtocolIdentity = createClientIdentity("bad-protocol");
		const badProtocolCredential = authorizeIdentity(server, badProtocolIdentity);

		await expect(
			connectRpcClient({
				url: server.url,
				identity: badProtocolIdentity,
				protocol: { major: 99, minor: 0 },
				limits: defaultLimits,
				getHandshakeHeaders: badProtocolCredential.getHandshakeHeaders,
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });

		const badSchemaIdentity = createClientIdentity("bad-schema");
		const socket = await openAuthorizedRawSocket(server, badSchemaIdentity);
		const response = nextJsonMessage(socket);
		socket.send(
			JSON.stringify({
				schemaVersion: 99,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "hello",
				peer: badSchemaIdentity,
			}),
		);

		expect(rpcProtocolErrorEnvelopeSchema.parse(await response)).toMatchObject({
			code: "UNSUPPORTED_SCHEMA",
			fatal: true,
		});
	});

	test("rejects malformed frames after a valid handshake", async () => {
		const server = startServer();
		const identity = createClientIdentity("raw-malformed");
		const socket = await openAuthorizedRawSocket(server, identity);
		socket.send(
			JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "hello",
				peer: identity,
			}),
		);
		expect(rpcHelloAckEnvelopeSchema.parse(await nextJsonMessage(socket)).type).toBe("hello-ack");

		const protocolError = nextJsonMessage(socket);
		const closed = nextClose(socket);
		socket.send("{not-json");

		expect(rpcProtocolErrorEnvelopeSchema.parse(await protocolError)).toMatchObject({
			code: "MALFORMED_FRAME",
			fatal: true,
		});
		expect((await closed).code).toBe(1002);
	});

	test("rejects deeply nested JSON before schema traversal without invoking handlers", async () => {
		let handlerInvocations = 0;
		const server = startServer({
			handlers: {
				events: {
					"fixture.deep": () => {
						handlerInvocations += 1;
					},
				},
			},
			methodAllowlist: {
				client: { events: ["fixture.deep"] },
			},
		});
		const identity = createClientIdentity("deep-json");
		const socket = await openAuthorizedRawSocket(server, identity);
		socket.send(
			JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "hello",
				peer: identity,
			}),
		);
		await nextJsonMessage(socket);

		const protocolError = nextJsonMessage(socket);
		const closed = nextClose(socket);
		const prefix = `{"schemaVersion":1,"protocol":{"major":1,"minor":0},"type":"event","eventId":"deep","traceId":"deep","method":"fixture.deep","payload":`;
		socket.send(`${prefix}${"[".repeat(25_000)}${"]".repeat(25_000)}}`);

		expect(rpcProtocolErrorEnvelopeSchema.parse(await protocolError)).toMatchObject({
			code: "MALFORMED_FRAME",
			fatal: true,
		});
		expect((await closed).code).toBe(1002);
		expect(handlerInvocations).toBe(0);
	});

	test("supports client requests and one-way events", async () => {
		const observedEvent = deferred<JsonValue>();
		const server = startServer({
			handlers: {
				requests: {
					"fixture.echo": (payload, context) => ({
						payload,
						remoteRole: context.remoteIdentity.role,
					}),
				},
				events: {
					"fixture.changed": (payload) => {
						observedEvent.resolve(payload);
					},
				},
			},
			methodAllowlist: {
				client: {
					requests: ["fixture.echo"],
					events: ["fixture.changed"],
				},
			},
		});
		const client = await connectClient(server, createClientIdentity("request-event"));

		await expect(
			client.request("fixture.echo", { value: "hello" }, { traceId: "trace-echo" }),
		).resolves.toEqual({
			payload: { value: "hello" },
			remoteRole: "client",
		});
		expect(
			client.emitEvent("fixture.changed", { sequence: 1 }, { traceId: "trace-event" }),
		).toBeString();
		await expect(within(observedEvent.promise)).resolves.toEqual({ sequence: 1 });
	});

	test("releases synchronous event slots before processing a coalesced burst", async () => {
		const maximum = 4;
		let handled = 0;
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			limits: {
				...defaultLimits,
				maxConcurrentEvents: maximum,
			},
			handlers: {
				events: {
					"fixture.synchronous": () => {
						handled += 1;
					},
				},
			},
			methodAllowlist: {
				client: { events: ["fixture.synchronous"] },
			},
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		const client = await connectClient(server, createClientIdentity("synchronous-event-burst"));

		for (let index = 0; index < 1_000; index += 1) {
			client.emitEvent("fixture.synchronous", { index });
		}

		const connectedPeer = await waitForValue(() => serverPeer);
		await waitFor(() => handled === 1_000);
		expect(connectedPeer.inboundEventCount).toBe(0);
		expect(connectedPeer.isClosed).toBe(false);
	});

	test("contains hostile custom event thenables without leaking slots", async () => {
		const reported: unknown[] = [];
		const unhandled: unknown[] = [];
		let completed = 0;
		let serverPeer: RpcPeer | undefined;
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const getterFailure = new Error("then getter failed");
			const callbackFailure = new Error("then callback failed");
			const server = startServer({
				limits: {
					...defaultLimits,
					maxConcurrentEvents: 1,
				},
				handlers: {
					events: {
						"fixture.then-getter": () => createThrowingThenable(getterFailure, true),
						"fixture.then-callback": () => createThrowingThenable(callbackFailure, false),
						"fixture.after-thenable": () => {
							completed += 1;
						},
					},
				},
				methodAllowlist: {
					client: {
						events: ["fixture.then-getter", "fixture.then-callback", "fixture.after-thenable"],
					},
				},
				onConnection: (peer) => {
					serverPeer = peer;
				},
				onError: (error) => {
					reported.push(error);
				},
			});
			const client = await connectClient(server, createClientIdentity("hostile-thenable"));
			const connectedPeer = await waitForValue(() => serverPeer);

			client.emitEvent("fixture.then-getter", null);
			await waitFor(() => reported.includes(getterFailure));
			expect(connectedPeer.inboundEventCount).toBe(0);

			client.emitEvent("fixture.then-callback", null);
			await waitFor(() => reported.includes(callbackFailure));
			await waitFor(() => connectedPeer.inboundEventCount === 0);

			client.emitEvent("fixture.after-thenable", null);
			await waitFor(() => completed === 1);
			await Bun.sleep(20);
			expect(connectedPeer.isClosed).toBe(false);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("contains synchronous event throws and releases their slots", async () => {
		const failure = new Error("synchronous event failure");
		const reported = deferred<unknown>();
		const completed = deferred<void>();
		const unhandled: unknown[] = [];
		let serverPeer: RpcPeer | undefined;
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const server = startServer({
				limits: {
					...defaultLimits,
					maxConcurrentEvents: 1,
				},
				handlers: {
					events: {
						"fixture.throw": () => {
							throw failure;
						},
						"fixture.after-throw": () => {
							completed.resolve();
						},
					},
				},
				methodAllowlist: {
					client: { events: ["fixture.throw", "fixture.after-throw"] },
				},
				onConnection: (peer) => {
					serverPeer = peer;
				},
				onError: (error) => {
					reported.resolve(error);
				},
			});
			const client = await connectClient(server, createClientIdentity("synchronous-event-throw"));
			const connectedPeer = await waitForValue(() => serverPeer);

			client.emitEvent("fixture.throw", null);
			await expect(within(reported.promise)).resolves.toBe(failure);
			expect(connectedPeer.inboundEventCount).toBe(0);

			client.emitEvent("fixture.after-throw", null);
			await within(completed.promise);
			await Bun.sleep(20);
			expect(connectedPeer.isClosed).toBe(false);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("fails closed when duplicate-ID event executions exceed their concurrency bound", async () => {
		const maximum = 4;
		const release = deferred<void>();
		const signals: AbortSignal[] = [];
		const reported: unknown[] = [];
		const unhandled: unknown[] = [];
		let serverPeer: RpcPeer | undefined;
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const server = startServer({
				limits: {
					...defaultLimits,
					maxConcurrentEvents: maximum,
				},
				handlers: {
					events: {
						"fixture.never-settles": async (_payload, context) => {
							signals.push(context.signal);
							await release.promise;
						},
					},
				},
				methodAllowlist: {
					client: { events: ["fixture.never-settles"] },
				},
				onConnection: (peer) => {
					serverPeer = peer;
				},
				onError: (error) => {
					reported.push(error);
				},
			});
			const client = await connectClient(server, createClientIdentity("event-flood"));

			for (let index = 0; index < 1_000; index += 1) {
				client.emitEvent("fixture.never-settles", { index }, { eventId: "duplicate-event-id" });
			}

			const connectedPeer = await waitForValue(() => serverPeer);
			const close = await within(connectedPeer.closed);
			expect(close.code).toBe(1002);
			expect(close.reason).toContain("EVENT_LIMIT_EXCEEDED");
			expect(signals).toHaveLength(maximum);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(connectedPeer.inboundEventCount).toBe(maximum);

			release.reject(new Error("late event failure"));
			await waitFor(() => connectedPeer.inboundEventCount === 0);
			await Bun.sleep(20);
			expect(reported).toHaveLength(maximum);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("supports server-to-client requests", async () => {
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		await connectClient(server, createClientIdentity("server-request"), {
			handlers: {
				requests: {
					"fixture.inspect": (payload, context) => ({
						payload,
						caller: context.remoteIdentity.role,
					}),
				},
			},
			methodAllowlist: {
				agents: { requests: ["fixture.inspect"] },
			},
		});

		const connectedPeer = await waitForValue(() => serverPeer);
		await expect(connectedPeer.request("fixture.inspect", ["a", "b"])).resolves.toEqual({
			payload: ["a", "b"],
			caller: "agents",
		});
	});

	test("propagates request deadlines and caller cancellation", async () => {
		const started = [deferred<void>(), deferred<void>()] as const;
		const aborted: unknown[] = [];
		let invocation = 0;
		const server = startServer({
			handlers: {
				requests: {
					"fixture.wait": (_payload, context) => {
						const index = invocation;
						invocation += 1;
						started[index]?.resolve();
						return new Promise<JsonValue>((_resolve, reject) => {
							context.signal.addEventListener(
								"abort",
								() => {
									aborted.push(context.signal.reason);
									reject(context.signal.reason);
								},
								{ once: true },
							);
						});
					},
				},
			},
			methodAllowlist: {
				client: { requests: ["fixture.wait"] },
			},
		});
		const client = await connectClient(server, createClientIdentity("cancel"));

		const timedOut = client.request("fixture.wait", null, { timeoutMs: 40 });
		await within(started[0].promise);
		const timeoutError = await timedOut.catch((error: unknown) => error);
		expect(
			(timeoutError instanceof RpcTimeoutError || timeoutError instanceof RpcRemoteError) &&
				timeoutError.code === "DEADLINE_EXCEEDED",
		).toBe(true);
		await waitFor(() => aborted.length === 1);

		const controller = new AbortController();
		const cancelled = client.request("fixture.wait", null, {
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		await within(started[1].promise);
		controller.abort("test cancellation");
		await expect(cancelled).rejects.toBeInstanceOf(RpcCancelledError);
		await waitFor(() => aborted.length === 2);
		expect(client.pendingRequestCount).toBe(0);
	});

	test("retains a cancelled non-cooperative handler's concurrency slot until settlement", async () => {
		const firstStarted = deferred<void>();
		const firstAborted = deferred<void>();
		const releaseFirst = deferred<JsonValue>();
		let invocation = 0;
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			limits: {
				...defaultLimits,
				maxConcurrentRequests: 1,
			},
			handlers: {
				requests: {
					"fixture.non-cooperative": (_payload, context) => {
						invocation += 1;
						if (invocation !== 1) {
							return { invocation };
						}
						firstStarted.resolve();
						context.signal.addEventListener("abort", () => firstAborted.resolve(), {
							once: true,
						});
						return releaseFirst.promise;
					},
				},
			},
			methodAllowlist: {
				client: { requests: ["fixture.non-cooperative"] },
			},
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		const client = await connectClient(server, createClientIdentity("non-cooperative"));
		const controller = new AbortController();
		const first = client.request("fixture.non-cooperative", null, {
			signal: controller.signal,
		});
		await within(firstStarted.promise);
		controller.abort("test cancellation");
		await expect(first).rejects.toBeInstanceOf(RpcCancelledError);
		await within(firstAborted.promise);

		const connectedPeer = await waitForValue(() => serverPeer);
		expect(connectedPeer.inboundRequestCount).toBe(1);
		await expect(client.request("fixture.non-cooperative", null)).rejects.toMatchObject({
			code: "REQUEST_LIMIT_EXCEEDED",
		});
		expect(invocation).toBe(1);

		releaseFirst.resolve("ignored late result");
		await waitFor(() => connectedPeer.inboundRequestCount === 0);
		await expect(client.request("fixture.non-cooperative", null)).resolves.toEqual({
			invocation: 2,
		});
	});

	test("never reuses request IDs or aliases a late response", async () => {
		let serverSocket: Bun.ServerWebSocket<undefined> | undefined;
		const requests: RpcRequestEnvelope[] = [];
		const rawServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				return server.upgrade(request)
					? undefined
					: new Response("WebSocket upgrade required.", { status: 426 });
			},
			websocket: {
				message(socket, message) {
					if (typeof message !== "string") {
						socket.close(1003, "Text frames required.");
						return;
					}
					const envelope = rpcEnvelopeSchema.parse(JSON.parse(message));
					if (envelope.type === "hello") {
						serverSocket = socket;
						socket.send(
							JSON.stringify({
								schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
								protocol: CURRENT_PROCESS_RPC_PROTOCOL,
								type: "hello-ack",
								connectionId: "correlation-connection",
								peer: agentsIdentity,
								acceptedPeer: envelope.peer,
							}),
						);
					} else if (envelope.type === "request") {
						requests.push(envelope);
					}
				},
			},
		});
		const port = requireServerPort(rawServer);
		let client: RpcPeer | undefined;
		try {
			client = await connectRpcClient({
				url: `ws://127.0.0.1:${port}/rpc`,
				identity: createClientIdentity("correlation"),
				limits: defaultLimits,
			});
			peers.push(client);

			const first = client.request("fixture.first", null, { timeoutMs: 30 });
			await waitFor(() => requests.length === 1);
			await expect(first).rejects.toBeInstanceOf(RpcTimeoutError);

			let secondSettled = false;
			const second = client.request("fixture.second", null, { timeoutMs: 1_000 });
			second.finally(() => {
				secondSettled = true;
			});
			await waitFor(() => requests.length === 2);
			const firstRequest = requests[0];
			const secondRequest = requests[1];
			if (firstRequest === undefined || secondRequest === undefined) {
				throw new Error("Expected two captured RPC requests.");
			}
			expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

			sendRawResponse(serverSocket, firstRequest, "late-first");
			await Bun.sleep(20);
			expect(secondSettled).toBe(false);

			sendRawResponse(serverSocket, secondRequest, "second");
			await expect(second).resolves.toBe("second");
		} finally {
			client?.close();
			void rawServer.stop(true);
		}
	});

	test("rejects pending requests and aborts handlers on disconnect", async () => {
		const started = deferred<void>();
		const handlerAborted = deferred<void>();
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			handlers: {
				requests: {
					"fixture.disconnect": (_payload, context) => {
						started.resolve();
						return new Promise<JsonValue>((_resolve, reject) => {
							context.signal.addEventListener(
								"abort",
								() => {
									handlerAborted.resolve();
									reject(context.signal.reason);
								},
								{ once: true },
							);
						});
					},
				},
			},
			methodAllowlist: {
				client: { requests: ["fixture.disconnect"] },
			},
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		const client = await connectClient(server, createClientIdentity("disconnect"));
		const request = client.request("fixture.disconnect", null, { timeoutMs: 2_000 });
		await within(started.promise);

		(await waitForValue(() => serverPeer)).close(1012, "test disconnect");
		await expect(request).rejects.toBeInstanceOf(RpcConnectionClosedError);
		await within(handlerAborted.promise);
		expect(client.pendingRequestCount).toBe(0);
	});

	test("enforces role-specific method allowlists", async () => {
		const server = startServer({
			handlers: {
				requests: {
					"fixture.executor-only": () => ({ allowed: true }),
				},
			},
			methodAllowlist: {
				executor: { requests: ["fixture.executor-only"] },
			},
		});
		const client = await connectClient(server, createClientIdentity("allowlist-client"));
		await expect(client.request("fixture.executor-only", null)).rejects.toMatchObject({
			code: "METHOD_NOT_ALLOWED",
		});

		const executor = await connectClient(server, {
			role: "executor",
			peerId: "executor-local",
			instanceId: "executor-start-1",
			generation: 1,
		});
		await expect(executor.request("fixture.executor-only", null)).resolves.toEqual({
			allowed: true,
		});
	});

	test("enforces configurable pending-request and frame limits", async () => {
		const started = deferred<void>();
		const server = startServer({
			handlers: {
				requests: {
					"fixture.hold": (_payload, context) => {
						started.resolve();
						return new Promise<JsonValue>((_resolve, reject) => {
							context.signal.addEventListener("abort", () => reject(context.signal.reason), {
								once: true,
							});
						});
					},
				},
			},
			methodAllowlist: {
				client: { requests: ["fixture.hold"] },
			},
		});
		const client = await connectClient(server, createClientIdentity("limits"), {
			limits: {
				...defaultLimits,
				maxPendingRequests: 1,
				maxFrameBytes: MIN_RPC_FRAME_BYTES,
			},
		});
		const first = client.request("fixture.hold", null);
		await within(started.promise);

		await expect(client.request("fixture.hold", null)).rejects.toBeInstanceOf(RpcRequestLimitError);
		expect(() => client.emitEvent("fixture.large", "x".repeat(MIN_RPC_FRAME_BYTES * 2))).toThrow(
			RpcFrameTooLargeError,
		);
		client.close();
		await expect(first).rejects.toBeInstanceOf(RpcConnectionClosedError);
	});

	test("keeps the connection open when a handler result exceeds the frame limit", async () => {
		const limits = {
			...defaultLimits,
			maxFrameBytes: MIN_RPC_FRAME_BYTES,
		};
		const server = startServer({
			limits,
			handlers: {
				requests: {
					"fixture.large-result": () => "x".repeat(MIN_RPC_FRAME_BYTES * 2),
					"fixture.small-result": () => ({ ok: true }),
				},
			},
			methodAllowlist: {
				client: {
					requests: ["fixture.large-result", "fixture.small-result"],
				},
			},
		});
		const client = await connectClient(server, createClientIdentity("large-result"), {
			limits,
		});

		await expect(client.request("fixture.large-result", null)).rejects.toMatchObject({
			code: "RESPONSE_TOO_LARGE",
		});
		expect(client.isClosed).toBe(false);
		await expect(client.request("fixture.small-result", null)).resolves.toEqual({
			ok: true,
		});
	});

	test("terminates oversized server frames in the streaming client before RPC parsing", async () => {
		const limits = {
			...defaultLimits,
			maxFrameBytes: MIN_RPC_FRAME_BYTES,
		};
		const serverCloseCode = deferred<number>();
		let framesAfterHello = 0;
		const rawServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				return server.upgrade(request)
					? undefined
					: new Response("WebSocket upgrade required.", { status: 426 });
			},
			websocket: {
				message(socket, message) {
					if (typeof message !== "string") {
						return;
					}
					const envelope = rpcEnvelopeSchema.parse(JSON.parse(message));
					if (envelope.type !== "hello") {
						framesAfterHello += 1;
						return;
					}
					socket.send(
						JSON.stringify({
							schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
							protocol: CURRENT_PROCESS_RPC_PROTOCOL,
							type: "hello-ack",
							connectionId: "oversized-connection",
							peer: agentsIdentity,
							acceptedPeer: envelope.peer,
						}),
					);
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
								protocol: CURRENT_PROCESS_RPC_PROTOCOL,
								type: "event",
								eventId: "oversized-event",
								traceId: "oversized-trace",
								method: "fixture.oversized",
								payload: "x".repeat(MIN_RPC_FRAME_BYTES * 2),
							}),
						);
					}, 10);
				},
				close(_socket, code) {
					serverCloseCode.resolve(code);
				},
			},
		});

		const nativeErrors: unknown[] = [];
		let client: RpcPeer | undefined;
		try {
			client = await connectRpcClient({
				url: `ws://127.0.0.1:${requireServerPort(rawServer)}/rpc`,
				identity: createClientIdentity("oversized-inbound"),
				limits,
				onError: (error) => {
					nativeErrors.push(error);
				},
			});
			peers.push(client);

			await expect(within(serverCloseCode.promise)).resolves.toBe(1009);
			await waitFor(() => nativeErrors.length > 0);
			expect(nativeErrors[0]).toMatchObject({
				code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
			});
			expect(framesAfterHello).toBe(0);
		} finally {
			client?.close();
			void rawServer.stop(true);
		}
	});

	test("sets finite receiver safeguards and accepts ordinary fragmented messages", async () => {
		const identity = createClientIdentity("fragmented-normal");
		const observed = deferred<JsonValue>();
		const inspectionServer = await startRawWebSocketServer(identity);
		try {
			const connection = await connectStreamingWebSocketClient({
				url: inspectionServer.url,
				handshakeTimeoutMs: defaultLimits.handshakeTimeoutMs,
				maxPayloadBytes: MIN_RPC_FRAME_BYTES,
			});
			const receiver = Reflect.get(connection.socket, "_receiver") as
				| { _maxBufferedChunks?: number; _maxFragments?: number }
				| undefined;
			expect(receiver?._maxBufferedChunks).toBe(RPC_WEBSOCKET_MAX_BUFFERED_CHUNKS);
			expect(receiver?._maxFragments).toBe(RPC_WEBSOCKET_MAX_FRAGMENTS);
			connection.socket.terminate();
		} finally {
			await inspectionServer.stop();
		}

		const rawServer = await startRawWebSocketServer(identity, (socket) => {
			const event = JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "event",
				eventId: "fragmented-event",
				traceId: "fragmented-trace",
				method: "fixture.fragmented",
				payload: { ok: true },
			});
			writeFragmentedText(socket, event, 3);
		});
		try {
			const client = await connectRpcClient({
				url: rawServer.url,
				identity,
				limits: defaultLimits,
				handlers: {
					events: {
						"fixture.fragmented": (payload) => {
							observed.resolve(payload);
						},
					},
				},
				methodAllowlist: {
					agents: { events: ["fixture.fragmented"] },
				},
			});
			peers.push(client);
			await expect(within(observed.promise)).resolves.toEqual({ ok: true });
		} finally {
			await rawServer.stop();
		}
	});

	test("terminates excessive fragmentation before delivering to the RPC parser", async () => {
		const identity = createClientIdentity("fragment-attack");
		let handlerInvocations = 0;
		const transportErrors: unknown[] = [];
		const rawServer = await startRawWebSocketServer(
			identity,
			(socket) => {
				const event = JSON.stringify({
					schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
					protocol: CURRENT_PROCESS_RPC_PROTOCOL,
					type: "event",
					eventId: "fragment-attack",
					traceId: "fragment-attack",
					method: "fixture.fragment-attack",
					payload: "x".repeat(RPC_WEBSOCKET_MAX_FRAGMENTS),
				});
				writeFragmentedText(socket, event, RPC_WEBSOCKET_MAX_FRAGMENTS + 1);
			},
			false,
		);
		try {
			const client = await connectRpcClient({
				url: rawServer.url,
				identity,
				limits: defaultLimits,
				handlers: {
					events: {
						"fixture.fragment-attack": () => {
							handlerInvocations += 1;
						},
					},
				},
				methodAllowlist: {
					agents: { events: ["fixture.fragment-attack"] },
				},
				onError: (error) => {
					transportErrors.push(error);
				},
			});
			peers.push(client);
			await within(client.closed);
			expect(handlerInvocations).toBe(0);
			expect(transportErrors).toContainEqual(
				expect.objectContaining({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS" }),
			);
		} finally {
			await rawServer.stop();
		}
	});

	test("bounds client data buffering and permits recovery after backpressure drains", async () => {
		const identity = createClientIdentity("outbound-budget");
		const resumed = deferred<void>();
		const rawServer = await startRawWebSocketServer(
			identity,
			(socket) => {
				socket.pause();
				setTimeout(() => {
					socket.resume();
					resumed.resolve();
				}, 30);
			},
			false,
		);
		try {
			const client = await connectRpcClient({
				url: rawServer.url,
				identity,
				limits: {
					...defaultLimits,
					maxFrameBytes: MIN_RPC_FRAME_BYTES,
					maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
				},
			});
			peers.push(client);
			client.emitEvent("fixture.recovery", "x".repeat(1_024));
			await within(resumed.promise);
			await Bun.sleep(20);
			expect(() => client.emitEvent("fixture.recovery", "after drain")).not.toThrow();
			expect(client.isClosed).toBe(false);
		} finally {
			await rawServer.stop();
		}

		const blockedServer = await startRawWebSocketServer(
			identity,
			(socket) => socket.pause(),
			false,
		);
		try {
			const client = await connectRpcClient({
				url: blockedServer.url,
				identity,
				limits: {
					...defaultLimits,
					maxFrameBytes: MIN_RPC_FRAME_BYTES,
					maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
				},
			});
			peers.push(client);
			const pending = client.request("fixture.never-responds", null);
			const pendingOutcome = pending.catch((error: unknown) => error);
			for (let index = 0; index < 20_000 && !client.isClosed; index += 1) {
				try {
					client.emitEvent("fixture.fill", "x".repeat(7_000));
				} catch {
					break;
				}
			}
			await expect(within(client.closed, 2_000)).resolves.toBeDefined();
			expect(await pendingOutcome).toBeInstanceOf(RpcConnectionClosedError);
			expect(client.pendingRequestCount).toBe(0);
		} finally {
			await blockedServer.stop();
		}
	});

	test("budgets manual pong traffic under a paused receiver ping flood", async () => {
		const identity = createClientIdentity("pong-budget");
		const rawServer = await startRawWebSocketServer(
			identity,
			(socket) => {
				socket.pause();
				const ping = createServerWebSocketFrame(Buffer.alloc(125), 0x9, true);
				socket.write(Buffer.concat(Array.from({ length: 50_000 }, () => ping)));
			},
			false,
		);
		try {
			const client = await connectRpcClient({
				url: rawServer.url,
				identity,
				limits: {
					...defaultLimits,
					maxFrameBytes: MIN_RPC_FRAME_BYTES,
					maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
				},
			});
			peers.push(client);
			await expect(within(client.closed, 2_000)).resolves.toBeDefined();
			expect(client.isClosed).toBe(true);
		} finally {
			await rawServer.stop();
		}
	});

	test("answers budgeted pings before the RPC hello acknowledgement", async () => {
		const identity = createClientIdentity("pre-ack-pong");
		const rawServer = await startPingBeforeAckServer(identity);
		try {
			const client = await connectRpcClient({
				url: rawServer.url,
				identity,
				limits: {
					...defaultLimits,
					maxFrameBytes: MIN_RPC_FRAME_BYTES,
					maxBufferedOutboundBytes: MIN_RPC_FRAME_BYTES,
				},
			});
			peers.push(client);
			expect(client.isClosed).toBe(false);
		} finally {
			await rawServer.stop();
		}
	});

	test("preserves close codes for multibyte protocol error messages", async () => {
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		const client = await connectClient(server, createClientIdentity("unicode-close"));

		(await waitForValue(() => serverPeer)).rejectProtocol(
			"INTERNAL_ERROR",
			`Failure: ${"界".repeat(200)}`,
			true,
		);

		expect((await within(client.closed)).code).toBe(1002);
	});

	test("rejects invalid close codes without corrupting client or server peer state", async () => {
		let serverPeer: RpcPeer | undefined;
		const server = startServer({
			handlers: {
				requests: {
					"fixture.echo": (payload) => payload,
				},
			},
			methodAllowlist: {
				client: { requests: ["fixture.echo"] },
			},
			onConnection: (peer) => {
				serverPeer = peer;
			},
		});
		const client = await connectClient(server, createClientIdentity("invalid-close"));
		const connectedPeer = await waitForValue(() => serverPeer);

		expect(() => client.close(1006, "reserved code")).toThrow("Invalid WebSocket close code: 1006");
		expect(client.isClosed).toBe(false);
		expect(connectedPeer.isClosed).toBe(false);
		await expect(client.request("fixture.echo", "after client rejection")).resolves.toBe(
			"after client rejection",
		);

		expect(() => connectedPeer.close(1006, "reserved code")).toThrow(
			"Invalid WebSocket close code: 1006",
		);
		expect(client.isClosed).toBe(false);
		expect(connectedPeer.isClosed).toBe(false);
		await expect(client.request("fixture.echo", "after server rejection")).resolves.toBe(
			"after server rejection",
		);

		const clientClosed = client.closed;
		connectedPeer.close(1000, "valid close");
		await expect(within(clientClosed)).resolves.toMatchObject({ code: 1000 });
		expect(connectedPeer.isClosed).toBe(true);
	});

	test("observes async lifecycle callback failures without unhandled rejections", async () => {
		const unhandled: unknown[] = [];
		const reported: unknown[][] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		const originalConsoleError = console.error;
		process.on("unhandledRejection", onUnhandled);
		console.error = (...values: unknown[]) => {
			reported.push(values);
		};
		let serverPeer: RpcPeer | undefined;
		try {
			const server = startServer({
				onConnection: (peer) => {
					serverPeer = peer;
				},
			});
			const client = await connectClient(server, createClientIdentity("async-callbacks"), {
				onProtocolError: async () => {
					throw new Error("async protocol callback failed");
				},
				onClose: async () => {
					throw new Error("async close callback failed");
				},
				onError: async () => {
					throw new Error("async error reporter failed");
				},
			});
			(await waitForValue(() => serverPeer)).rejectProtocol(
				"INTERNAL_ERROR",
				"callback test",
				false,
			);
			await Bun.sleep(10);
			client.handleTransportError(new Error("trigger async reporter"));
			client.close();
			await Bun.sleep(20);

			expect(unhandled).toEqual([]);
			expect(reported.length).toBeGreaterThanOrEqual(3);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			console.error = originalConsoleError;
		}
	});

	test("fences replaced generations and rejects stale reconnects", async () => {
		const server = startServer();
		const stablePeerId = "generation-peer";
		const first = await connectClient(server, {
			role: "client",
			peerId: stablePeerId,
			instanceId: "generation-start-1",
			generation: 1,
		});
		const firstClosed = first.closed;

		const replacement = await connectClient(server, {
			role: "client",
			peerId: stablePeerId,
			instanceId: "generation-start-2",
			generation: 2,
		});
		expect(replacement.isClosed).toBe(false);
		expect((await within(firstClosed)).code).toBe(1002);

		const staleIdentity: RpcPeerIdentity = {
			role: "client",
			peerId: stablePeerId,
			instanceId: "generation-start-1",
			generation: 1,
		};
		const staleCredential = authorizeIdentity(server, staleIdentity);
		await expect(
			connectRpcClient({
				url: server.url,
				identity: staleIdentity,
				limits: defaultLimits,
				getHandshakeHeaders: staleCredential.getHandshakeHeaders,
			}),
		).rejects.toMatchObject({ code: "STALE_GENERATION" });
	});
});

function startServer(overrides: Partial<RpcServerBaseOptions> = {}): RpcServer {
	const identitiesByAuthorization = new Map<string, RpcPeerIdentity>();
	const server = createRpcServer({
		identity: agentsIdentity,
		limits: defaultLimits,
		authenticate: (request) => {
			const authorization = request.headers.get("authorization");
			return authorization === null ? null : (identitiesByAuthorization.get(authorization) ?? null);
		},
		...overrides,
	});
	credentialsByServer.set(server, identitiesByAuthorization);
	servers.push(server);
	return server;
}

async function connectClient(
	server: RpcServer,
	identity: RpcPeerIdentity,
	options: Pick<
		ConnectRpcClientOptions,
		"handlers" | "methodAllowlist" | "limits" | "onProtocolError" | "onError" | "onClose"
	> = {},
): Promise<RpcPeer> {
	const credential = authorizeIdentity(server, identity);
	const peer = await connectRpcClient({
		url: server.url,
		identity,
		limits: defaultLimits,
		getHandshakeHeaders: credential.getHandshakeHeaders,
		...options,
	});
	peers.push(peer);
	return peer;
}

function createClientIdentity(suffix: string): RpcPeerIdentity {
	return {
		role: "client",
		peerId: `client-${suffix}`,
		instanceId: `instance-${suffix}`,
		generation: 1,
	};
}

function createThrowingThenable(error: Error, throwFromGetter: boolean): Promise<void> {
	const thenable = {};
	Object.defineProperty(
		thenable,
		// biome-ignore lint/suspicious/noThenProperty: This adversarial fixture must behave as a thenable.
		"then",
		throwFromGetter
			? {
					get(): never {
						throw error;
					},
				}
			: {
					value(): never {
						throw error;
					},
				},
	);
	return thenable as Promise<void>;
}

function sendRawResponse(
	socket: Bun.ServerWebSocket<undefined> | undefined,
	request: RpcRequestEnvelope,
	payload: JsonValue,
): void {
	if (socket === undefined) {
		throw new Error("Raw RPC server socket is not connected.");
	}
	const response: RpcEnvelope = {
		schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
		protocol: CURRENT_PROCESS_RPC_PROTOCOL,
		type: "response",
		requestId: request.requestId,
		traceId: request.traceId,
		result: {
			ok: true,
			payload,
		},
	};
	socket.send(JSON.stringify(response));
}

function requireServerPort(server: { readonly port: number | undefined }): number {
	if (server.port === undefined) {
		throw new Error("Test server is not listening on a TCP port.");
	}
	return server.port;
}

interface TestCredential {
	readonly authorization: string;
	readonly getHandshakeHeaders: ReturnType<typeof createRpcBearerHandshakeHeaders>;
}

function authorizeIdentity(
	server: RpcServer,
	identity: RpcPeerIdentity,
	credential = `${crypto.randomUUID()}${crypto.randomUUID()}`,
): TestCredential {
	const authorization = `Bearer ${credential}`;
	const identitiesByAuthorization = credentialsByServer.get(server);
	if (identitiesByAuthorization === undefined) {
		throw new Error("RPC test server has no credential registry.");
	}
	identitiesByAuthorization.set(authorization, identity);
	return {
		authorization,
		getHandshakeHeaders: createRpcBearerHandshakeHeaders(credential),
	};
}

async function connectWithWeakHandshakeReferences(
	server: RpcServer,
	identity: RpcPeerIdentity,
): Promise<{
	readonly peer: RpcPeer;
	readonly providerReference: WeakRef<object>;
	readonly headersReference: WeakRef<object>;
}> {
	const credential = authorizeIdentity(server, identity);
	let headers: Readonly<Record<string, string>> | undefined = {
		authorization: credential.authorization,
	};
	const headersReference = new WeakRef<object>(headers);
	let provider: RpcHandshakeHeadersProvider | undefined = () => {
		if (headers === undefined) {
			throw new Error("Handshake headers were released before use.");
		}
		return headers;
	};
	const providerReference = new WeakRef<object>(provider);
	const peer = await connectRpcClient({
		url: server.url,
		identity,
		limits: defaultLimits,
		getHandshakeHeaders: provider,
	});
	provider = undefined;
	headers = undefined;
	return { peer, providerReference, headersReference };
}

async function expectWeakReferencesCollected(
	references: readonly WeakRef<object>[],
): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await Bun.sleep(1);
		Bun.gc(true);
		if (references.every((reference) => reference.deref() === undefined)) {
			return;
		}
	}
	expect(references.map((reference) => reference.deref())).toEqual(references.map(() => undefined));
}

interface RawTcpTestServer {
	readonly url: string;
	readonly closed: Promise<void>;
	isClean(): boolean;
	stop(): Promise<void>;
}

async function startRawTcpServer(
	onConnection: (socket: Socket) => (() => boolean) | undefined,
): Promise<RawTcpTestServer> {
	const sockets = new Set<Socket>();
	const cleanlinessChecks: Array<() => boolean> = [];
	const closed = deferred<void>();
	const server: TcpServer = createTcpServer((socket) => {
		sockets.add(socket);
		const cleanlinessCheck = onConnection(socket);
		if (cleanlinessCheck !== undefined) {
			cleanlinessChecks.push(cleanlinessCheck);
		}
		socket.once("close", () => {
			sockets.delete(socket);
			closed.resolve();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Raw test server did not bind to a TCP port.");
	}
	return {
		url: `ws://127.0.0.1:${address.port}/rpc`,
		closed: closed.promise,
		isClean: () => cleanlinessChecks.every((check) => check()),
		async stop() {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function startRawWebSocketServer(
	identity: RpcPeerIdentity,
	afterUpgrade?: (socket: Socket) => void,
	closeOnClientData = true,
): Promise<RawTcpTestServer> {
	return startRawTcpServer((socket) => {
		let request = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			request = Buffer.concat([request, chunk]);
			const headerEnd = request.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			socket.off("data", onData);
			const headerText = request.subarray(0, headerEnd).toString("latin1");
			const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
			if (key === undefined) {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
				.digest("base64");
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
			if (closeOnClientData) {
				const waitForCloseFrame = (): void => {
					socket.once("data", () => socket.destroy());
				};
				if (request.byteLength > headerEnd + 4) {
					waitForCloseFrame();
				} else {
					socket.once("data", waitForCloseFrame);
				}
			}
			const ack = JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "hello-ack",
				connectionId: "raw-fragmented-connection",
				peer: agentsIdentity,
				acceptedPeer: identity,
			});
			writeFragmentedText(socket, ack, 2);
			if (afterUpgrade !== undefined) {
				setTimeout(() => {
					if (!socket.destroyed) {
						afterUpgrade(socket);
					}
				}, 10);
			}
		};
		socket.on("data", onData);
		return () => socket.listenerCount("data") === 0 || socket.destroyed;
	});
}

async function startRawHandshakeBurstServer(
	clientIdentity: RpcPeerIdentity,
	serverIdentity: RpcPeerIdentity,
	framesAfterAck: readonly Buffer[],
	endAfterWrite = false,
): Promise<RawTcpTestServer> {
	return startRawTcpServer((socket) => {
		let request = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			request = Buffer.concat([request, chunk]);
			const headerEnd = request.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			socket.off("data", onData);
			const headerText = request.subarray(0, headerEnd).toString("latin1");
			const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
			if (key === undefined) {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
				.digest("base64");
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
			const acknowledgement = JSON.stringify({
				schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
				protocol: CURRENT_PROCESS_RPC_PROTOCOL,
				type: "hello-ack",
				connectionId: "raw-handshake-burst",
				peer: serverIdentity,
				acceptedPeer: clientIdentity,
			});
			socket.write(
				Buffer.concat([
					createServerWebSocketFrame(Buffer.from(acknowledgement), 0x1, true),
					...framesAfterAck,
				]),
				() => {
					if (endAfterWrite) {
						socket.end();
					}
				},
			);
		};
		socket.on("data", onData);
		return () => socket.destroyed || socket.listenerCount("data") === 0;
	});
}

async function startStalledHelloServer(): Promise<RawTcpTestServer & { upgraded: Promise<void> }> {
	const upgraded = deferred<void>();
	const server = await startRawTcpServer((socket) => {
		let request = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			request = Buffer.concat([request, chunk]);
			const headerEnd = request.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			socket.off("data", onData);
			const headerText = request.subarray(0, headerEnd).toString("latin1");
			const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
			if (key === undefined) {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
				.digest("base64");
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
			upgraded.resolve();
		};
		socket.on("data", onData);
		return () => socket.destroyed;
	});
	return { ...server, upgraded: upgraded.promise };
}

async function startPingBeforeAckServer(identity: RpcPeerIdentity): Promise<RawTcpTestServer> {
	return startRawTcpServer((socket) => {
		let request = Buffer.alloc(0);
		let frames = Buffer.alloc(0);
		const onUpgradeData = (chunk: Buffer): void => {
			request = Buffer.concat([request, chunk]);
			const headerEnd = request.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			socket.off("data", onUpgradeData);
			const headerText = request.subarray(0, headerEnd).toString("latin1");
			const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
			if (key === undefined) {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "ascii")
				.digest("base64");
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Accept: ${accept}`,
					"",
					"",
				].join("\r\n"),
			);
			socket.write(createServerWebSocketFrame(Buffer.from("pre-ack"), 0x9, true));
			const onFrames = (data: Buffer): void => {
				frames = Buffer.concat([frames, data]);
				const parsed = readClientFrameOpcodes(frames);
				frames = Buffer.from(parsed.remaining);
				if (!parsed.opcodes.includes(0x0a)) {
					return;
				}
				socket.off("data", onFrames);
				writeFragmentedText(
					socket,
					JSON.stringify({
						schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
						protocol: CURRENT_PROCESS_RPC_PROTOCOL,
						type: "hello-ack",
						connectionId: "pre-ack-pong-connection",
						peer: agentsIdentity,
						acceptedPeer: identity,
					}),
					1,
				);
			};
			socket.on("data", onFrames);
			const head = request.subarray(headerEnd + 4);
			if (head.byteLength > 0) {
				onFrames(head);
			}
		};
		socket.on("data", onUpgradeData);
		return () => socket.destroyed;
	});
}

function readClientFrameOpcodes(buffer: Buffer): {
	readonly opcodes: number[];
	readonly remaining: Buffer;
} {
	const opcodes: number[] = [];
	let offset = 0;
	while (offset + 2 <= buffer.byteLength) {
		const first = buffer[offset];
		const second = buffer[offset + 1];
		if (first === undefined || second === undefined) {
			break;
		}
		let payloadBytes = second & 0x7f;
		let headerBytes = 2;
		if (payloadBytes === 126) {
			if (offset + 4 > buffer.byteLength) {
				break;
			}
			payloadBytes = buffer.readUInt16BE(offset + 2);
			headerBytes = 4;
		} else if (payloadBytes === 127) {
			if (offset + 10 > buffer.byteLength) {
				break;
			}
			const extended = buffer.readBigUInt64BE(offset + 2);
			if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new RangeError("Test client frame was too large.");
			}
			payloadBytes = Number(extended);
			headerBytes = 10;
		}
		if ((second & 0x80) !== 0) {
			headerBytes += 4;
		}
		if (offset + headerBytes + payloadBytes > buffer.byteLength) {
			break;
		}
		opcodes.push(first & 0x0f);
		offset += headerBytes + payloadBytes;
	}
	return { opcodes, remaining: buffer.subarray(offset) };
}

function writeFragmentedText(socket: Socket, text: string, fragmentCount: number): void {
	const payload = Buffer.from(text);
	if (fragmentCount < 1 || fragmentCount > payload.byteLength) {
		throw new RangeError("fragmentCount must fit within the encoded text length.");
	}
	const frames: Buffer[] = [];
	for (let index = 0; index < fragmentCount; index += 1) {
		const start = Math.floor((index * payload.byteLength) / fragmentCount);
		const end = Math.floor(((index + 1) * payload.byteLength) / fragmentCount);
		frames.push(
			createServerWebSocketFrame(
				payload.subarray(start, end),
				index === 0 ? 0x1 : 0x0,
				index === fragmentCount - 1,
			),
		);
	}
	socket.write(Buffer.concat(frames));
}

function createServerWebSocketFrame(payload: Buffer, opcode: number, final: boolean): Buffer {
	const firstByte = (final ? 0x80 : 0) | opcode;
	if (payload.byteLength < 126) {
		return Buffer.concat([Buffer.from([firstByte, payload.byteLength]), payload]);
	}
	if (payload.byteLength <= 0xffff) {
		const header = Buffer.allocUnsafe(4);
		header[0] = firstByte;
		header[1] = 126;
		header.writeUInt16BE(payload.byteLength, 2);
		return Buffer.concat([header, payload]);
	}
	throw new RangeError("Raw test WebSocket frames must not exceed 65535 bytes.");
}

async function openAuthorizedRawSocket(
	server: RpcServer,
	identity: RpcPeerIdentity,
): Promise<WebSocket> {
	const credential = authorizeIdentity(server, identity);
	return openRawSocket(server.url, { authorization: credential.authorization });
}

async function openRawSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
	const socket = new WebSocket(url, {
		...(headers === undefined ? {} : { headers }),
		perMessageDeflate: false,
	});
	sockets.push(socket);
	await within(
		new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("WebSocket open failed.")), {
				once: true,
			});
		}),
	);
	return socket;
}

function nextJsonMessage(socket: WebSocket): Promise<unknown> {
	return within(
		new Promise<unknown>((resolve, reject) => {
			socket.addEventListener(
				"message",
				(event) => {
					if (typeof event.data !== "string") {
						reject(new TypeError("Expected a text WebSocket frame."));
						return;
					}
					try {
						resolve(JSON.parse(event.data));
					} catch (error) {
						reject(error);
					}
				},
				{ once: true },
			);
		}),
	);
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
	return within(
		new Promise<CloseEvent>((resolve) => {
			socket.addEventListener("close", resolve, { once: true });
		}),
	);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition.");
		}
		await Bun.sleep(5);
	}
}

async function waitForValue<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
	let value = read();
	await waitFor(() => {
		value = read();
		return value !== undefined;
	}, timeoutMs);
	if (value === undefined) {
		throw new Error("Value was not available.");
	}
	return value;
}

function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
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
		throw new Error("Failed to initialize deferred promise.");
	}
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}
