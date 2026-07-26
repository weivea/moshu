import type {
	CancelChatRunOutput,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ConfigureChatProviderInput,
	ChatProviderStatus as ContractChatProviderStatus,
	CreateChatSessionOutput,
	DeleteChatSessionOutput,
	GetChatSessionSnapshotOutput,
	ListChatSessionsOutput,
	SetChatSessionArchivedOutput,
	TestChatProviderOutput,
	UpdateChatSessionOutput,
} from "@moshu/contracts";
import { maxRetainedSessionRetirements, retiredSessionTombstoneTtlMs } from "@moshu/contracts";
import { describe, expect, test } from "vitest";

import { AgentsUnavailableError, ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import { SessionRetirementCapacityError } from "../../../../shared/session-retirement-cache";
import { createRpcChatTransport, type RpcChatClient } from "./rpc-transport";
import type {
	ChatSessionInvalidation,
	ChatSessionInvalidationSubscriptionOptions,
	ChatTransportEvent,
} from "./transport";

const providerId = "01984df0-cf16-7df0-8a4a-a1fc9dc9299d";
const sessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const runId = "01984df0-cf18-7c89-9d11-3686130434c8";
const userMessageId = "01984df0-cf19-7bb2-a5cd-69e8a802db2f";
const assistantMessageId = "01984df0-cf1a-7178-b174-42fc83c3e87d";
const eventId = "01984df0-cf1b-7521-a4a5-40eef114ce9f";
const createdAt = "2026-07-25T04:15:28.349Z";

describe("RPC Chat transport", () => {
	test("maps provider configuration, accepted messages, and persisted run events", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const events: ChatTransportEvent[] = [];
		transport.subscribe((event) => events.push(event));

		const configured = await transport.configureProvider({
			endpoint: "https://api.openai.com/v1",
			model: "gpt-4.1-mini",
			apiKey: "sk-test-secret",
		});
		expect(configured).toEqual({
			configured: true,
			endpoint: "https://api.openai.com/v1",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			apiKeyMask: "********cret",
		});
		expect(client.lastConfiguration?.apiKey).toBe("sk-test-secret");

		const session = await transport.createSession();
		expect(session.id).toBe(sessionId);
		const accepted = await transport.send({
			requestId: crypto.randomUUID(),
			sessionId,
			message: "Hello",
		});
		expect(accepted.requestId).toBe(runId);
		expect(accepted.assistantMessage.status).toBe("streaming");
		await transport.cancel({ sessionId, requestId: runId });
		expect(client.cancelInputs).toEqual([{ sessionId, runId }]);

		client.emit(createDeltaEvent("Hi"));
		client.emit(createCompletedEvent());
		expect(events.map((event) => event.type)).toEqual(["response.delta", "response.completed"]);
		expect(events[1]).toMatchObject({
			type: "response.completed",
			content: "Hi",
		});
	});

	test("restores an active response from persisted session state", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const session = await transport.getSession(sessionId);

		expect(session.activeResponse).toEqual({
			requestId: runId,
			messageId: assistantMessageId,
		});
		expect(session.messages[1]?.status).toBe("streaming");
	});

	test("drops cached and late events for an exactly retired Session", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const events: ChatTransportEvent[] = [];
		transport.subscribe((event) => events.push(event));
		await transport.getSession(sessionId);

		transport.retireSession?.(sessionId);
		client.emit(createDeltaEvent("late"));
		client.emit(createCompletedEvent());

		expect(events).toEqual([]);
		await expect(transport.getSession(sessionId)).rejects.toBeInstanceOf(ChatSessionNotFoundError);
	});

	test("expires retirement filtering at the shared TTL without affecting unrelated events", () => {
		let nowMs = 1_000;
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client, { now: () => nowMs });
		const events: ChatTransportEvent[] = [];
		transport.subscribe((event) => events.push(event));

		transport.retireSession?.("session-a");
		client.emit(createDeltaEventForSession("session-a", "run-a", "retired"));
		client.emit(createDeltaEventForSession("session-b", "run-b", "unrelated"));
		expect(events.map((event) => event.sessionId)).toEqual(["session-b"]);

		nowMs += retiredSessionTombstoneTtlMs;
		client.emit(createDeltaEventForSession("session-a", "run-a", "expired"));
		expect(events.map((event) => event.sessionId)).toEqual(["session-b", "session-a"]);
	});

	test("backpressures at retirement capacity without evicting unexpired entries", async () => {
		let nowMs = 1_000;
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client, { now: () => nowMs });
		const events: ChatTransportEvent[] = [];
		transport.subscribe((event) => events.push(event));
		for (let index = 0; index < maxRetainedSessionRetirements; index += 1) {
			transport.retireSession?.(`session-${index}`);
		}

		expect(() => transport.retireSession?.("session-overflow")).toThrow(
			SessionRetirementCapacityError,
		);
		expect(() => transport.retireSession?.("session-0")).toThrow(SessionRetirementCapacityError);
		client.emit(createDeltaEventForSession("unrelated", "run-unrelated", "blocked"));
		client.emit(createDeltaEventForSession("session-0", "run-retired", "still retired"));
		expect(events).toEqual([]);
		await expect(transport.getSession(sessionId)).rejects.toBeInstanceOf(AgentsUnavailableError);

		nowMs += retiredSessionTombstoneTtlMs;
		expect(() => transport.retireSession?.("session-overflow")).not.toThrow();
		client.emit(createDeltaEventForSession("session-overflow", "run-overflow", "retired"));
		client.emit(createDeltaEventForSession("unrelated", "run-unrelated", "healthy"));
		expect(events.map((event) => event.sessionId)).toEqual(["unrelated"]);
	});

	test("reuses the renderer idempotency key after an ambiguous send failure", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		client.failNextSend = true;
		const requestId = crypto.randomUUID();

		await expect(transport.send({ requestId, sessionId, message: "retry me" })).rejects.toThrow(
			"ambiguous send",
		);
		await transport.send({ requestId, sessionId, message: "retry me" });

		expect(client.sendInputs).toHaveLength(2);
		expect(client.sendInputs[0]?.requestId).toBe(client.sendInputs[1]?.requestId);
	});

	test("maps Provider testing and Session management operations", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);

		expect(
			await transport.testProvider({
				endpoint: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
			}),
		).toEqual({ ok: true, latencyMs: 12 });
		expect(await transport.listSessions()).toEqual([
			{
				id: sessionId,
				title: "New chat",
				createdAt,
				updatedAt: createdAt,
			},
		]);
		expect((await transport.renameSession(sessionId, "Renamed")).title).toBe("Renamed");
		expect((await transport.setSessionArchived(sessionId, true)).archivedAt).toBe(createdAt);
		await expect(transport.deleteSession(sessionId)).resolves.toBeUndefined();
	});

	test("forwards Session invalidation acknowledgement only after renderer refetch work", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const received: string[] = [];
		transport.subscribeSessionInvalidations?.(
			async (invalidation) => {
				await transport.getSession(invalidation.sessionId);
				received.push(`${invalidation.reason}:${invalidation.sessionId}`);
			},
			{ authoritative: true },
		);

		await client.emitInvalidation({
			sessionId,
			reason: "history_expired",
		});
		expect(received).toEqual([`history_expired:${sessionId}`]);
		expect(client.lastInvalidationSubscriptionOptions).toEqual({ authoritative: true });
	});
});

