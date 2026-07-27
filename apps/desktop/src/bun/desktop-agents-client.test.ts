import { describe, expect, test } from "bun:test";

import {
	agentsProductEventMethods,
	agentsRuntimeInfoSchema,
	type ChatRunEvent,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatSendAcceptedOutputSchema,
	createChatSessionOutputSchema,
	createProcessChatSessionInputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	emptyParamsSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	maxRetainedSessionRetirements,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
	replayChatEventsInputSchema,
	replayChatEventsOutputSchema,
	retiredSessionTombstoneTtlMs,
	sendAskChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
} from "@moshu/contracts";
import {
	type ConnectRpcClientOptions,
	type JsonValue,
	RpcConnectionClosedError,
	type RpcEventContext,
	RpcRemoteError,
	RpcRequestLimitError,
	type RpcRequestOptions,
	RpcTimeoutError,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import { agentsUnavailableMessagePrefix, ChatSessionNotFoundError } from "../shared/rpc-errors";
import type { DesktopAgentsConnectOptions } from "./companion-process-supervisor";
import {
	AgentsUnavailableError,
	DesktopAgentsClient,
	type DesktopAgentsRpcPeer,
} from "./desktop-agents-client";

const sessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const otherSessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf";
const runId = "01984df0-cf18-7c89-9d11-3686130434c8";
const otherRunId = "01984df0-cf18-7c89-9d11-3686130434c9";
const userMessageId = "01984df0-cf19-7bb2-a5cd-69e8a802db2f";
const otherUserMessageId = "01984df0-cf19-7bb2-a5cd-69e8a802db30";
const assistantMessageId = "01984df0-cf1a-7178-b174-42fc83c3e87d";
const otherAssistantMessageId = "01984df0-cf1a-7178-b174-42fc83c3e87e";
const clientRequestId = "550e8400-e29b-41d4-a716-446655440000";
const createdAt = "2026-07-25T04:15:28.349Z";

describe("DesktopAgentsClient", () => {
	test("fails explicitly instead of falling back in-process", async () => {
		const client = new DesktopAgentsClient();
		const error = await client
			.request(productRpcMethods.runtimeGet, {}, emptyParamsSchema, agentsRuntimeInfoSchema)
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(AgentsUnavailableError);
		expect((error as Error).message.startsWith(agentsUnavailableMessagePrefix)).toBe(true);
	});

	test("publishes readiness once per recovered connection and stops after unsubscribe", async () => {
		const peers = [new FakePeer(() => ({ events: [] })), new FakePeer(() => ({ events: [] }))];
		let index = 0;
		const client = new DesktopAgentsClient(async () => {
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		let readyCount = 0;
		const unsubscribe = client.subscribeReady(() => {
			readyCount += 1;
		});

		const firstConnection = await client.connect(createConnectOptions());
		expect(readyCount).toBe(1);
		firstConnection.close();
		await client.connect(createConnectOptions());
		expect(readyCount).toBe(2);

		unsubscribe();
		client.close();
		expect(readyCount).toBe(2);
	});

	test.each([
		["committed response is lost", true],
		["request is lost before commit", false],
	])("reconciles one Session create when the %s", async (_name, commitBeforeClose) => {
		const sessionsByKey = new Map<string, JsonValue>();
		const receivedKeys: string[] = [];
		let committedSessions = 0;
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			const input = createProcessChatSessionInputSchema.parse(payload);
			receivedKeys.push(input.createKey);
			let output = sessionsByKey.get(input.createKey);
			if (output === undefined) {
				committedSessions += 1;
				output = createSessionPayload(committedSessions);
				sessionsByKey.set(input.createKey, output);
			}
			return output;
		});
		const client = new DesktopAgentsClient(async (options) => {
			if (connectionIndex++ > 0) {
				return recoveredPeer;
			}
			firstPeer = new FakePeer((method, payload) => {
				if (method !== productRpcMethods.sessionCreate) {
					return { events: [] };
				}
				const input = createProcessChatSessionInputSchema.parse(payload);
				receivedKeys.push(input.createKey);
				if (commitBeforeClose) {
					committedSessions += 1;
					sessionsByKey.set(input.createKey, createSessionPayload(committedSessions));
				}
				options.onClose?.(
					{ code: 1006, reason: "lost create response" },
					firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
				);
				throw new RpcConnectionClosedError(1006, "lost create response");
			});
			return firstPeer;
		});
		await client.connect(createConnectOptions());

		const unavailable = await client.createSession().catch((error: unknown) => error);
		expect(unavailable).toBeInstanceOf(AgentsUnavailableError);
		expect((unavailable as Error).message).not.toContain("lost create response");
		await client.connect(createConnectOptions());
		const recovered = await client.createSession();
		expect(createChatSessionOutputSchema.parse(recovered)).toBeDefined();
		expect(receivedKeys[1]).toBe(receivedKeys[0]);
		expect(committedSessions).toBe(1);
		expect(sessionsByKey.size).toBe(1);

		await client.createSession();
		expect(receivedKeys.at(-1)).not.toBe(receivedKeys[0]);
		expect(committedSessions).toBe(2);
		client.close();
	});

	test.each(["INTERNAL_ERROR", productRpcInternalHandlerErrorCode, "FUTURE_REMOTE_ERROR"])(
		"retains an ambiguous Session create after %s and reconciles the exact durable key",
		async (remoteCode) => {
			const sessionsByKey = new Map<string, JsonValue>();
			const receivedKeys: string[] = [];
			let durableCreates = 0;
			let connectionIndex = 0;
			let firstPeer: FakePeer;
			const commitCreate = (payload: JsonValue): JsonValue => {
				const input = createProcessChatSessionInputSchema.parse(payload);
				receivedKeys.push(input.createKey);
				let output = sessionsByKey.get(input.createKey);
				if (output === undefined) {
					durableCreates += 1;
					output = createSessionPayload(durableCreates);
					sessionsByKey.set(input.createKey, output);
				}
				return output;
			};
			const client = new DesktopAgentsClient(
				async (options) => {
					connectionIndex += 1;
					if (connectionIndex === 1) {
						firstPeer = new FakePeer((method, payload) => {
							if (method !== productRpcMethods.sessionCreate) {
								return { events: [] };
							}
							commitCreate(payload);
							options.onClose?.(
								{ code: 1006, reason: "lost committed create response" },
								firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
							);
							throw new RpcConnectionClosedError(1006, "lost committed create response");
						});
						return firstPeer;
					}
					if (connectionIndex === 2) {
						return new FakePeer((method, payload) => {
							if (method !== productRpcMethods.sessionCreate) {
								return { events: [] };
							}
							receivedKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
							throw new RpcRemoteError("ambiguous-create-recovery", {
								code: remoteCode,
								message: "private ambiguous create detail",
							});
						});
					}
					return new FakePeer((method, payload) =>
						method === productRpcMethods.sessionCreate ? commitCreate(payload) : { events: [] },
					);
				},
				{ maxPendingSessionCreates: 1 },
			);
			await client.connect(createConnectOptions());

			await expect(client.createSession()).rejects.toBeInstanceOf(AgentsUnavailableError);
			const failedRecovery = await client
				.connect(createConnectOptions())
				.catch((error: unknown) => error);
			expect(failedRecovery).toBeInstanceOf(AgentsUnavailableError);
			expect((failedRecovery as Error).message).not.toContain("private");
			expect((failedRecovery as Error).message.length).toBeLessThan(128);

			await client.connect(createConnectOptions());
			const recovered = await client.createSession();
			expect(new Set(receivedKeys.slice(0, 3)).size).toBe(1);
			expect(durableCreates).toBe(1);
			expect(sessionsByKey.size).toBe(1);

			const next = await client.createSession();
			expect(next.session.id).not.toBe(recovered.session.id);
			expect(receivedKeys.at(-1)).not.toBe(receivedKeys[0]);
			expect(durableCreates).toBe(2);
			client.close();
		},
	);

	test("reconciles while the disconnected create execution is still unsettled", async () => {
		let resolveDisconnected: ((value: JsonValue) => void) | undefined;
		const createKeys: string[] = [];
		const firstPeer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			createKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
			return new Promise<JsonValue>((resolve) => {
				resolveDisconnected = resolve;
			});
		});
		const recoveredPayload = createSessionPayload(2);
		const recoveredSession = createChatSessionOutputSchema.parse(recoveredPayload);
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.sessionCreate) {
				createKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
				return recoveredPayload;
			}
			return { events: [] };
		});
		const peers = [firstPeer, recoveredPeer];
		let closeFirst: (() => void) | undefined;
		const client = new DesktopAgentsClient(async (options) => {
			const peer = peers.shift();
			if (peer === firstPeer) {
				closeFirst = () => {
					options.onClose?.(
						{ code: 1006, reason: "disconnected create" },
						firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
				};
			}
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		await client.connect(createConnectOptions());

		const originalCreate = client.createSession();
		while (resolveDisconnected === undefined) {
			await Promise.resolve();
		}
		closeFirst?.();
		await client.connect(createConnectOptions());
		await expect(client.createSession()).resolves.toEqual(recoveredSession);
		resolveDisconnected(recoveredPayload);
		await expect(originalCreate).resolves.toEqual(recoveredSession);
		expect(createKeys).toHaveLength(2);
		expect(new Set(createKeys).size).toBe(1);
		client.close();
	});

	test("shares one create key across concurrent callers", async () => {
		const createKey = crypto.randomUUID();
		let remoteCreateCalls = 0;
		let resolveCreate: ((value: JsonValue) => void) | undefined;
		const peer = new FakePeer((method) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			remoteCreateCalls += 1;
			return new Promise<JsonValue>((resolve) => {
				resolveCreate = resolve;
			});
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());

		const first = client.createSession(createKey);
		const concurrent = client.createSession(createKey);
		expect(remoteCreateCalls).toBe(1);
		resolveCreate?.(createSessionPayload(1));
		expect(await concurrent).toEqual(await first);
		client.close();
	});

	test("releases a create key after definitive rejection and allocates a new implicit key", async () => {
		const receivedKeys: string[] = [];
		let createCalls = 0;
		const peer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			const input = createProcessChatSessionInputSchema.parse(payload);
			receivedKeys.push(input.createKey);
			createCalls += 1;
			if (createCalls === 1) {
				throw new RpcRemoteError("rejected-create", {
					code: "SESSION_CREATE_CAPACITY",
					message: "definitive rejection",
				});
			}
			return createSessionPayload(1);
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());

		await expect(client.createSession()).rejects.toBeInstanceOf(RpcRemoteError);
		await expect(client.createSession()).resolves.toBeDefined();
		expect(receivedKeys[1]).not.toBe(receivedKeys[0]);
		client.close();
	});

	test.each(["INVALID_ARGUMENT", "SESSION_CREATE_KEY_CONFLICT", "SESSION_CREATE_CAPACITY"])(
		"releases an ambiguous Session create after definitive %s reconciliation",
		async (remoteCode) => {
			const receivedKeys: string[] = [];
			let connectionIndex = 0;
			let recoveredCreateCalls = 0;
			let firstPeer: FakePeer;
			const recoveredPeer = new FakePeer((method, payload) => {
				if (method !== productRpcMethods.sessionCreate) {
					return { events: [] };
				}
				receivedKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
				recoveredCreateCalls += 1;
				if (recoveredCreateCalls === 1) {
					throw new RpcRemoteError("definitive-create-recovery", {
						code: remoteCode,
						message: "definitive precommit rejection",
					});
				}
				return createSessionPayload(1);
			});
			const client = new DesktopAgentsClient(
				async (options) => {
					if (connectionIndex++ > 0) {
						return recoveredPeer;
					}
					firstPeer = new FakePeer((method, payload) => {
						if (method !== productRpcMethods.sessionCreate) {
							return { events: [] };
						}
						receivedKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
						options.onClose?.(
							{ code: 1006, reason: "lost before create commit" },
							firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "lost before create commit");
					});
					return firstPeer;
				},
				{ maxPendingSessionCreates: 1 },
			);
			await client.connect(createConnectOptions());

			await expect(client.createSession()).rejects.toBeInstanceOf(AgentsUnavailableError);
			await client.connect(createConnectOptions());
			await expect(client.createSession()).resolves.toBeDefined();
			expect(receivedKeys).toHaveLength(3);
			expect(receivedKeys[1]).toBe(receivedKeys[0]);
			expect(receivedKeys[2]).not.toBe(receivedKeys[0]);
			client.close();
		},
	);

	test("releases a never-dispatched Session create after a local request-limit failure", async () => {
		const receivedKeys: string[] = [];
		let createCalls = 0;
		const peer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			receivedKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
			createCalls += 1;
			if (createCalls === 1) {
				throw new RpcRequestLimitError(1);
			}
			return createSessionPayload(1);
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});
		await client.connect(createConnectOptions());

		await expect(client.createSession()).rejects.toBeInstanceOf(RpcRequestLimitError);
		await expect(client.createSession()).resolves.toBeDefined();
		expect(receivedKeys).toHaveLength(2);
		expect(receivedKeys[1]).not.toBe(receivedKeys[0]);
		client.close();
	});

	test("retains an ambiguous Session create across a local retry rejection and reconciles one durable Session", async () => {
		const sessionsByKey = new Map<string, JsonValue>();
		const receivedKeys: string[] = [];
		let committedSessions = 0;
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		const localRetryPeer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			receivedKeys.push(createProcessChatSessionInputSchema.parse(payload).createKey);
			throw new RpcRequestLimitError(1);
		});
		const durablePeer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			const input = createProcessChatSessionInputSchema.parse(payload);
			receivedKeys.push(input.createKey);
			let output = sessionsByKey.get(input.createKey);
			if (output === undefined) {
				committedSessions += 1;
				output = createSessionPayload(committedSessions);
				sessionsByKey.set(input.createKey, output);
			}
			return output;
		});
		const client = new DesktopAgentsClient(
			async (options) => {
				connectionIndex += 1;
				if (connectionIndex === 1) {
					firstPeer = new FakePeer((method, payload) => {
						if (method !== productRpcMethods.sessionCreate) {
							return { events: [] };
						}
						const input = createProcessChatSessionInputSchema.parse(payload);
						receivedKeys.push(input.createKey);
						if (!sessionsByKey.has(input.createKey)) {
							committedSessions += 1;
							sessionsByKey.set(input.createKey, createSessionPayload(committedSessions));
						}
						options.onClose?.(
							{ code: 1006, reason: "ambiguous create" },
							firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "ambiguous create");
					});
					return firstPeer;
				}
				return connectionIndex === 2 ? localRetryPeer : durablePeer;
			},
			{ maxPendingSessionCreates: 1 },
		);
		await client.connect(createConnectOptions());

		await expect(client.createSession()).rejects.toBeInstanceOf(AgentsUnavailableError);
		const locallyRejectedRecovery = await client.connect(createConnectOptions());
		expect(receivedKeys).toHaveLength(2);
		expect(new Set(receivedKeys).size).toBe(1);
		await expect(client.createSession(crypto.randomUUID())).rejects.toThrow(
			"pending Session create recovery limit",
		);

		locallyRejectedRecovery.close();
		await client.connect(createConnectOptions());
		await expect(client.createSession()).resolves.toBeDefined();
		expect(receivedKeys.slice(0, 3)).toHaveLength(3);
		expect(new Set(receivedKeys.slice(0, 3)).size).toBe(1);
		expect(committedSessions).toBe(1);
		expect(sessionsByKey.size).toBe(1);

		await expect(client.createSession()).resolves.toBeDefined();
		expect(committedSessions).toBe(2);
		client.close();
	});

	test("does not let late Session create cleanup release a newer same-key reservation", async () => {
		const createKey = crypto.randomUUID();
		const recoveredPayload = createSessionPayload(1);
		let resolveOriginal: ((payload: JsonValue) => void) | undefined;
		let resolveNewer: ((payload: JsonValue) => void) | undefined;
		let disconnectFirst: (() => void) | undefined;
		let firstPeer: FakePeer;
		let recoveredCreateCalls = 0;
		const recoveredPeer = new FakePeer((method) => {
			if (method !== productRpcMethods.sessionCreate) {
				return { events: [] };
			}
			recoveredCreateCalls += 1;
			if (recoveredCreateCalls === 1) {
				return recoveredPayload;
			}
			return new Promise<JsonValue>((resolve) => {
				resolveNewer = resolve;
			});
		});
		let connectionIndex = 0;
		const client = new DesktopAgentsClient(
			async (options) => {
				connectionIndex += 1;
				if (connectionIndex > 1) {
					return recoveredPeer;
				}
				firstPeer = new FakePeer((method) => {
					if (method !== productRpcMethods.sessionCreate) {
						return { events: [] };
					}
					return new Promise<JsonValue>((resolve) => {
						resolveOriginal = resolve;
					});
				});
				disconnectFirst = () =>
					options.onClose?.(
						{ code: 1006, reason: "original create still settling" },
						firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
				return firstPeer;
			},
			{ maxPendingSessionCreates: 1 },
		);
		await client.connect(createConnectOptions());

		const original = client.createSession(createKey);
		while (resolveOriginal === undefined) {
			await Promise.resolve();
		}
		disconnectFirst?.();
		await client.connect(createConnectOptions());
		await expect(client.createSession(createKey)).resolves.toBeDefined();

		const newer = client.createSession(createKey);
		while (resolveNewer === undefined) {
			await Promise.resolve();
		}
		resolveOriginal(recoveredPayload);
		await expect(original).resolves.toBeDefined();
		await expect(client.createSession(crypto.randomUUID())).rejects.toThrow(
			"pending Session create recovery limit",
		);
		resolveNewer(recoveredPayload);
		await expect(newer).resolves.toBeDefined();
		client.close();
	});

	test("bounds retained Session create keys separately from Chat send reservations", async () => {
		const peer = new FakePeer((method) =>
			method === productRpcMethods.sessionCreate ? createSessionPayload(1) : { events: [] },
		);
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});
		const createKey = crypto.randomUUID();

		await expect(client.createSession(createKey)).rejects.toBeInstanceOf(AgentsUnavailableError);
		await expect(client.createSession(crypto.randomUUID())).rejects.toThrow(
			"pending Session create recovery limit",
		);
		await client.connect(createConnectOptions());
		await expect(client.createSession(crypto.randomUUID())).rejects.toThrow(
			"pending Session create recovery limit",
		);
		await expect(client.createSession(createKey)).resolves.toBeDefined();
		await expect(client.createSession(crypto.randomUUID())).resolves.toBeDefined();
		client.close();
	});

	test("counts a recovered Session create only once against capacity", async () => {
		const peer = new FakePeer((method) =>
			method === productRpcMethods.sessionCreate ? createSessionPayload(1) : { events: [] },
		);
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 2,
		});
		const recoveredKey = crypto.randomUUID();
		await expect(client.createSession(recoveredKey)).rejects.toBeInstanceOf(AgentsUnavailableError);
		await client.connect(createConnectOptions());

		await expect(client.createSession(crypto.randomUUID())).resolves.toBeDefined();
		await expect(client.createSession(recoveredKey)).resolves.toBeDefined();
		client.close();
	});

	test("evicts a recovered Session create when that Session is deleted and reclaims capacity", async () => {
		const createKey = crypto.randomUUID();
		let createCalls = 0;
		const peer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.sessionCreate) {
				createCalls += 1;
				return createSessionPayload(createCalls);
			}
			if (method === productRpcMethods.sessionDelete) {
				return { sessionId: deleteChatSessionInputSchema.parse(payload).sessionId };
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});

		await expect(client.createSession(createKey)).rejects.toBeInstanceOf(AgentsUnavailableError);
		await client.connect(createConnectOptions());
		const retiredOutput = createChatSessionOutputSchema.parse(createSessionPayload(1));
		await client.request(
			productRpcMethods.sessionDelete,
			{ sessionId: retiredOutput.session.id },
			deleteChatSessionInputSchema,
			deleteChatSessionOutputSchema,
		);

		const retried = await client.createSession(createKey);
		expect(retried.session.id).toBe(
			createChatSessionOutputSchema.parse(createSessionPayload(2)).session.id,
		);
		expect(createCalls).toBe(2);
		await expect(client.createSession(crypto.randomUUID())).resolves.toBeDefined();
		client.close();
	});

	test("rejects a pending create that binds to a retired Session without releasing newer state", async () => {
		const createKey = crypto.randomUUID();
		const retiredOutput = createChatSessionOutputSchema.parse(createSessionPayload(1));
		let resolveCreate: ((payload: JsonValue) => void) | undefined;
		let createCalls = 0;
		const peer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.sessionCreate) {
				createCalls += 1;
				if (createCalls === 1) {
					return new Promise<JsonValue>((resolve) => {
						resolveCreate = resolve;
					});
				}
				return createSessionPayload(2);
			}
			if (method === productRpcMethods.sessionDelete) {
				return { sessionId: deleteChatSessionInputSchema.parse(payload).sessionId };
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});
		await client.connect(createConnectOptions());

		const pending = client.createSession(createKey);
		while (resolveCreate === undefined) {
			await Promise.resolve();
		}
		await client.request(
			productRpcMethods.sessionDelete,
			{ sessionId: retiredOutput.session.id },
			deleteChatSessionInputSchema,
			deleteChatSessionOutputSchema,
		);
		await expect(client.createSession(crypto.randomUUID())).rejects.toThrow(
			"pending Session create recovery limit",
		);
		resolveCreate(createSessionPayload(1));
		await expect(pending).rejects.toBeInstanceOf(ChatSessionNotFoundError);

		await expect(client.createSession(crypto.randomUUID())).resolves.toMatchObject({
			session: { id: createChatSessionOutputSchema.parse(createSessionPayload(2)).session.id },
		});
		expect(createCalls).toBe(2);
		client.close();
	});

	test("evicts recovered create state when a typed Session miss retires its output", async () => {
		const createKey = crypto.randomUUID();
		let createCalls = 0;
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionCreate) {
				createCalls += 1;
				return createSessionPayload(createCalls);
			}
			if (method === productRpcMethods.sessionGet) {
				throw createSessionNotFoundRemoteError(method);
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});
		await expect(client.createSession(createKey)).rejects.toBeInstanceOf(AgentsUnavailableError);
		await client.connect(createConnectOptions());
		const recoveredSessionId = createChatSessionOutputSchema.parse(createSessionPayload(1)).session
			.id;

		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId: recoveredSessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		await expect(client.createSession(createKey)).resolves.toMatchObject({
			session: { id: createChatSessionOutputSchema.parse(createSessionPayload(2)).session.id },
		});
		expect(createCalls).toBe(2);
		client.close();
	});

	test("generation-fences a pending create that resolves to a typed-missing Session", async () => {
		const createKey = crypto.randomUUID();
		let resolveCreate: ((payload: JsonValue) => void) | undefined;
		let createCalls = 0;
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionCreate) {
				createCalls += 1;
				if (createCalls === 1) {
					return new Promise<JsonValue>((resolve) => {
						resolveCreate = resolve;
					});
				}
				return createSessionPayload(2);
			}
			if (method === productRpcMethods.sessionGet) {
				throw createSessionNotFoundRemoteError(method);
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxPendingSessionCreates: 1,
		});
		await client.connect(createConnectOptions());
		const pending = client.createSession(createKey);
		while (resolveCreate === undefined) {
			await Promise.resolve();
		}
		const pendingSessionId = createChatSessionOutputSchema.parse(createSessionPayload(1)).session
			.id;
		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId: pendingSessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		resolveCreate(createSessionPayload(1));

		await expect(pending).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		await expect(client.createSession(crypto.randomUUID())).resolves.toMatchObject({
			session: { id: createChatSessionOutputSchema.parse(createSessionPayload(2)).session.id },
		});
		expect(createCalls).toBe(2);
		client.close();
	});

	test("keeps Session create keys independent from Chat send request IDs", async () => {
		const sharedKey = crypto.randomUUID();
		const methods: string[] = [];
		const peer = new FakePeer((method) => {
			methods.push(method);
			if (method === productRpcMethods.sessionCreate) {
				return createSessionPayload(1);
			}
			if (method === productRpcMethods.chatSend) {
				return createTerminalAcceptedPayload();
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());

		await client.createSession(sharedKey);
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: sharedKey, sessionId, content: "independent keys" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		expect(methods).toEqual([productRpcMethods.sessionCreate, productRpcMethods.chatSend]);
		client.close();
	});

	test("maps a conclusive remote Session miss without relabeling it unavailable", async () => {
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionGet) {
				throw new RpcRemoteError("session-get", {
					code: "SESSION_NOT_FOUND",
					message: "The chat Session was not found.",
				});
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());

		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		client.close();
	});

	test.each([
		[
			"get",
			productRpcMethods.sessionGet,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.sessionGet,
					{ sessionId, limit: 2 },
					getChatSessionPageInputSchema,
					getChatSessionPageOutputSchema,
				),
		],
		[
			"update",
			productRpcMethods.sessionUpdate,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.sessionUpdate,
					{ sessionId, title: "Missing" },
					updateChatSessionInputSchema,
					updateChatSessionOutputSchema,
				),
		],
		[
			"archive",
			productRpcMethods.sessionArchive,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.sessionArchive,
					{ sessionId, archived: true },
					setChatSessionArchivedInputSchema,
					setChatSessionArchivedOutputSchema,
				),
		],
		[
			"delete",
			productRpcMethods.sessionDelete,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.sessionDelete,
					{ sessionId },
					deleteChatSessionInputSchema,
					deleteChatSessionOutputSchema,
				),
		],
		[
			"send",
			productRpcMethods.chatSend,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.chatSend,
					{ requestId: crypto.randomUUID(), sessionId, content: "missing send" },
					sendAskChatMessageInputSchema,
					chatSendAcceptedOutputSchema,
				),
		],
		[
			"cancel",
			productRpcMethods.chatCancel,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.chatCancel,
					{ runId: otherRunId, reason: "missing cancel" },
					cancelChatRunInputSchema,
					cancelChatRunOutputSchema,
					sessionId,
				),
		],
		[
			"replay",
			productRpcMethods.chatReplay,
			(client: DesktopAgentsClient) =>
				client.request(
					productRpcMethods.chatReplay,
					{ cursors: [{ runId, sessionId, issuedAtMs: 1_000, lastSeq: 0 }] },
					replayChatEventsInputSchema,
					replayChatEventsOutputSchema,
				),
		],
	] as const)(
		"retires exact recovery state before surfacing a typed miss from public Session %s",
		async (_name, missedMethod, invokeMiss) => {
			const missedPeer = new FakePeer((method, payload) => {
				if (
					method === productRpcMethods.chatSend &&
					sendAskChatMessageInputSchema.parse(payload).content === "seed recovery state"
				) {
					return createAcceptedPayload();
				}
				if (method === missedMethod) {
					throw createSessionNotFoundRemoteError(method);
				}
				return { events: [] };
			});
			const replayedSessionIds: string[] = [];
			const recoveredPeer = new FakePeer((method, payload) => {
				if (method === productRpcMethods.chatReplay) {
					replayedSessionIds.push(
						...replayChatEventsInputSchema.parse(payload).cursors.map((cursor) => cursor.sessionId),
					);
				}
				return { events: [] };
			});
			const peers = [missedPeer, recoveredPeer];
			const client = new DesktopAgentsClient(async () => {
				const peer = peers.shift();
				return peer ?? Promise.reject(new Error("No fake peer available."));
			});
			const connection = await client.connect(createConnectOptions());
			await client.request(
				productRpcMethods.chatSend,
				{ requestId: clientRequestId, sessionId, content: "seed recovery state" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			);

			const error = await invokeMiss(client).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(ChatSessionNotFoundError);
			expect((error as ChatSessionNotFoundError).code).toBe("SESSION_NOT_FOUND");
			connection.close();
			await client.connect(createConnectOptions());
			expect(replayedSessionIds).toEqual([]);
			client.close();
		},
	);

	test.each([
		["a typed miss for another Session", otherSessionId, "SESSION_NOT_FOUND"],
		["an unrelated remote error", sessionId, "INTERNAL_ERROR"],
	] as const)("keeps exact recovery state after %s", async (_name, missedSessionId, code) => {
		const firstPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatSend) {
				return createAcceptedPayload();
			}
			if (method === productRpcMethods.sessionGet) {
				throw new RpcRemoteError("session-get", {
					code,
					message: code === "SESSION_NOT_FOUND" ? "missing" : "unrelated failure",
				});
			}
			return { events: [] };
		});
		const replayedSessionIds: string[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				replayedSessionIds.push(
					...replayChatEventsInputSchema.parse(payload).cursors.map((cursor) => cursor.sessionId),
				);
			}
			return { events: [] };
		});
		const peers = [firstPeer, recoveredPeer];
		const client = new DesktopAgentsClient(async () => {
			const peer = peers.shift();
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const connection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "keep exact state" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);

		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId: missedSessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeDefined();
		connection.close();
		await client.connect(createConnectOptions());
		expect(replayedSessionIds).toEqual([sessionId]);
		client.close();
	});

	test("handles repeated typed misses idempotently without another remote dispatch", async () => {
		let remoteMisses = 0;
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionGet || method === productRpcMethods.sessionUpdate) {
				remoteMisses += 1;
				throw createSessionNotFoundRemoteError(method);
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());

		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		await expect(
			client.request(
				productRpcMethods.sessionUpdate,
				{ sessionId, title: "Still missing" },
				updateChatSessionInputSchema,
				updateChatSessionOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		expect(remoteMisses).toBe(1);
		client.close();
	});

	test("uses a hydrated active-Run route to retire the exact Session after cancel misses", async () => {
		let remoteUpdates = 0;
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionGet) {
				const page = getChatSessionPageOutputSchema.parse(createSessionPagePayload());
				const accepted = chatSendAcceptedOutputSchema.parse(createAcceptedPayload());
				return rpcJsonValueSchema.parse({ ...page, runs: [accepted.run] });
			}
			if (method === productRpcMethods.chatCancel) {
				throw createSessionNotFoundRemoteError(method);
			}
			if (method === productRpcMethods.sessionUpdate) {
				remoteUpdates += 1;
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer);
		await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.sessionGet,
			{ sessionId, limit: 2 },
			getChatSessionPageInputSchema,
			getChatSessionPageOutputSchema,
		);

		await expect(
			client.request(
				productRpcMethods.chatCancel,
				{ runId, reason: "missing" },
				cancelChatRunInputSchema,
				cancelChatRunOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		await expect(
			client.request(
				productRpcMethods.sessionUpdate,
				{ sessionId, title: "Do not dispatch" },
				updateChatSessionInputSchema,
				updateChatSessionOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		expect(remoteUpdates).toBe(0);
		client.close();
	});

	test("does not let a late send response recreate state after a concurrent typed miss", async () => {
		let resolveSend: ((payload: JsonValue) => void) | undefined;
		const firstPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatSend) {
				return new Promise<JsonValue>((resolve) => {
					resolveSend = resolve;
				});
			}
			if (method === productRpcMethods.sessionGet) {
				throw createSessionNotFoundRemoteError(method);
			}
			return { events: [] };
		});
		let replayCalls = 0;
		const recoveredPeer = new FakePeer((method, payload) => {
			if (
				method === productRpcMethods.chatReplay &&
				replayChatEventsInputSchema.parse(payload).cursors.length > 0
			) {
				replayCalls += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, recoveredPeer];
		const client = new DesktopAgentsClient(async () => {
			const peer = peers.shift();
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const connection = await client.connect(createConnectOptions());
		const send = client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "late send" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		while (resolveSend === undefined) {
			await Promise.resolve();
		}
		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		resolveSend(createAcceptedPayload());

		await expect(send).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		connection.close();
		await client.connect(createConnectOptions());
		expect(replayCalls).toBe(0);
		client.close();
	});

	test.each([
		"maxTrackedRunCursors",
		"maxPendingSessionCreates",
		"maxProvisionalEvents",
		"maxProvisionalBytes",
		"recoveryTimeoutMs",
	] as const)("requires a positive safe integer for %s", (name) => {
		expect(
			() => new DesktopAgentsClient(async () => Promise.reject(new Error("unused")), { [name]: 0 }),
		).toThrow("positive safe integer");
	});

	test.each([
		["synchronous replay validation", () => ({ events: [{ invalid: true }] })],
		["asynchronous replay rejection", () => Promise.reject(new Error("replay rejected"))],
		[
			"remote replay error",
			() =>
				Promise.reject(
					new RpcRemoteError("replay-request", {
						code: "INTERNAL_ERROR",
						message: "remote replay failed",
					}),
				),
		],
	])("cleans a provisional peer after %s and reconnects immediately", async (_name, failReplay) => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const failedPeer = new FakePeer((method) =>
			method === productRpcMethods.chatReplay ? failReplay() : { events: [] },
		);
		const recoveredPeer = new FakePeer(() => ({ events: [] }));
		const peers = [firstPeer, failedPeer, recoveredPeer];
		let connectionIndex = 0;
		let leakedEvents = 0;
		const client = new DesktopAgentsClient(async (options) => {
			const peer = peers[connectionIndex];
			if (peer === undefined) {
				throw new Error("No fake peer available.");
			}
			if (connectionIndex === 1) {
				await emitProvisionalEvent(options);
			}
			connectionIndex += 1;
			return peer;
		});
		client.subscribeChatEvents(() => {
			leakedEvents += 1;
		});

		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(failedPeer.closeCalls).toBe(1);
		expect(leakedEvents).toBe(0);
		await expect(client.connect(createConnectOptions())).resolves.toBeDefined();
		expect(recoveredPeer.closeCalls).toBe(0);
		client.close();
	});

	test("rejects a server whose instance or generation differs from READY", async () => {
		const mismatchedPeer = new FakePeer(() => ({ events: [] }), {
			role: "agents",
			peerId: "moshu-local-agents",
			instanceId: "wrong-instance",
			generation: 2,
		});
		const recoveredPeer = new FakePeer(() => ({ events: [] }));
		const peers = [mismatchedPeer, recoveredPeer];
		let index = 0;
		const client = new DesktopAgentsClient(async () => {
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(mismatchedPeer.closeCalls).toBe(1);
		await expect(client.connect(createConnectOptions())).resolves.toBeDefined();
		client.close();
	});

	test("reserves cursor capacity before concurrent Chat sends reach the server", async () => {
		let resolveAccepted: ((payload: JsonValue) => void) | undefined;
		let requestStarted: (() => void) | undefined;
		const requestStartedPromise = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		let remoteSendCalls = 0;
		const peer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			remoteSendCalls += 1;
			requestStarted?.();
			return new Promise<JsonValue>((resolve) => {
				resolveAccepted = resolve;
			});
		});
		const client = new DesktopAgentsClient(async () => peer, {
			maxTrackedRunCursors: 1,
		});
		await client.connect(createConnectOptions());

		const firstSend = client.request(
			productRpcMethods.chatSend,
			{ requestId: crypto.randomUUID(), sessionId, content: "first" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		await requestStartedPromise;
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "second" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(AgentsUnavailableError);
		expect(remoteSendCalls).toBe(1);
		resolveAccepted?.(createAcceptedPayload());
		await expect(firstSend).resolves.toBeDefined();
		client.close();
	});

	test("releases capacity after a definite local pre-dispatch failure", async () => {
		let sendCalls = 0;
		const peer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			sendCalls += 1;
			if (sendCalls === 1) {
				throw new RpcRequestLimitError(1);
			}
			return createAcceptedPayload();
		});
		const client = new DesktopAgentsClient(async () => peer, { maxTrackedRunCursors: 1 });
		await client.connect(createConnectOptions());

		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "locally rejected" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(RpcRequestLimitError);
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "capacity recovered" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toBeDefined();
		expect(sendCalls).toBe(2);
		client.close();
	});

	test("releases capacity for a definitive precommit response even when close races it", async () => {
		let connectionIndex = 0;
		const recoveredPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const client = new DesktopAgentsClient(
			async (options) => {
				if (connectionIndex > 0) {
					connectionIndex += 1;
					return recoveredPeer;
				}
				connectionIndex += 1;
				let failedPeer: FakePeer;
				failedPeer = new FakePeer((method) => {
					if (method !== productRpcMethods.chatSend) {
						return { events: [] };
					}
					options.onClose?.(
						{ code: 1011, reason: "response then close" },
						failedPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
					throw new RpcRemoteError("remote-send", {
						code: "AGENTS_NOT_READY",
						message: "definitive rejection",
					});
				});
				return failedPeer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());

		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "remote failure" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(RpcRemoteError);
		await client.connect(createConnectOptions());
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "after reconnect" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toBeDefined();
		client.close();
	});

	test("reconciles an unbound lost-response reservation and releases capacity", async () => {
		const input = { requestId: clientRequestId, sessionId, content: "lost response" };
		const recoveredInputs: JsonValue[] = [];
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatSend) {
				recoveredInputs.push(payload);
				return createTerminalAcceptedPayload();
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(
			async (options) => {
				if (connectionIndex > 0) {
					connectionIndex += 1;
					return recoveredPeer;
				}
				connectionIndex += 1;
				firstPeer = new FakePeer((method) => {
					if (method !== productRpcMethods.chatSend) {
						return { events: [] };
					}
					options.onClose?.(
						{ code: 1006, reason: "private socket detail" },
						firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
					throw new RpcConnectionClosedError(1006, "private socket detail");
				});
				return firstPeer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());

		const unavailable = await client
			.request(
				productRpcMethods.chatSend,
				input,
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			)
			.catch((error: unknown) => error);
		expect(unavailable).toBeInstanceOf(AgentsUnavailableError);
		expect((unavailable as Error).message).not.toContain("private socket detail");
		await client.connect(createConnectOptions());
		expect(recoveredInputs[0]).toEqual(input);
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "unrelated" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toBeDefined();
		expect(recoveredInputs).toHaveLength(2);
		client.close();
	});

	test.each(["INTERNAL_ERROR", productRpcInternalHandlerErrorCode, "FUTURE_REMOTE_ERROR"])(
		"retains an ambiguous Chat send after %s and reconciles the exact durable key",
		async (remoteCode) => {
			const input = { requestId: clientRequestId, sessionId, content: "lost response" };
			const sendsByRequestId = new Map<string, JsonValue>();
			const receivedRequestIds: string[] = [];
			let durableSends = 0;
			let connectionIndex = 0;
			let firstPeer: FakePeer;
			const commitSend = (payload: JsonValue): JsonValue => {
				const parsedInput = sendAskChatMessageInputSchema.parse(payload);
				receivedRequestIds.push(parsedInput.requestId);
				let output = sendsByRequestId.get(parsedInput.requestId);
				if (output === undefined) {
					durableSends += 1;
					output = createTerminalAcceptedPayload();
					sendsByRequestId.set(parsedInput.requestId, output);
				}
				return output;
			};
			const client = new DesktopAgentsClient(
				async (options) => {
					connectionIndex += 1;
					if (connectionIndex === 1) {
						firstPeer = new FakePeer((method, payload) => {
							if (method !== productRpcMethods.chatSend) {
								return { events: [] };
							}
							commitSend(payload);
							options.onClose?.(
								{ code: 1006, reason: "lost committed send response" },
								firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
							);
							throw new RpcConnectionClosedError(1006, "lost committed send response");
						});
						return firstPeer;
					}
					if (connectionIndex === 2) {
						return new FakePeer((method, payload) => {
							if (method !== productRpcMethods.chatSend) {
								return { events: [] };
							}
							receivedRequestIds.push(sendAskChatMessageInputSchema.parse(payload).requestId);
							throw new RpcRemoteError("ambiguous-send-recovery", {
								code: remoteCode,
								message: "private ambiguous send detail",
							});
						});
					}
					return new FakePeer((method, payload) =>
						method === productRpcMethods.chatSend ? commitSend(payload) : { events: [] },
					);
				},
				{ maxTrackedRunCursors: 1 },
			);
			await client.connect(createConnectOptions());

			await expect(
				client.request(
					productRpcMethods.chatSend,
					input,
					sendAskChatMessageInputSchema,
					chatSendAcceptedOutputSchema,
				),
			).rejects.toBeInstanceOf(AgentsUnavailableError);
			const failedRecovery = await client
				.connect(createConnectOptions())
				.catch((error: unknown) => error);
			expect(failedRecovery).toBeInstanceOf(AgentsUnavailableError);
			expect((failedRecovery as Error).message).not.toContain("private");
			expect((failedRecovery as Error).message.length).toBeLessThan(128);

			await client.connect(createConnectOptions());
			expect(new Set(receivedRequestIds.slice(0, 3))).toEqual(new Set([clientRequestId]));
			expect(durableSends).toBe(1);
			expect(sendsByRequestId.size).toBe(1);

			await expect(
				client.request(
					productRpcMethods.chatSend,
					{ requestId: crypto.randomUUID(), sessionId, content: "capacity recovered" },
					sendAskChatMessageInputSchema,
					chatSendAcceptedOutputSchema,
				),
			).resolves.toBeDefined();
			expect(durableSends).toBe(2);
			client.close();
		},
	);

	test.each(["INVALID_ARGUMENT", "AGENTS_NOT_READY"])(
		"releases an unbound reservation after definitive %s reconciliation",
		async (remoteCode) => {
			let connectionIndex = 0;
			let firstPeer: FakePeer;
			let sendCalls = 0;
			const recoveredPeer = new FakePeer((method) => {
				if (method !== productRpcMethods.chatSend) {
					return { events: [] };
				}
				sendCalls += 1;
				if (sendCalls === 1) {
					throw new RpcRemoteError("reconcile", {
						code: remoteCode,
						message: "definitive precommit rejection",
					});
				}
				return createTerminalAcceptedPayload();
			});
			const client = new DesktopAgentsClient(
				async (options) => {
					if (connectionIndex++ > 0) {
						return recoveredPeer;
					}
					firstPeer = new FakePeer((method) => {
						if (method !== productRpcMethods.chatSend) {
							return { events: [] };
						}
						options.onClose?.(
							{ code: 1006, reason: "lost" },
							firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "lost");
					});
					return firstPeer;
				},
				{ maxTrackedRunCursors: 1 },
			);
			await client.connect(createConnectOptions());
			await expect(
				client.request(
					productRpcMethods.chatSend,
					{ requestId: clientRequestId, sessionId, content: "never reached" },
					sendAskChatMessageInputSchema,
					chatSendAcceptedOutputSchema,
				),
			).rejects.toBeInstanceOf(AgentsUnavailableError);

			await client.connect(createConnectOptions());
			await expect(
				client.request(
					productRpcMethods.chatSend,
					{ requestId: crypto.randomUUID(), sessionId, content: "after rejection" },
					sendAskChatMessageInputSchema,
					chatSendAcceptedOutputSchema,
				),
			).resolves.toBeDefined();
			expect(sendCalls).toBe(2);
			client.close();
		},
	);

	test("globally retires an ambiguous send when reconciliation receives a typed miss", async () => {
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		let remoteUpdates = 0;
		const recoveredPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatSend) {
				throw createSessionNotFoundRemoteError(method);
			}
			if (method === productRpcMethods.sessionUpdate) {
				remoteUpdates += 1;
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async (options) => {
			if (connectionIndex++ > 0) {
				return recoveredPeer;
			}
			firstPeer = new FakePeer((method) => {
				if (method !== productRpcMethods.chatSend) {
					return { events: [] };
				}
				options.onClose?.(
					{ code: 1006, reason: "lost" },
					firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
				);
				throw new RpcConnectionClosedError(1006, "lost");
			});
			return firstPeer;
		});
		const invalidations: string[] = [];
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidations.push(`${invalidation.reason}:${invalidation.sessionId}`);
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: true,
			});
		});
		await client.connect(createConnectOptions());
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: clientRequestId, sessionId, content: "lost response" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(AgentsUnavailableError);

		await client.connect(createConnectOptions());
		expect(invalidations).toEqual([`session_retired:${sessionId}`]);
		await expect(
			client.request(
				productRpcMethods.sessionUpdate,
				{ sessionId, title: "Do not dispatch" },
				updateChatSessionInputSchema,
				updateChatSessionOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		expect(remoteUpdates).toBe(0);
		client.close();
	});

	test("retains same-key content validation after an ambiguous timeout", async () => {
		let sendCalls = 0;
		const peer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			sendCalls += 1;
			if (sendCalls === 1) {
				throw new RpcTimeoutError("private-request-id", 15_000);
			}
			return createTerminalAcceptedPayload();
		});
		const client = new DesktopAgentsClient(async () => peer, { maxTrackedRunCursors: 1 });
		await client.connect(createConnectOptions());
		const input = { requestId: clientRequestId, sessionId, content: "same content" };

		const timeout = await client
			.request(
				productRpcMethods.chatSend,
				input,
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			)
			.catch((error: unknown) => error);
		expect(timeout).toBeInstanceOf(AgentsUnavailableError);
		expect((timeout as Error).message).not.toContain("private-request-id");
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ ...input, content: "different content" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toThrow("reused for different content");
		await expect(
			client.request(
				productRpcMethods.chatSend,
				input,
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toBeDefined();
		expect(sendCalls).toBe(2);
		client.close();
	});

	test("consumes terminal provisional events before reconciling an unbound reservation", async () => {
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		let recoveredSendCalls = 0;
		const recoveredPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatSend) {
				recoveredSendCalls += 1;
				return createTerminalAcceptedPayload();
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(
			async (options) => {
				if (connectionIndex++ === 0) {
					firstPeer = new FakePeer((method) => {
						if (method !== productRpcMethods.chatSend) {
							return { events: [] };
						}
						options.onClose?.(
							{ code: 1006, reason: "lost" },
							firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "lost");
					});
					return firstPeer;
				}
				const handler = options.handlers?.events?.[agentsProductEventMethods[0]];
				if (handler === undefined) {
					throw new Error("Chat event handler was not installed.");
				}
				for (const event of createTerminalReplayEvents()) {
					await handler(
						rpcJsonValueSchema.parse({ clientRequestId, event }),
						{} as RpcEventContext,
					);
				}
				return recoveredPeer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: clientRequestId, sessionId, content: "terminal first" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(AgentsUnavailableError);

		await client.connect(createConnectOptions());
		expect(recoveredSendCalls).toBe(0);
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: crypto.randomUUID(), sessionId, content: "after terminal" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		expect(recoveredSendCalls).toBe(1);
		client.close();
	});

	test("retains an unbound reservation when the reconciliation connection closes", async () => {
		let connectionIndex = 0;
		let firstPeer: FakePeer;
		let closingPeer: FakePeer;
		const reconciledContents: string[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatSend) {
				reconciledContents.push(sendAskChatMessageInputSchema.parse(payload).content);
				return createTerminalAcceptedPayload();
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(
			async (options) => {
				connectionIndex += 1;
				if (connectionIndex === 1) {
					firstPeer = new FakePeer((method) => {
						if (method !== productRpcMethods.chatSend) {
							return { events: [] };
						}
						options.onClose?.(
							{ code: 1006, reason: "initial close" },
							firstPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "initial close");
					});
					return firstPeer;
				}
				if (connectionIndex === 2) {
					closingPeer = new FakePeer((method, payload) => {
						if (method !== productRpcMethods.chatSend) {
							return { events: [] };
						}
						reconciledContents.push(sendAskChatMessageInputSchema.parse(payload).content);
						options.onClose?.(
							{ code: 1006, reason: "reconcile close" },
							closingPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
						);
						throw new RpcConnectionClosedError(1006, "reconcile close");
					});
					return closingPeer;
				}
				return recoveredPeer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: clientRequestId, sessionId, content: "retry me" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(AgentsUnavailableError);

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		await client.connect(createConnectOptions());
		expect(reconciledContents).toEqual(["retry me", "retry me"]);
		client.close();
	});

	test("maps transport closure before or after onClose without relabeling remote or schema errors", async () => {
		const remoteError = new RpcRemoteError("remote-request", {
			code: "AGENTS_NOT_READY",
			message: "executor is not ready",
		});
		const failures: Array<{
			readonly error: Error;
			readonly invokeClose: boolean;
		}> = [
			{
				error: new RpcConnectionClosedError(1006, "private close-before-callback detail"),
				invokeClose: false,
			},
			{
				error: new RpcConnectionClosedError(1006, "private close-after-send detail"),
				invokeClose: true,
			},
			{ error: new RpcTimeoutError("private-timeout-request", 15_000), invokeClose: false },
		];
		for (const failure of failures) {
			let peer: FakePeer;
			const client = new DesktopAgentsClient(async (options) => {
				peer = new FakePeer((method) => {
					if (method === productRpcMethods.runtimeGet) {
						if (failure.invokeClose) {
							options.onClose?.(
								{ code: 1006, reason: "private callback detail" },
								peer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
							);
						}
						throw failure.error;
					}
					return { events: [] };
				});
				return peer;
			});
			await client.connect(createConnectOptions());
			const error = await client
				.request(productRpcMethods.runtimeGet, {}, emptyParamsSchema, agentsRuntimeInfoSchema)
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(AgentsUnavailableError);
			expect((error as Error).message).not.toContain("private");
			client.close();
		}

		const remoteClient = new DesktopAgentsClient(
			async () =>
				new FakePeer((method) => {
					if (method === productRpcMethods.runtimeGet) {
						throw remoteError;
					}
					return { events: [] };
				}),
		);
		await remoteClient.connect(createConnectOptions());
		await expect(
			remoteClient.request(
				productRpcMethods.runtimeGet,
				{},
				emptyParamsSchema,
				agentsRuntimeInfoSchema,
			),
		).rejects.toBe(remoteError);
		remoteClient.close();

		let schemaPeer: FakePeer;
		const schemaClient = new DesktopAgentsClient(async (options) => {
			schemaPeer = new FakePeer((method) => {
				if (method === productRpcMethods.runtimeGet) {
					options.onClose?.(
						{ code: 1006, reason: "close raced schema validation" },
						schemaPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
					return rpcJsonValueSchema.parse({ invalid: true });
				}
				return rpcJsonValueSchema.parse({ events: [] });
			});
			return schemaPeer;
		});
		await schemaClient.connect(createConnectOptions());
		const schemaError = await schemaClient
			.request(productRpcMethods.runtimeGet, {}, emptyParamsSchema, agentsRuntimeInfoSchema)
			.catch((error: unknown) => error);
		expect(schemaError).not.toBeInstanceOf(AgentsUnavailableError);
		expect(schemaError).toBeInstanceOf(Error);
		schemaClient.close();
	});

	test("releases a response-lost reservation on terminal delivery and permits same-key retry", async () => {
		let options: ConnectRpcClientOptions | undefined;
		let sendCalls = 0;
		const peer = new FakePeer(async (method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			sendCalls += 1;
			if (sendCalls === 1) {
				const handler = options?.handlers?.events?.[agentsProductEventMethods[0]];
				if (handler === undefined) {
					throw new Error("Chat event handler was not installed.");
				}
				for (const event of createTerminalReplayEvents()) {
					await handler(
						rpcJsonValueSchema.parse({ clientRequestId, event }),
						{} as RpcEventContext,
					);
				}
				throw new Error("accepted response was lost");
			}
			return createTerminalAcceptedPayload();
		});
		const client = new DesktopAgentsClient(
			async (connectedOptions) => {
				options = connectedOptions;
				return peer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());
		const input = { requestId: clientRequestId, sessionId, content: "hello" };

		await expect(
			client.request(
				productRpcMethods.chatSend,
				input,
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toThrow("accepted response was lost");
		await expect(
			client.request(
				productRpcMethods.chatSend,
				input,
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toMatchObject({ run: { id: runId, status: "completed" } });
		expect(sendCalls).toBe(2);
		client.close();
	});

	test("does not let late cleanup remove a newer same-key reservation", async () => {
		let options: ConnectRpcClientOptions | undefined;
		let rejectFirst: ((error: unknown) => void) | undefined;
		let resolveSecond: ((payload: JsonValue) => void) | undefined;
		let sendCalls = 0;
		const peer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			sendCalls += 1;
			if (sendCalls === 1) {
				return new Promise<JsonValue>((_resolve, reject) => {
					rejectFirst = reject;
				});
			}
			return new Promise<JsonValue>((resolve) => {
				resolveSecond = resolve;
			});
		});
		const client = new DesktopAgentsClient(
			async (connectedOptions) => {
				options = connectedOptions;
				return peer;
			},
			{ maxTrackedRunCursors: 1 },
		);
		await client.connect(createConnectOptions());
		const input = { requestId: clientRequestId, sessionId, content: "hello" };
		const first = client.request(
			productRpcMethods.chatSend,
			input,
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		while (rejectFirst === undefined) {
			await Promise.resolve();
		}
		const handler = options?.handlers?.events?.[agentsProductEventMethods[0]];
		if (handler === undefined) {
			throw new Error("Chat event handler was not installed.");
		}
		for (const event of createTerminalReplayEvents()) {
			await handler(rpcJsonValueSchema.parse({ clientRequestId, event }), {} as RpcEventContext);
		}
		const second = client.request(
			productRpcMethods.chatSend,
			input,
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		while (resolveSecond === undefined) {
			await Promise.resolve();
		}
		rejectFirst(new RpcRequestLimitError(1));
		await expect(first).rejects.toBeInstanceOf(RpcRequestLimitError);
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "must remain full" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(AgentsUnavailableError);
		resolveSecond(createTerminalAcceptedPayload());
		await expect(second).resolves.toBeDefined();
		client.close();
	});

	test("purges every Session reservation and cursor after successful deletion", async () => {
		let sendCalls = 0;
		const peer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatSend) {
				sendCalls += 1;
				const input = sendAskChatMessageInputSchema.parse(payload);
				return input.sessionId === sessionId
					? createAcceptedPayload()
					: createAcceptedPayload(
							otherRunId,
							otherUserMessageId,
							otherAssistantMessageId,
							otherSessionId,
						);
			}
			if (method === productRpcMethods.sessionDelete) {
				return { sessionId };
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(async () => peer, { maxTrackedRunCursors: 1 });
		await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		await client.request(
			productRpcMethods.sessionDelete,
			{ sessionId },
			deleteChatSessionInputSchema,
			deleteChatSessionOutputSchema,
		);
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: "new reservation" },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		await expect(
			client.request(
				productRpcMethods.chatSend,
				{
					requestId: crypto.randomUUID(),
					sessionId: otherSessionId,
					content: "unrelated reservation",
				},
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			),
		).resolves.toBeDefined();
		expect(sendCalls).toBe(2);
		client.close();
	});

	test("commits earlier replay batches and resumes after a later batch fails", async () => {
		const runIds = [
			"01984df0-cf18-7c89-9d11-3686130434c8",
			"01984df0-cf18-7c89-9d11-3686130434c9",
			"01984df0-cf18-7c89-9d11-3686130434ca",
		];
		const userIds = [
			"01984df0-cf19-7bb2-a5cd-69e8a802db2f",
			"01984df0-cf19-7bb2-a5cd-69e8a802db30",
			"01984df0-cf19-7bb2-a5cd-69e8a802db31",
		];
		const assistantIds = [
			"01984df0-cf1a-7178-b174-42fc83c3e87d",
			"01984df0-cf1a-7178-b174-42fc83c3e87e",
			"01984df0-cf1a-7178-b174-42fc83c3e87f",
		];
		let acceptedIndex = 0;
		const firstPeer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatSend) {
				return { events: [] };
			}
			const index = acceptedIndex;
			acceptedIndex += 1;
			return createAcceptedPayload(runIds[index], userIds[index], assistantIds[index]);
		});
		let failedReplayBatch = 0;
		const failedPeer = new FakePeer((method, payload) => {
			if (method !== productRpcMethods.chatReplay) {
				return { events: [] };
			}
			failedReplayBatch += 1;
			if (failedReplayBatch === 2) {
				return Promise.reject(new Error("second replay batch failed"));
			}
			const replayedRunId =
				replayChatEventsInputSchema.parse(payload).cursors[0]?.runId ??
				(() => {
					throw new Error("Missing replay Run.");
				})();
			const index = runIds.indexOf(replayedRunId);
			return rpcJsonValueSchema.parse({
				events: [
					{
						schemaVersion: 1,
						id: "01984df0-cf1b-7521-a4a5-40eef114ce9f",
						runId: replayedRunId,
						sessionId,
						seq: 1,
						type: "message.delta",
						source: { kind: "assistant" },
						visibility: "user",
						createdAt,
						payload: {
							messageId:
								assistantIds[index] ??
								(() => {
									throw new Error("Missing fake assistant message ID.");
								})(),
							delta: "replayed",
						},
					},
				],
			});
		});
		const recoveredCursors: Array<{ runId: string; lastSeq: number }> = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				recoveredCursors.push(...replayChatEventsInputSchema.parse(payload).cursors);
			}
			return { events: [] };
		});
		const peers = [firstPeer, failedPeer, recoveredPeer];
		let connectionIndex = 0;
		let leakedEvents = 0;
		const client = new DesktopAgentsClient(async () => {
			const peer = peers[connectionIndex];
			connectionIndex += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		client.subscribeChatEvents(() => {
			leakedEvents += 1;
		});
		const firstConnection = await client.connect(createConnectOptions());
		for (let index = 0; index < runIds.length; index += 1) {
			await client.request(
				productRpcMethods.chatSend,
				{ requestId: crypto.randomUUID(), sessionId, content: `prompt-${index}` },
				sendAskChatMessageInputSchema,
				chatSendAcceptedOutputSchema,
			);
		}
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(leakedEvents).toBe(1);
		await client.connect(createConnectOptions());
		expect(recoveredCursors).toHaveLength(3);
		expect(recoveredCursors.map((cursor) => cursor.lastSeq)).toEqual([1, 0, 0]);
		client.close();
	});

	test("commits a replay cursor only after every listener accepts the terminal event", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const terminalEvents = createTerminalReplayEvents();
		const failedPeer = new FakePeer(() => ({ events: terminalEvents }));
		const recoveredCursors: number[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				recoveredCursors.push(replayChatEventsInputSchema.parse(payload).cursors[0]?.lastSeq ?? -1);
			}
			return { events: terminalEvents };
		});
		const peers = [firstPeer, failedPeer, recoveredPeer];
		let index = 0;
		let firstListenerDeliveries = 0;
		let rejectTerminalOnce = true;
		const client = new DesktopAgentsClient(async (options) => {
			const peer = peers[index];
			if (index === 2) {
				const handler = options.handlers?.events?.[agentsProductEventMethods[0]];
				if (handler === undefined) {
					throw new Error("Recovered chat event handler was not installed.");
				}
				for (const event of terminalEvents) {
					await handler(
						rpcJsonValueSchema.parse({ clientRequestId, event }),
						{} as RpcEventContext,
					);
				}
			}
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		client.subscribeChatEvents(() => {
			firstListenerDeliveries += 1;
		});
		client.subscribeChatEvents((event) => {
			if (rejectTerminalOnce && event.type === "message.completed") {
				rejectTerminalOnce = false;
				throw new Error("second listener rejected terminal event");
			}
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		await client.connect(createConnectOptions());
		expect(recoveredCursors).toEqual([0]);
		expect(firstListenerDeliveries).toBe(3);
		client.close();
	});

	test("interrupts a never-settling replay listener at the recovery deadline", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const replayEvents = [createDeltaEventPayload(1, "stalled")];
		const stalledPeer = new FakePeer(() => ({ events: replayEvents }));
		const recoveredCursors: number[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				recoveredCursors.push(replayChatEventsInputSchema.parse(payload).cursors[0]?.lastSeq ?? -1);
			}
			return { events: replayEvents };
		});
		const peers = [firstPeer, stalledPeer, recoveredPeer];
		let index = 0;
		const client = new DesktopAgentsClient(
			async () => {
				const peer = peers[index];
				index += 1;
				return peer ?? Promise.reject(new Error("No fake peer available."));
			},
			{ recoveryTimeoutMs: 10 },
		);
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();
		const unsubscribe = client.subscribeChatEvents(() => new Promise<void>(() => undefined));

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(stalledPeer.closeCalls).toBe(1);
		unsubscribe();
		await client.connect(createConnectOptions());
		expect(recoveredCursors).toEqual([0]);
		client.close();
	});

	test("closes the exact active peer when a live event listener rejects", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const recoveredCursors: number[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				recoveredCursors.push(replayChatEventsInputSchema.parse(payload).cursors[0]?.lastSeq ?? -1);
			}
			return { events: [] };
		});
		const peers = [firstPeer, recoveredPeer];
		let index = 0;
		let activeOptions: ConnectRpcClientOptions | undefined;
		let firstListenerDeliveries = 0;
		const client = new DesktopAgentsClient(async (options) => {
			activeOptions = options;
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		client.subscribeChatEvents(() => {
			firstListenerDeliveries += 1;
		});
		client.subscribeChatEvents(async () => {
			throw new Error("async live listener failure");
		});
		await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		const handler = activeOptions?.handlers?.events?.[agentsProductEventMethods[0]];
		if (handler === undefined) {
			throw new Error("Active chat event handler was not installed.");
		}
		await expect(handler(createDeliveryPayload(1, "live"), {} as RpcEventContext)).rejects.toThrow(
			"Chat event delivery failed",
		);
		expect(firstPeer.closeCalls).toBe(1);
		expect(firstListenerDeliveries).toBe(1);
		await client.connect(createConnectOptions());
		expect(recoveredCursors).toEqual([0]);
		client.close();
	});

	test.each([
		["event count", { maxProvisionalEvents: 1, maxProvisionalBytes: 1_000_000 }],
		["encoded bytes", { maxProvisionalEvents: 10, maxProvisionalBytes: 10 }],
	])("fails closed when the provisional %s budget is exceeded", async (_name, limits) => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		let resolveReplay: ((payload: JsonValue) => void) | undefined;
		let replayStarted: (() => void) | undefined;
		const replayStartedPromise = new Promise<void>((resolve) => {
			replayStarted = resolve;
		});
		const provisionalPeer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatReplay) {
				return { events: [] };
			}
			replayStarted?.();
			return new Promise<JsonValue>((resolve) => {
				resolveReplay = resolve;
			});
		});
		const peers = [firstPeer, provisionalPeer];
		let index = 0;
		let provisionalOptions: ConnectRpcClientOptions | undefined;
		const client = new DesktopAgentsClient(async (options) => {
			provisionalOptions = options;
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		}, limits);
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		const reconnect = client.connect(createConnectOptions());
		await replayStartedPromise;
		const handler = provisionalOptions?.handlers?.events?.[agentsProductEventMethods[0]];
		if (handler === undefined) {
			throw new Error("Provisional chat event handler was not installed.");
		}
		await Promise.resolve(handler(createDeliveryPayload(1, "first"), {} as RpcEventContext)).catch(
			() => undefined,
		);
		await expect(
			Promise.resolve(handler(createDeliveryPayload(2, "second"), {} as RpcEventContext)),
		).rejects.toBeDefined();
		resolveReplay?.({ events: [] });
		await expect(reconnect).rejects.toBeInstanceOf(AgentsUnavailableError);
		expect(provisionalPeer.closeCalls).toBe(1);
	});

	test("fails a slow recovery at the absolute deadline and resumes from committed cursors", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		let now = 0;
		const slowPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatReplay) {
				now = 20;
			}
			return { events: [] };
		});
		const recoveredCursors: number[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				recoveredCursors.push(replayChatEventsInputSchema.parse(payload).cursors[0]?.lastSeq ?? -1);
			}
			return { events: [] };
		});
		const peers = [firstPeer, slowPeer, recoveredPeer];
		let index = 0;
		const client = new DesktopAgentsClient(
			async () => {
				const peer = peers[index];
				index += 1;
				return peer ?? Promise.reject(new Error("No fake peer available."));
			},
			{ recoveryTimeoutMs: 10 },
			() => now,
		);
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		await client.connect(createConnectOptions());
		expect(recoveredCursors).toEqual([0]);
		client.close();
	});

	test("retires the exact Session when recovery replay returns a typed miss", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		let remoteUpdates = 0;
		const missedPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatReplay) {
				throw createSessionNotFoundRemoteError(method);
			}
			if (method === productRpcMethods.sessionUpdate) {
				remoteUpdates += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, missedPeer];
		const client = new DesktopAgentsClient(async () => {
			const peer = peers.shift();
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const invalidations: string[] = [];
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidations.push(`${invalidation.reason}:${invalidation.sessionId}`);
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: true,
			});
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await client.connect(createConnectOptions());
		expect(invalidations).toEqual([`session_retired:${sessionId}`]);
		await expect(
			client.request(
				productRpcMethods.sessionUpdate,
				{ sessionId, title: "Do not dispatch" },
				updateChatSessionInputSchema,
				updateChatSessionOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		expect(remoteUpdates).toBe(0);
		client.close();
	});

	test("retries rejected retirement ACKs before readiness and preserves unrelated recovery state", async () => {
		const createKey = crypto.randomUUID();
		const nextCreateKey = crypto.randomUUID();
		const recoveredCreate = createChatSessionOutputSchema.parse(createSessionPayload(1));
		const retiredSessionId = recoveredCreate.session.id;
		const firstPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.sessionCreate) {
				return createSessionPayload(1);
			}
			if (method === productRpcMethods.chatSend) {
				const input = sendAskChatMessageInputSchema.parse(payload);
				return input.sessionId === retiredSessionId
					? createAcceptedPayload(runId, userMessageId, assistantMessageId, retiredSessionId)
					: createAcceptedPayload(
							otherRunId,
							otherUserMessageId,
							otherAssistantMessageId,
							otherSessionId,
						);
			}
			return { events: [] };
		});
		const retiredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				const replay = replayChatEventsInputSchema.parse(payload);
				return {
					events: [],
					retiredSessionIds:
						replay.cursors[0]?.sessionId === retiredSessionId ? [retiredSessionId] : [],
				};
			}
			return { events: [], retiredSessionIds: [] };
		});
		const retriedSessionIds: string[] = [];
		const recoveredPeer = new FakePeer((method, payload) => {
			if (method === productRpcMethods.chatReplay) {
				retriedSessionIds.push(
					...replayChatEventsInputSchema.parse(payload).cursors.map((cursor) => cursor.sessionId),
				);
			}
			if (method === productRpcMethods.sessionCreate) {
				return createSessionPayload(2);
			}
			return { events: [] };
		});
		const peers = [firstPeer, retiredPeer, recoveredPeer];
		const client = new DesktopAgentsClient(
			async () => peers.shift() ?? Promise.reject(new Error("No fake peer available.")),
			{ maxPendingSessionCreates: 1 },
		);
		let readyCount = 0;
		let invalidationAttempts = 0;
		let rejectedInvalidation:
			| { readonly invalidationId: string; readonly sessionId: string }
			| undefined;
		client.subscribeReady(() => {
			readyCount += 1;
		});
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidationAttempts += 1;
			if (invalidationAttempts === 1) {
				rejectedInvalidation = invalidation;
				client.acknowledgeChatSessionInvalidation({
					schemaVersion: 1,
					invalidationId: invalidation.invalidationId,
					sessionId: invalidation.sessionId,
					accepted: false,
				});
				return;
			}
			expect(() =>
				client.acknowledgeChatSessionInvalidation({
					schemaVersion: 1,
					invalidationId: rejectedInvalidation?.invalidationId ?? "",
					sessionId: rejectedInvalidation?.sessionId ?? "",
					accepted: true,
				}),
			).toThrow("did not match");
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: true,
			});
		});

		await expect(client.createSession(createKey)).rejects.toBeInstanceOf(AgentsUnavailableError);
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{
				requestId: clientRequestId,
				sessionId: retiredSessionId,
				content: "retire after ACK",
			},
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		await client.request(
			productRpcMethods.chatSend,
			{
				requestId: crypto.randomUUID(),
				sessionId: otherSessionId,
				content: "keep unrelated",
			},
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(readyCount).toBe(1);
		await expect(client.createSession(nextCreateKey)).rejects.toThrow(
			"pending Session create recovery limit",
		);

		await client.connect(createConnectOptions());
		expect(readyCount).toBe(2);
		expect(invalidationAttempts).toBe(2);
		expect(retriedSessionIds).toEqual([otherSessionId]);
		await expect(client.createSession(nextCreateKey)).resolves.toMatchObject({
			session: { id: createChatSessionOutputSchema.parse(createSessionPayload(2)).session.id },
		});
		client.close();
	});

	test("keeps a timed-out retirement pending and retries it on the next connection", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const retiredPeer = new FakePeer(() => ({
			events: [],
			retiredSessionIds: [sessionId],
		}));
		let retriedTrackedReplays = 0;
		const recoveredPeer = new FakePeer((method, payload) => {
			if (
				method === productRpcMethods.chatReplay &&
				replayChatEventsInputSchema.parse(payload).cursors.length > 0
			) {
				retriedTrackedReplays += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, retiredPeer, recoveredPeer];
		const client = new DesktopAgentsClient(
			async () => peers.shift() ?? Promise.reject(new Error("No fake peer available.")),
			{ recoveryTimeoutMs: 50 },
		);
		const invalidationIds: string[] = [];
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidationIds.push(invalidation.invalidationId);
			if (invalidationIds.length > 1) {
				client.acknowledgeChatSessionInvalidation({
					schemaVersion: 1,
					invalidationId: invalidation.invalidationId,
					sessionId: invalidation.sessionId,
					accepted: true,
				});
			}
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "timeout retirement" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		await client.connect(createConnectOptions());
		expect(invalidationIds).toHaveLength(2);
		expect(invalidationIds[1]).not.toBe(invalidationIds[0]);
		expect(retriedTrackedReplays).toBe(0);
		client.close();
	});

	test("keeps a retirement pending when its recovery connection closes during ACK", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const retiredPeer = new FakePeer(() => ({
			events: [],
			retiredSessionIds: [sessionId],
		}));
		const recoveredPeer = new FakePeer(() => ({ events: [] }));
		const peers = [firstPeer, retiredPeer, recoveredPeer];
		let recoveryClose: (() => void) | undefined;
		const client = new DesktopAgentsClient(async (options) => {
			const peer = peers.shift() ?? Promise.reject(new Error("No fake peer available."));
			if (peer === retiredPeer) {
				recoveryClose = () =>
					options.onClose?.(
						{ code: 1006, reason: "closed during renderer ACK" },
						retiredPeer as unknown as Parameters<NonNullable<typeof options.onClose>>[1],
					);
			}
			return peer;
		});
		let invalidationAttempts = 0;
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidationAttempts += 1;
			if (invalidationAttempts === 1) {
				recoveryClose?.();
				return;
			}
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: true,
			});
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "close retirement" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		await client.connect(createConnectOptions());
		expect(invalidationAttempts).toBe(2);
		client.close();
	});

	test("backpressures retirement tracking until the shared TTL frees capacity", async () => {
		let nowMs = 1_000;
		let remoteMisses = 0;
		const peer = new FakePeer((method) => {
			if (method === productRpcMethods.sessionGet) {
				remoteMisses += 1;
				throw createSessionNotFoundRemoteError(method);
			}
			return { events: [] };
		});
		const client = new DesktopAgentsClient(
			async () => peer,
			{},
			() => nowMs,
		);
		await client.connect(createConnectOptions());
		for (let index = 0; index < maxRetainedSessionRetirements; index += 1) {
			await expect(
				client.request(
					productRpcMethods.sessionGet,
					{ sessionId: createRetirementSessionId(index), limit: 2 },
					getChatSessionPageInputSchema,
					getChatSessionPageOutputSchema,
				),
			).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		}
		const overflowSessionId = createRetirementSessionId(maxRetainedSessionRetirements);
		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId: overflowSessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toThrow("retirement recovery limit");

		nowMs += retiredSessionTombstoneTtlMs;
		await expect(
			client.request(
				productRpcMethods.sessionGet,
				{ sessionId: overflowSessionId, limit: 2 },
				getChatSessionPageInputSchema,
				getChatSessionPageOutputSchema,
			),
		).rejects.toBeInstanceOf(ChatSessionNotFoundError);
		expect(remoteMisses).toBe(maxRetainedSessionRetirements + 2);
		client.close();
	});

	test("evicts every cursor for an acknowledged retired Session and does not replay it again", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		let retiredConnectOptions: ConnectRpcClientOptions | undefined;
		const retiredPeer = new FakePeer(async (method) => {
			if (method === productRpcMethods.chatReplay) {
				if (retiredConnectOptions === undefined) {
					throw new Error("Retirement recovery options were not captured.");
				}
				await emitProvisionalEvent(retiredConnectOptions);
			}
			return {
				events: [],
				retiredSessionIds: [sessionId],
			};
		});
		let finalReplayCalls = 0;
		const finalPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatReplay) {
				finalReplayCalls += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, retiredPeer, finalPeer];
		let index = 0;
		const client = new DesktopAgentsClient(async (options) => {
			const peer = peers[index];
			if (peer === retiredPeer) {
				retiredConnectOptions = options;
			}
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const deliveredEvents: ChatRunEvent[] = [];
		client.subscribeChatEvents((event) => {
			deliveredEvents.push(event);
		});
		client.subscribeChatSessionInvalidations((invalidation) => {
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: true,
			});
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();
		const retiredConnection = await client.connect(createConnectOptions());
		retiredConnection.close();
		await client.connect(createConnectOptions());
		expect(finalReplayCalls).toBe(0);
		expect(deliveredEvents).toEqual([]);
		client.close();
	});

	test("rejects a forged retired Session outside the requested replay cursor", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		const forgedPeer = new FakePeer(() => ({
			events: [],
			retiredSessionIds: ["01984df0-cf18-7c89-9d11-3686130434ff"],
		}));
		const peers = [firstPeer, forgedPeer];
		let index = 0;
		const client = new DesktopAgentsClient(async () => {
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		expect(forgedPeer.closeCalls).toBe(1);
	});

	test("resnapshots and safely evicts an old cursor after a long offline TTL boundary", async () => {
		const ttlMs = 30 * 24 * 60 * 60 * 1_000;
		let localNowMs = 1_000;
		const initialSupport = createCursorSupport(1_000);
		const expiredSupport = {
			...createCursorSupport(1_000 + ttlMs),
			oldestSupportedCursorIssuedAtMs: 1_000,
		};
		const firstPeer = new FakePeer(
			(method) =>
				method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
			undefined,
			initialSupport,
		);
		let staleReplayInput: ReturnType<typeof replayChatEventsInputSchema.parse> | undefined;
		const stalePeer = new FakePeer(
			(method, payload) => {
				if (method === productRpcMethods.chatReplay) {
					staleReplayInput = replayChatEventsInputSchema.parse(payload);
					return rpcJsonValueSchema.parse({
						events: [],
						resnapshotSessionIds: [sessionId],
						cursorSupport: expiredSupport,
					});
				}
				if (method === productRpcMethods.sessionGet) {
					return createSessionPagePayload();
				}
				if (method === productRpcMethods.sessionList) {
					return rpcJsonValueSchema.parse({ items: [] });
				}
				return rpcJsonValueSchema.parse({ events: [] });
			},
			undefined,
			expiredSupport,
		);
		let finalTrackedReplayCalls = 0;
		let refetchCalls = 0;
		let listRefetchCalls = 0;
		const invalidations: string[] = [];
		const finalPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatReplay) {
				finalTrackedReplayCalls += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, stalePeer, finalPeer];
		let index = 0;
		const client = new DesktopAgentsClient(
			async () => peers[index++] ?? Promise.reject(new Error("No fake peer available.")),
			{},
			() => localNowMs,
		);
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidations.push(`${invalidation.reason}:${invalidation.sessionId}`);
			void Promise.all([
				client.request(
					productRpcMethods.sessionGet,
					{ sessionId: invalidation.sessionId, limit: 2 },
					getChatSessionPageInputSchema,
					getChatSessionPageOutputSchema,
				),
				client
					.request(
						productRpcMethods.sessionList,
						{},
						listChatSessionsInputSchema,
						listChatSessionsOutputSchema,
					)
					.then(() => {
						listRefetchCalls += 1;
					}),
			]).then(
				() => {
					refetchCalls += 1;
					client.acknowledgeChatSessionInvalidation({
						schemaVersion: 1,
						invalidationId: invalidation.invalidationId,
						sessionId: invalidation.sessionId,
						accepted: true,
					});
				},
				() => {
					client.acknowledgeChatSessionInvalidation({
						schemaVersion: 1,
						invalidationId: invalidation.invalidationId,
						sessionId: invalidation.sessionId,
						accepted: false,
					});
				},
			);
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();
		localNowMs += ttlMs;

		const resnapshotConnection = await client.connect(createConnectOptions());
		expect(staleReplayInput?.cursors[0]).toEqual({
			runId,
			sessionId,
			issuedAtMs: 1_000,
			lastSeq: 0,
		});
		expect(refetchCalls).toBe(1);
		expect(listRefetchCalls).toBe(1);
		expect(invalidations).toEqual([`history_expired:${sessionId}`]);
		resnapshotConnection.close();
		await client.connect(createConnectOptions());
		expect(finalTrackedReplayCalls).toBe(0);
		client.close();
	});

	test("keeps an expired cursor across a failed renderer refetch and retires it after reconnect", async () => {
		const ttlMs = 30 * 24 * 60 * 60 * 1_000;
		let localNowMs = 1_000;
		const initialSupport = createCursorSupport(1_000);
		const expiredSupport = {
			...createCursorSupport(1_000 + ttlMs),
			oldestSupportedCursorIssuedAtMs: 1_000,
		};
		const firstPeer = new FakePeer(
			(method) =>
				method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
			undefined,
			initialSupport,
		);
		const failedRefetchPeer = new FakePeer(
			() => ({
				events: [],
				resnapshotSessionIds: [sessionId],
				cursorSupport: expiredSupport,
			}),
			undefined,
			expiredSupport,
		);
		const successfulRefetchPeer = new FakePeer(
			() => ({
				events: [],
				resnapshotSessionIds: [sessionId],
				cursorSupport: expiredSupport,
			}),
			undefined,
			expiredSupport,
		);
		let finalTrackedReplayCalls = 0;
		const finalPeer = new FakePeer((method) => {
			if (method === productRpcMethods.chatReplay) {
				finalTrackedReplayCalls += 1;
			}
			return { events: [] };
		});
		const peers = [firstPeer, failedRefetchPeer, successfulRefetchPeer, finalPeer];
		let peerIndex = 0;
		let invalidationAttempts = 0;
		const client = new DesktopAgentsClient(
			async () => peers[peerIndex++] ?? Promise.reject(new Error("No fake peer available.")),
			{},
			() => localNowMs,
		);
		client.subscribeChatSessionInvalidations((invalidation) => {
			invalidationAttempts += 1;
			client.acknowledgeChatSessionInvalidation({
				schemaVersion: 1,
				invalidationId: invalidation.invalidationId,
				sessionId: invalidation.sessionId,
				accepted: invalidationAttempts > 1,
			});
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();
		localNowMs += ttlMs;

		await expect(client.connect(createConnectOptions())).rejects.toBeInstanceOf(
			AgentsUnavailableError,
		);
		const recovered = await client.connect(createConnectOptions());
		recovered.close();
		await client.connect(createConnectOptions());
		expect(invalidationAttempts).toBe(2);
		expect(finalTrackedReplayCalls).toBe(0);
		client.close();
	});

	test("closes a provisional peer when shutdown races replay", async () => {
		const firstPeer = new FakePeer((method) =>
			method === productRpcMethods.chatSend ? createAcceptedPayload() : { events: [] },
		);
		let resolveReplay: ((payload: JsonValue) => void) | undefined;
		let replayStarted: (() => void) | undefined;
		const replayStartedPromise = new Promise<void>((resolve) => {
			replayStarted = resolve;
		});
		const provisionalPeer = new FakePeer((method) => {
			if (method !== productRpcMethods.chatReplay) {
				return { events: [] };
			}
			replayStarted?.();
			return new Promise<JsonValue>((resolve) => {
				resolveReplay = resolve;
			});
		});
		const peers = [firstPeer, provisionalPeer];
		let index = 0;
		const client = new DesktopAgentsClient(async () => {
			const peer = peers[index];
			index += 1;
			return peer ?? Promise.reject(new Error("No fake peer available."));
		});
		const firstConnection = await client.connect(createConnectOptions());
		await client.request(
			productRpcMethods.chatSend,
			{ requestId: clientRequestId, sessionId, content: "hello" },
			sendAskChatMessageInputSchema,
			chatSendAcceptedOutputSchema,
		);
		firstConnection.close();

		const reconnect = client.connect(createConnectOptions());
		await replayStartedPromise;
		client.close();
		resolveReplay?.({ events: [] });
		await expect(reconnect).rejects.toBeInstanceOf(AgentsUnavailableError);
		expect(provisionalPeer.closeCalls).toBeGreaterThanOrEqual(1);
	});
});

