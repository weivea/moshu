import { describe, expect, test } from "bun:test";

import {
	type ChatRunEvent,
	createChatSessionOutputSchema,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
} from "@moshu/contracts";
import { ChatSessionNotFoundError, openAppDatabase } from "@moshu/database";
import { RpcHandlerError, type RpcPeer } from "@moshu/process-rpc";
import { z } from "zod";

import type { ChatApplicationService } from "./chat-application-service";
import type { ExecutorReadiness } from "./executor-readiness";
import { createProductRpcHandlers, ProductEventRouter, publishChatEvent } from "./product-rpc";

describe("product RPC event broadcast", () => {
	test("isolates a failed client peer and continues broadcasting", () => {
		let failedCloseCalls = 0;
		let healthyDeliveries = 0;
		const failedPeer = createPeer({
			emitEvent() {
				throw new Error("dropped frame");
			},
			close() {
				failedCloseCalls += 1;
			},
		});
		const healthyPeer = createPeer({
			emitEvent() {
				healthyDeliveries += 1;
				return "event-id";
			},
			close() {},
		});

		publishChatEvent(
			[failedPeer, healthyPeer],
			createEvent(),
			"550e8400-e29b-41d4-a716-446655440000",
		);
		expect(failedCloseCalls).toBe(1);
		expect(healthyDeliveries).toBe(1);
	});

	test("routes live events only to the originating client peer", () => {
		let originDeliveries = 0;
		let otherDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin-event";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer(
			{
				emitEvent() {
					otherDeliveries += 1;
					return "other-event";
				},
				close() {},
			},
			"other-client",
		);
		const router = new ProductEventRouter();
		const requestId = "550e8400-e29b-41d4-a716-446655440000";
		router.bind(requestId, origin);
		router.publish([origin, other], createEvent(), requestId);

		expect(originDeliveries).toBe(1);
		expect(otherDeliveries).toBe(0);
	});

	test("keeps gen1 on a failed same-key gen2 retry and transfers only after commit", () => {
		let gen1Deliveries = 0;
		let gen2Deliveries = 0;
		const gen1 = createPeer(
			{
				emitEvent() {
					gen1Deliveries += 1;
					return "gen1-event";
				},
				close() {},
			},
			"origin-client",
			{ instanceId: "origin-gen1", generation: 1 },
		);
		const gen2 = createPeer(
			{
				emitEvent() {
					gen2Deliveries += 1;
					return "gen2-event";
				},
				close() {},
			},
			"origin-client",
			{ instanceId: "origin-gen2", generation: 2 },
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, gen1);
		const failedRetryLease = router.bind(requestId, gen2);

		expect(failedRetryLease.created).toBe(false);
		router.publish([gen1, gen2], createEvent(), requestId);
		router.rollback(failedRetryLease);
		router.publish([gen1, gen2], createEvent(), requestId);
		expect(gen1Deliveries).toBe(2);
		expect(gen2Deliveries).toBe(0);

		const successfulRetryLease = router.bind(requestId, gen2);
		expect(router.commit(successfulRetryLease)).toBe(true);
		router.releasePeer(gen1);
		router.publish([gen1, gen2], createEvent(), requestId);
		expect(gen1Deliveries).toBe(2);
		expect(gen2Deliveries).toBe(1);
	});

	test("rolls back only a newly-created route after a definite handler failure", () => {
		let deliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					deliveries += 1;
					return "event";
				},
				close() {},
			},
			"origin-client",
		);
		const replacement = createPeer(
			{ emitEvent: origin.emitEvent, close() {} },
			"replacement-client",
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		const lease = router.bind(requestId, origin);

		expect(lease.created).toBe(true);
		router.rollback(lease);
		expect(() => router.bind(requestId, replacement)).not.toThrow();
		router.publish([origin, replacement], createEvent(), requestId);
		expect(deliveries).toBe(1);
	});

	test("does not let a different-peer conflict disturb the original route", () => {
		let originDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer({ emitEvent: () => "other", close() {} }, "other-client");
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, origin);

		expect(() => router.bind(requestId, other)).toThrow("another client peer");
		router.publish([origin, other], createEvent(), requestId);
		expect(originDeliveries).toBe(1);
	});

	test("releases routes on terminal publication and exact peer disconnect", () => {
		let originDeliveries = 0;
		let otherDeliveries = 0;
		const origin = createPeer(
			{
				emitEvent() {
					originDeliveries += 1;
					return "origin";
				},
				close() {},
			},
			"origin-client",
		);
		const other = createPeer(
			{
				emitEvent() {
					otherDeliveries += 1;
					return "other";
				},
				close() {},
			},
			"other-client",
		);
		const router = new ProductEventRouter();
		const terminalRequestId = crypto.randomUUID();
		const disconnectedRequestId = crypto.randomUUID();
		const healthyRequestId = crypto.randomUUID();
		router.bind(terminalRequestId, origin);
		router.bind(disconnectedRequestId, origin);
		router.bind(healthyRequestId, other);

		router.publish([origin, other], createTerminalEvent(), terminalRequestId);
		router.publish([origin, other], createEvent(), terminalRequestId);
		router.releasePeer(origin);
		router.publish([origin, other], createEvent(), disconnectedRequestId);
		router.publish([origin, other], createEvent(), healthyRequestId);

		expect(originDeliveries).toBe(1);
		expect(otherDeliveries).toBe(1);
	});

	test("does not let an old connection close remove a route rebound to a newer generation", () => {
		let oldDeliveries = 0;
		let newDeliveries = 0;
		const oldPeer = createPeer(
			{
				emitEvent() {
					oldDeliveries += 1;
					return "old";
				},
				close() {},
			},
			"stable-client",
		);
		const newPeer = createPeer(
			{
				emitEvent() {
					newDeliveries += 1;
					return "new";
				},
				close() {},
			},
			"stable-client",
		);
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, oldPeer);
		router.commit(router.bind(requestId, newPeer));

		router.releasePeer(oldPeer);
		router.publish([oldPeer, newPeer], createEvent(), requestId);
		expect(oldDeliveries).toBe(0);
		expect(newDeliveries).toBe(1);
	});

	test("does not let stale rollback, release, terminal cleanup, or capacity cleanup steal a route", () => {
		const gen1 = createPeer({ emitEvent: () => "gen1", close() {} }, "stable-client", {
			instanceId: "stable-gen1",
			generation: 1,
		});
		const gen2 = createPeer({ emitEvent: () => "gen2", close() {} }, "stable-client", {
			instanceId: "stable-gen2",
			generation: 2,
		});
		const router = new ProductEventRouter();
		const requestId = crypto.randomUUID();
		router.bind(requestId, gen1);
		const staleLease = router.bind(requestId, gen2);
		const committedLease = router.bind(requestId, gen2);
		expect(router.commit(committedLease)).toBe(true);

		router.rollback(staleLease);
		router.release(staleLease);
		router.releasePeer(gen1);
		expect(() => router.bind(requestId, gen1)).not.toThrow();
		router.rollback(router.bind(requestId, gen2));

		router.publish([gen1, gen2], createTerminalEvent(), requestId);
		const replacementRequestId = crypto.randomUUID();
		expect(() => router.bind(replacementRequestId, gen1)).not.toThrow();

		const capacityRouter = new ProductEventRouter();
		for (let index = 0; index < 1_024; index += 1) {
			capacityRouter.bind(`request-${index}`, gen1);
		}
		expect(() => capacityRouter.bind("request-over-cap", gen1)).toThrow(
			"Too many active Chat send request owners",
		);
		capacityRouter.releasePeer(gen1);
		expect(() => capacityRouter.bind("request-after-cleanup", gen2)).not.toThrow();
	});

	test("separates invalid request payloads from private handler validation failures", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		let malformedInputDispatched = false;
		const malformedInputHandler = createProductRpcHandlers({
			chatService: {
				getSessionPage() {
					malformedInputDispatched = true;
					throw new Error("must not dispatch");
				},
			} as unknown as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		const malformedOutputHandler = createProductRpcHandlers({
			chatService: {
				getSessionPage() {
					return { privateOutput: "private-output-secret" };
				},
			} as unknown as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		const internalZodHandler = createProductRpcHandlers({
			chatService: {
				getSessionPage() {
					return z.string().parse({ privateValue: "private-zod-secret" });
				},
			} as unknown as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		if (
			malformedInputHandler === undefined ||
			malformedOutputHandler === undefined ||
			internalZodHandler === undefined
		) {
			throw new Error("Missing Session get Product RPC handler.");
		}

		const malformedInput = await Promise.resolve()
			.then(() =>
				malformedInputHandler(
					{
						sessionId: "private-invalid-session",
						privateInput: "private-input-secret",
					},
					createRequestContext(peer, productRpcMethods.sessionGet),
				),
			)
			.catch((reason: unknown) => reason);
		expect(malformedInputDispatched).toBe(false);
		expect(malformedInput).toBeInstanceOf(RpcHandlerError);
		expect((malformedInput as RpcHandlerError).code).toBe("INVALID_ARGUMENT");
		expect((malformedInput as Error).message).not.toContain("private");

		const validInput = {
			sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
			limit: 2,
		};
		for (const [handler, privateDetail] of [
			[malformedOutputHandler, "private-output-secret"],
			[internalZodHandler, "private-zod-secret"],
		] as const) {
			const error = await Promise.resolve()
				.then(() => handler(validInput, createRequestContext(peer, productRpcMethods.sessionGet)))
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe(productRpcInternalHandlerErrorCode);
			expect((error as Error).message).not.toContain(privateDetail);
			expect((error as Error).message.length).toBeLessThan(128);
			expect((error as RpcHandlerError).data).toBeUndefined();
		}
	});

	test("classifies invalid idempotent outputs only after the operation may have committed", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const completedOperations: string[] = [];
		const handlers = createProductRpcHandlers({
			chatService: {
				createSessionIdempotently() {
					completedOperations.push("session-create");
					return { session: { schemaVersion: 1 } };
				},
				sendMessage() {
					completedOperations.push("chat-send");
					return { run: { status: "queued" } };
				},
			} as unknown as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests;
		const cases = [
			{
				method: productRpcMethods.sessionCreate,
				input: {
					schemaVersion: 1,
					createKey: crypto.randomUUID(),
					title: "New chat",
					defaultMode: "ask",
				},
			},
			{
				method: productRpcMethods.chatSend,
				input: {
					requestId: crypto.randomUUID(),
					sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
					content: "commit before output validation",
				},
			},
		] as const;

		for (const testCase of cases) {
			const handler = handlers?.[testCase.method];
			if (handler === undefined) {
				throw new Error(`Missing ${testCase.method} Product RPC handler.`);
			}
			const error = await Promise.resolve()
				.then(() => handler(testCase.input, createRequestContext(peer, testCase.method)))
				.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe(productRpcInternalHandlerErrorCode);
		}
		expect(completedOperations).toEqual(["session-create", "chat-send"]);
	});

	test("maps a conclusive missing Session to a stable product RPC error", async () => {
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			chatService: {
				getSessionPage() {
					throw new ChatSessionNotFoundError("01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce");
				},
			} as unknown as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionGet];
		if (handler === undefined) {
			throw new Error("Missing Session get product RPC handler.");
		}

		const error = await Promise.resolve()
			.then(() =>
				handler(
					{
						sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
						limit: 2,
					},
					{
						peer,
						remoteIdentity: peer.remoteIdentity,
						requestId: crypto.randomUUID(),
						traceId: crypto.randomUUID(),
						method: productRpcMethods.sessionGet,
						deadlineAt: Date.now() + 1_000,
						signal: new AbortController().signal,
					},
				),
			)
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(RpcHandlerError);
		expect((error as RpcHandlerError).code).toBe("SESSION_NOT_FOUND");
	});

	test("maps an unknown valid Session deletion to SESSION_NOT_FOUND", async () => {
		const database = openAppDatabase(":memory:");
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			chatService: {
				deleteSession(input) {
					return Promise.resolve(database.runs.deleteSessionAndRetireRuns(input.sessionId));
				},
			} as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionDelete];
		if (handler == null) {
			throw new Error("Missing Session delete product RPC handler.");
		}

		try {
			const error = await Promise.resolve()
				.then(() =>
					handler(
						{ sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce" },
						{
							peer,
							remoteIdentity: peer.remoteIdentity,
							requestId: crypto.randomUUID(),
							traceId: crypto.randomUUID(),
							method: productRpcMethods.sessionDelete,
							deadlineAt: Date.now() + 1_000,
							signal: new AbortController().signal,
						},
					),
				)
				.catch((reason: unknown) => reason);

			expect(error).toBeInstanceOf(RpcHandlerError);
			expect((error as RpcHandlerError).code).toBe("SESSION_NOT_FOUND");
		} finally {
			database.close();
		}
	});

	test("returns the same delete output through product RPC for a durable retirement retry", async () => {
		const database = openAppDatabase(":memory:");
		const session = database.sessions.create({ title: "Delete through RPC" }).session;
		const peer = createPeer({ emitEvent: () => "event", close() {} });
		const handler = createProductRpcHandlers({
			chatService: {
				deleteSession(input) {
					return Promise.resolve(database.runs.deleteSessionAndRetireRuns(input.sessionId));
				},
			} as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionDelete];
		if (handler === undefined) {
			throw new Error("Missing Session delete product RPC handler.");
		}

		try {
			const input = { sessionId: session.id };
			const first = await handler(
				input,
				createRequestContext(peer, productRpcMethods.sessionDelete),
			);
			const retried = await handler(
				input,
				createRequestContext(peer, productRpcMethods.sessionDelete),
			);
			expect(retried).toEqual(first);
			expect(retried).toEqual({ sessionId: session.id });
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	test("survives a lost create response, concurrent retry, and different full peer origin", async () => {
		const database = openAppDatabase(":memory:");
		const origin = createPeer({ emitEvent: () => "event", close() {} }, "stable-create-client", {
			instanceId: "stable-create-instance",
			generation: 3,
		});
		const otherGeneration = createPeer(
			{ emitEvent: () => "event", close() {} },
			"stable-create-client",
			{ instanceId: "other-create-instance", generation: 4 },
		);
		const handler = createProductRpcHandlers({
			chatService: {
				createSessionIdempotently(input, peerIdentity) {
					return database.sessions.createIdempotently({
						request: input,
						origin: peerIdentity,
					});
				},
			} as ChatApplicationService,
			executorReadiness: {} as ExecutorReadiness,
			eventRouter: new ProductEventRouter(),
			serverVersion: "test",
		}).requests?.[productRpcMethods.sessionCreate];
		if (handler === undefined) {
			throw new Error("Missing Session create product RPC handler.");
		}
		const input = {
			schemaVersion: 1,
			createKey: crypto.randomUUID(),
			title: "New chat",
			defaultMode: "ask",
		} as const;
		try {
			const committedButLost = await handler(
				input,
				createRequestContext(origin, productRpcMethods.sessionCreate),
			);
			const retriedAfterLoss = await handler(
				input,
				createRequestContext(origin, productRpcMethods.sessionCreate),
			);
			const [firstConcurrent, secondConcurrent] = await Promise.all([
				handler(input, createRequestContext(origin, productRpcMethods.sessionCreate)),
				handler(input, createRequestContext(origin, productRpcMethods.sessionCreate)),
			]);
			const original = createChatSessionOutputSchema.parse(committedButLost);
			expect(createChatSessionOutputSchema.parse(retriedAfterLoss)).toEqual(original);
			expect(createChatSessionOutputSchema.parse(firstConcurrent)).toEqual(original);
			expect(createChatSessionOutputSchema.parse(secondConcurrent)).toEqual(original);
			expect(database.sessions.list().items).toHaveLength(1);

			const conflict = await Promise.resolve()
				.then(() =>
					handler(input, createRequestContext(otherGeneration, productRpcMethods.sessionCreate)),
				)
				.catch((reason: unknown) => reason);
			expect(conflict).toBeInstanceOf(RpcHandlerError);
			expect((conflict as RpcHandlerError).code).toBe("SESSION_CREATE_KEY_CONFLICT");
			expect(database.sessions.list().items).toHaveLength(1);
		} finally {
			database.close();
		}
	});
});

function createPeer(
	methods: {
		emitEvent: RpcPeer["emitEvent"];
		close: RpcPeer["close"];
	},
	peerId: string = crypto.randomUUID(),
	identity: { readonly instanceId?: string; readonly generation?: number } = {},
): RpcPeer {
	return {
		remoteIdentity: {
			role: "client",
			peerId,
			instanceId: identity.instanceId ?? crypto.randomUUID(),
			generation: identity.generation ?? 1,
		},
		emitEvent: methods.emitEvent,
		close: methods.close,
	} as RpcPeer;
}

function createRequestContext(peer: RpcPeer, method: string) {
	return {
		peer,
		remoteIdentity: peer.remoteIdentity,
		requestId: crypto.randomUUID(),
		traceId: crypto.randomUUID(),
		method,
		deadlineAt: Date.now() + 1_000,
		signal: new AbortController().signal,
	};
}

function createEvent(): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: "01984df0-cf1b-7521-a4a5-40eef114ce9f",
		runId: "01984df0-cf18-7c89-9d11-3686130434c8",
		sessionId: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce",
		seq: 1,
		type: "run.status",
		source: { kind: "user" },
		visibility: "user",
		createdAt: "2026-07-25T04:15:28.349Z",
		payload: { status: "queued" },
	};
}

function createTerminalEvent(): ChatRunEvent {
	const event = createEvent();
	if (event.type !== "run.status") {
		throw new Error("Expected a Run status fixture.");
	}
	return {
		...event,
		payload: { previousStatus: "running", status: "completed" },
	};
}