class FakeRpcChatClient implements RpcChatClient {
	lastConfiguration?: ConfigureChatProviderInput;
	readonly sendInputs: Array<{ requestId: string; sessionId: string; content: string }> = [];
	readonly cancelInputs: Array<{ sessionId: string; runId: string }> = [];
	lastInvalidationSubscriptionOptions?: ChatSessionInvalidationSubscriptionOptions;
	failNextSend = false;
	#listeners = new Set<(event: ChatRunEvent) => void>();
	#invalidationListeners = new Set<
		(invalidation: ChatSessionInvalidation) => void | PromiseLike<void>
	>();
	#status: ContractChatProviderStatus = {
		schemaVersion: 1,
		configured: true,
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4.1-mini",
	};

	async getChatProviderStatus() {
		return this.#status;
	}

	async configureChatProvider(input: ConfigureChatProviderInput) {
		this.lastConfiguration = input;
		this.#status = {
			schemaVersion: 1,
			configured: true,
			baseUrl: input.baseUrl,
			model: input.model,
			apiKeyMask: "********cret",
		};
		return this.#status;
	}

	async testChatProvider(): Promise<TestChatProviderOutput> {
		return {
			schemaVersion: 1,
			ok: true,
			latencyMs: 12,
		};
	}

	async deleteChatProvider() {
		this.#status = {
			schemaVersion: 1,
			configured: false,
			baseUrl: "https://api.openai.com/v1",
			model: "",
		};
		return this.#status;
	}

	async createChatSession(): Promise<CreateChatSessionOutput> {
		return {
			session: createContractSession(),
		};
	}

	async getChatSession(_sessionId: string): Promise<GetChatSessionSnapshotOutput> {
		return {
			session: createContractSession(),
			messages: [
				{
					schemaVersion: 1,
					id: userMessageId,
					sessionId,
					runId,
					role: "user",
					status: "complete",
					content: "Hello",
					sequence: 1,
					createdAt,
					updatedAt: createdAt,
				},
				createAssistantMessage(),
			],
			runs: [createRun()],
			eventCursors: [{ runId, lastSeq: 3 }],
		};
	}

	async listChatSessions(): Promise<ListChatSessionsOutput> {
		return { items: [createContractSession()] };
	}

	async updateChatSession(_sessionId: string, title: string): Promise<UpdateChatSessionOutput> {
		return { session: { ...createContractSession(), title } };
	}

	async setChatSessionArchived(
		_sessionId: string,
		archived: boolean,
	): Promise<SetChatSessionArchivedOutput> {
		return {
			session: {
				...createContractSession(),
				...(archived ? { archivedAt: createdAt } : {}),
			},
		};
	}

	async deleteChatSession(_sessionId: string): Promise<DeleteChatSessionOutput> {
		return { sessionId };
	}

	async sendChatMessage(input: {
		requestId: string;
		sessionId: string;
		content: string;
	}): Promise<ChatSendAcceptedOutput> {
		this.sendInputs.push(input);
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("ambiguous send");
		}
		return {
			run: createRun(),
			userMessage: {
				schemaVersion: 1,
				id: userMessageId,
				sessionId,
				runId,
				role: "user",
				status: "complete",
				content: "Hello",
				sequence: 1,
				createdAt,
				updatedAt: createdAt,
			},
			assistantMessage: createAssistantMessage(),
		};
	}

	async cancelChatRun(
		cancelSessionId: string,
		cancelRunId: string,
		_reason?: string,
	): Promise<CancelChatRunOutput> {
		this.cancelInputs.push({ sessionId: cancelSessionId, runId: cancelRunId });
		return {
			run: {
				...createRun(),
				status: "cancelling",
			},
		};
	}

	subscribeChatEvents(listener: (event: ChatRunEvent) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	subscribeChatSessionInvalidations(
		listener: (invalidation: ChatSessionInvalidation) => void | PromiseLike<void>,
		options?: ChatSessionInvalidationSubscriptionOptions,
	) {
		this.lastInvalidationSubscriptionOptions = options;
		this.#invalidationListeners.add(listener);
		return () => this.#invalidationListeners.delete(listener);
	}

	emit(event: ChatRunEvent) {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	async emitInvalidation(invalidation: ChatSessionInvalidation): Promise<void> {
		for (const listener of this.#invalidationListeners) {
			await listener(invalidation);
		}
	}
}

function createContractSession() {
	return {
		schemaVersion: 1 as const,
		id: sessionId,
		title: "New chat",
		defaultMode: "ask" as const,
		createdAt,
		updatedAt: createdAt,
	};
}

function createAssistantMessage() {
	return {
		schemaVersion: 1 as const,
		id: assistantMessageId,
		sessionId,
		runId,
		role: "assistant" as const,
		status: "streaming" as const,
		content: "",
		sequence: 2,
		createdAt,
		updatedAt: createdAt,
	};
}

function createRun() {
	return {
		schemaVersion: 1 as const,
		id: runId,
		sessionId,
		mode: "ask" as const,
		status: "running" as const,
		provider: {
			schemaVersion: 1 as const,
			providerId,
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4.1-mini",
			status: "ready" as const,
		},
		userMessageId,
		assistantMessageId,
		createdAt,
		updatedAt: createdAt,
	};
}

function createDeltaEvent(delta: string): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: eventId,
		runId,
		sessionId,
		seq: 4,
		type: "message.delta",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: {
			messageId: assistantMessageId,
			delta,
		},
	};
}

function createDeltaEventForSession(
	eventSessionId: string,
	eventRunId: string,
	delta: string,
): ChatRunEvent {
	return {
		...createDeltaEvent(delta),
		id: crypto.randomUUID(),
		runId: eventRunId,
		sessionId: eventSessionId,
	};
}

function createCompletedEvent(): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: "01984df0-cf1c-793f-bc2c-df399f25cd1d",
		runId,
		sessionId,
		seq: 5,
		type: "message.completed",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: {
			messageId: assistantMessageId,
			status: "complete",
			content: "Hi",
		},
	};
}