class FakePeer implements DesktopAgentsRpcPeer {
	closeCalls = 0;

	constructor(
		private readonly onRequest: (
			method: string,
			payload: JsonValue,
			options?: RpcRequestOptions,
		) => JsonValue | Promise<JsonValue>,
		readonly remoteIdentity: DesktopAgentsRpcPeer["remoteIdentity"] = {
			role: "agents",
			peerId: "moshu-local-agents",
			instanceId: "agents-1",
			generation: 1,
		},
		private readonly cursorSupport = createCursorSupport(),
	) {}

	async request(
		method: string,
		payload: JsonValue,
		options?: RpcRequestOptions,
	): Promise<JsonValue> {
		if (
			method === productRpcMethods.chatReplay &&
			typeof payload === "object" &&
			payload !== null &&
			!Array.isArray(payload) &&
			"cursors" in payload &&
			Array.isArray(payload.cursors) &&
			payload.cursors.length === 0
		) {
			return { events: [], cursorSupport: this.cursorSupport };
		}
		const output = await this.onRequest(method, payload, options);
		if (
			method === productRpcMethods.chatReplay &&
			typeof output === "object" &&
			output !== null &&
			!Array.isArray(output) &&
			!("cursorSupport" in output)
		) {
			return {
				...output,
				cursorSupport: this.cursorSupport,
			};
		}
		return output;
	}

	close(): void {
		this.closeCalls += 1;
	}
}

function createCursorSupport(serverTimeMs = 1_000) {
	return {
		schemaVersion: 1 as const,
		serverTimeMs,
		oldestSupportedCursorIssuedAtMs: 0,
		tombstoneTtlMs: 30 * 24 * 60 * 60 * 1_000,
	};
}

function createSessionNotFoundRemoteError(method: string): RpcRemoteError {
	return new RpcRemoteError(`missing-${method}`, {
		code: "SESSION_NOT_FOUND",
		message: "The chat Session was not found.",
	});
}

function createRetirementSessionId(index: number): string {
	return `01984df0-cf17-7e6e-9a7d-${index.toString(16).padStart(12, "0")}`;
}

function createConnectOptions(): DesktopAgentsConnectOptions {
	return {
		agentsServer: {
			channel: "moshu-companion-bootstrap",
			controlVersion: 2,
			type: "READY",
			role: "agents-server",
			pid: 101,
			processVersion: "0.0.1",
			nonce: "server-generation-1",
			serverIdentity: {
				role: "agents",
				peerId: "moshu-local-agents",
				instanceId: "agents-1",
				generation: 1,
			},
			endpoint: { host: "127.0.0.1", port: 42_101, path: "/rpc" },
		},
		identity: {
			role: "client",
			peerId: "moshu-desktop-client",
			instanceId: "client-1",
			generation: 1,
		},
		credential: Buffer.alloc(32, 7).toString("base64url"),
	};
}

function createSessionPayload(index: number): JsonValue {
	return rpcJsonValueSchema.parse({
		session: {
			schemaVersion: 1,
			id: `01984df0-cf17-7e6e-9a7d-${index.toString(16).padStart(12, "0")}`,
			agentSessionId: `01984df0-cf17-7e6e-9a7d-${index.toString(16).padStart(12, "0")}`,
			title: "New chat",
			defaultMode: "ask",
			createdAt,
			updatedAt: createdAt,
		},
	});
}

function createAcceptedPayload(
	acceptedRunId = runId,
	acceptedUserMessageId = userMessageId,
	acceptedAssistantMessageId = assistantMessageId,
	acceptedSessionId = sessionId,
): JsonValue {
	return rpcJsonValueSchema.parse({
		run: {
			schemaVersion: 1,
			id: acceptedRunId,
			sessionId: acceptedSessionId,
			mode: "ask",
			status: "queued",
			provider: {
				schemaVersion: 1,
				providerId: "01984df0-cf16-7df0-8a4a-a1fc9dc9299d",
				name: "OpenAI",
				source: "builtin",
				api: "openai-responses",
				model: "gpt-4.1-mini",
				status: "ready",
			},
			userMessageId: acceptedUserMessageId,
			assistantMessageId: acceptedAssistantMessageId,
			createdAt,
			updatedAt: createdAt,
		},
		userMessage: {
			schemaVersion: 1,
			id: acceptedUserMessageId,
			sessionId: acceptedSessionId,
			runId: acceptedRunId,
			role: "user",
			status: "complete",
			content: "hello",
			sequence: 1,
			createdAt,
			updatedAt: createdAt,
		},
		assistantMessage: {
			schemaVersion: 1,
			id: acceptedAssistantMessageId,
			sessionId: acceptedSessionId,
			runId: acceptedRunId,
			role: "assistant",
			status: "streaming",
			content: "",
			sequence: 2,
			createdAt,
			updatedAt: createdAt,
		},
	});
}

function createSessionPagePayload(): JsonValue {
	return rpcJsonValueSchema.parse({
		session: {
			schemaVersion: 1,
			id: sessionId,
			agentSessionId: sessionId,
			title: "Recovered Session",
			defaultMode: "ask",
			createdAt,
			updatedAt: createdAt,
		},
		messages: [],
		runs: [],
		eventCursors: [],
	});
}

function createTerminalAcceptedPayload(): JsonValue {
	const accepted = chatSendAcceptedOutputSchema.parse(createAcceptedPayload());
	return rpcJsonValueSchema.parse({
		...accepted,
		run: {
			...accepted.run,
			status: "completed",
			completedAt: createdAt,
		},
		assistantMessage: {
			...accepted.assistantMessage,
			status: "complete",
			content: "done",
		},
	});
}

function createTerminalReplayEvents(): JsonValue[] {
	return [
		rpcJsonValueSchema.parse({
			schemaVersion: 1,
			id: "01984df0-cf1b-7521-a4a5-40eef114ce9f",
			runId,
			sessionId,
			seq: 1,
			type: "message.completed",
			source: { kind: "assistant" },
			visibility: "user",
			createdAt,
			payload: {
				messageId: assistantMessageId,
				status: "complete",
				content: "done",
			},
		}),
		rpcJsonValueSchema.parse({
			schemaVersion: 1,
			id: "01984df0-cf1c-793f-bc2c-df399f25cd1d",
			runId,
			sessionId,
			seq: 2,
			type: "run.status",
			source: { kind: "system" },
			visibility: "user",
			createdAt,
			payload: { previousStatus: "running", status: "completed" },
		}),
	];
}

function createDeltaEventPayload(seq: number, delta: string): JsonValue {
	return rpcJsonValueSchema.parse({
		schemaVersion: 1,
		id: seq === 2 ? "01984df0-cf1b-7521-a4a5-40eef114ce9f" : "01984df0-cf1c-793f-bc2c-df399f25cd1d",
		runId,
		sessionId,
		seq,
		type: "message.delta",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: { messageId: assistantMessageId, delta },
	});
}

function createDeliveryPayload(seq: number, delta: string): JsonValue {
	return rpcJsonValueSchema.parse({
		clientRequestId,
		event: createDeltaEventPayload(seq, delta),
	});
}

async function emitProvisionalEvent(options: ConnectRpcClientOptions): Promise<void> {
	const handler = options.handlers?.events?.[agentsProductEventMethods[0]];
	if (handler === undefined) {
		throw new Error("Chat event handler was not installed.");
	}
	await handler(createDeliveryPayload(1, "provisional"), {} as RpcEventContext);
}
