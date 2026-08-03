import type {
	CancelChatRunOutput,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	CreateChatSessionOutput,
	CreateProviderInput,
	DeleteChatSessionOutput,
	DeleteProviderOutput,
	FetchProviderModelsOutput,
	GetChatSessionSnapshotOutput,
	GetDefaultModelOutput,
	ListAvailableModelsOutput,
	ListChatSessionsInput,
	ListChatSessionsOutput,
	ListProvidersOutput,
	ProviderAuthAttemptOutput,
	ProviderMutationOutput,
	ProviderSummary,
	RespondProviderAuthInput,
	SetChatSessionArchivedOutput,
	SetChatSessionModelInput,
	SetChatSessionModelOutput,
	SetDefaultModelInput,
	SetDefaultModelOutput,
	SetProviderModelsEnabledInput,
	SetProviderModelsEnabledOutput,
	StartProviderAuthInput,
	TestProviderInput,
	TestProviderOutput,
	UpdateChatSessionOutput,
	UpdateProviderInput,
} from "@moshu/contracts";
import {
	defaultLocalRuntimeBoxId,
	maxRetainedSessionRetirements,
	retiredSessionTombstoneTtlMs,
} from "@moshu/contracts";
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
const projectId = "01984df0-cf1c-7521-a4a5-40eef114ce9f";
const createdAt = "2026-07-25T04:15:28.349Z";

function createAuthAttempt(
	authProviderId: string,
	authType: "api_key" | "oauth",
	status: "completed" | "cancelled" = "completed",
): ProviderAuthAttemptOutput {
	return {
		attempt: {
			schemaVersion: 2,
			id: "01984df0-cf1b-7521-a4a5-40eef114ce9f",
			providerId: authProviderId,
			authType,
			status,
			createdAt,
			updatedAt: createdAt,
			notifications: [],
		},
	};
}

describe("RPC Chat transport", () => {
	test("maps provider configuration, accepted messages, and persisted run events", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const events: ChatTransportEvent[] = [];
		transport.subscribe((event) => events.push(event));

		const created = await transport.createProvider({
			schemaVersion: 2,
			displayName: "OpenAI",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test-secret",
		});
		expect(created).toEqual({
			schemaVersion: 2,
			id: providerId,
			displayName: "OpenAI",
			source: "custom",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			enabled: true,
			authMethods: ["api_key"],
			credential: { configured: true, type: "api_key" },
			customHeaderNames: [],
			models: [],
		});
		expect(client.lastCreateInput?.apiKey).toBe("sk-test-secret");

		const session = await transport.createSession();
		expect(session.id).toBe(sessionId);
		const accepted = await transport.send({
			requestId: crypto.randomUUID(),
			sessionId,
			message: "Hello",
		});
		expect(accepted.requestId).toBe(runId);
		expect(accepted.run.timeline[0]?.status).toBe("streaming");
		await transport.cancel({ sessionId, requestId: runId });
		expect(client.cancelInputs).toEqual([{ sessionId, runId }]);

		client.emit(createDeltaEvent("Hi"));
		client.emit(createWarningEvent());
		client.emit(createCompletedEvent());
		expect(events.map((event) => event.type)).toEqual([
			"timeline.text.delta",
			"run.warning",
			"timeline.text.completed",
		]);
		expect(events[1]).toMatchObject({
			type: "run.warning",
			payload: {
				code: "ROOT_AGENTS_SKIPPED",
				reason: "too_large",
			},
		});
		expect(events[2]).toMatchObject({
			type: "timeline.text.completed",
			payload: { part: { content: "Hi" } },
		});
	});

	test("restores an active response from persisted session state", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const session = await transport.getSession(sessionId);

		expect(session.activeResponse).toEqual({
			requestId: runId,
		});
		expect(session.runs[0]?.timeline[0]?.status).toBe("streaming");
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

		expect(await transport.testProvider({ schemaVersion: 2, providerId })).toEqual({
			ok: true,
			latencyMs: 12,
		});

		expect(await transport.listSessions()).toEqual([
			{
				id: sessionId,
				runtimeBoxId: defaultLocalRuntimeBoxId,
				title: "New chat",
				createdAt,
				updatedAt: createdAt,
			},
		]);
		expect((await transport.renameSession(sessionId, "Renamed")).title).toBe("Renamed");
		expect((await transport.setSessionArchived(sessionId, true)).archivedAt).toBe(createdAt);
		await expect(transport.deleteSession(sessionId)).resolves.toBeUndefined();
	});

	test("forwards Project Session ownership and explicit list scope", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);

		await expect(transport.createSession(undefined, projectId)).resolves.toMatchObject({
			projectId,
		});
		await transport.listSessions({ scope: { kind: "project", projectId } });

		expect(client.lastCreateProjectId).toBe(projectId);
		expect(client.lastListInput).toEqual({ scope: { kind: "project", projectId } });
	});

	test("forwards Provider authentication and logout without retaining secret responses", async () => {
		const client = new FakeRpcChatClient();
		const transport = createRpcChatTransport(client);
		const started = await transport.startProviderAuth(providerId, "api_key");
		await transport.respondProviderAuth(started.id, eventId, "fake-input-only-secret");
		await transport.getProviderAuth(started.id);
		expect((await transport.cancelProviderAuth(started.id)).status).toBe("cancelled");
		await transport.logoutProvider(providerId);
		expect(client.authCalls).toEqual(["start:api_key", "respond", "get", "cancel", "logout"]);
		expect(JSON.stringify(client.authCalls)).not.toContain("fake-input-only-secret");
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
	lastCreateInput?: CreateProviderInput;
	lastUpdateInput?: UpdateProviderInput;
	lastSetModelsInput?: SetProviderModelsEnabledInput;
	lastSetDefaultInput?: SetDefaultModelInput;
	lastSetSessionModelInput?: SetChatSessionModelInput;
	lastCreateProjectId?: string;
	lastListInput?: ListChatSessionsInput;
	readonly sendInputs: Array<{ requestId: string; sessionId: string; content: string }> = [];
	readonly cancelInputs: Array<{ sessionId: string; runId: string }> = [];
	readonly authCalls: string[] = [];
	lastInvalidationSubscriptionOptions?: ChatSessionInvalidationSubscriptionOptions;
	failNextSend = false;
	#listeners = new Set<(event: ChatRunEvent) => void>();
	#invalidationListeners = new Set<
		(invalidation: ChatSessionInvalidation) => void | PromiseLike<void>
	>();

	async listProviders(): Promise<ListProvidersOutput> {
		return { schemaVersion: 2, providers: [] };
	}

	async createProvider(input: CreateProviderInput): Promise<ProviderMutationOutput> {
		this.lastCreateInput = input;
		return {
			schemaVersion: 2,
			provider: createProviderSummary({
				displayName: input.displayName,
				api: input.api,
				baseUrl: input.baseUrl,
				customHeaderNames: Object.keys(input.customHeaders ?? {}),
			}),
		};
	}

	async updateProvider(input: UpdateProviderInput): Promise<ProviderMutationOutput> {
		this.lastUpdateInput = input;
		return { schemaVersion: 2, provider: createProviderSummary() };
	}

	async deleteProvider(deleteProviderId: string): Promise<DeleteProviderOutput> {
		return { schemaVersion: 2, providerId: deleteProviderId };
	}

	async testProvider(_input: TestProviderInput): Promise<TestProviderOutput> {
		return { schemaVersion: 2, ok: true, latencyMs: 12 };
	}

	async fetchProviderModels(_providerId: string): Promise<FetchProviderModelsOutput> {
		return { schemaVersion: 2, provider: createProviderSummary() };
	}

	async setProviderModelsEnabled(
		input: SetProviderModelsEnabledInput,
	): Promise<SetProviderModelsEnabledOutput> {
		this.lastSetModelsInput = input;
		return { schemaVersion: 2, provider: createProviderSummary() };
	}

	async providerAuthStart(input: StartProviderAuthInput): Promise<ProviderAuthAttemptOutput> {
		this.authCalls.push(`start:${input.authType}`);
		return createAuthAttempt(input.providerId, input.authType);
	}

	async providerAuthGet(_attemptId: string): Promise<ProviderAuthAttemptOutput> {
		this.authCalls.push("get");
		return createAuthAttempt(providerId, "api_key");
	}

	async providerAuthRespond(_input: RespondProviderAuthInput): Promise<ProviderAuthAttemptOutput> {
		this.authCalls.push("respond");
		return createAuthAttempt(providerId, "api_key");
	}

	async providerAuthCancel(_attemptId: string): Promise<ProviderAuthAttemptOutput> {
		this.authCalls.push("cancel");
		return createAuthAttempt(providerId, "api_key", "cancelled");
	}

	async providerLogout(_providerId: string): Promise<unknown> {
		this.authCalls.push("logout");
		return { schemaVersion: 2, providerId, configured: false };
	}

	async openExternalUrl(_url: string): Promise<{ opened: boolean }> {
		return { opened: true };
	}

	async listAvailableModels(): Promise<ListAvailableModelsOutput> {
		return { schemaVersion: 2, models: [] };
	}

	async getDefaultModel(): Promise<GetDefaultModelOutput> {
		return { schemaVersion: 2 };
	}

	async setDefaultModel(input: SetDefaultModelInput): Promise<SetDefaultModelOutput> {
		this.lastSetDefaultInput = input;
		return {
			schemaVersion: 2,
			...(input.defaultModel === null ? {} : { defaultModel: input.defaultModel }),
		};
	}

	async setChatSessionModel(input: SetChatSessionModelInput): Promise<SetChatSessionModelOutput> {
		this.lastSetSessionModelInput = input;
		return {
			session: {
				...createContractSession(),
				...(input.model === null ? {} : { model: input.model }),
			},
		};
	}

	async createChatSession(
		_model?: SetChatSessionModelInput["model"],
		createProjectId?: string,
	): Promise<CreateChatSessionOutput> {
		this.lastCreateProjectId = createProjectId;
		return {
			session: {
				...createContractSession(),
				...(createProjectId === undefined ? {} : { projectId: createProjectId }),
			},
		};
	}

	async getChatSession(_sessionId: string): Promise<GetChatSessionSnapshotOutput> {
		return {
			session: createContractSession(),
			runs: [createRun()],
		};
	}

	async listChatSessions(input: ListChatSessionsInput = {}): Promise<ListChatSessionsOutput> {
		this.lastListInput = input;
		return {
			items: [
				{
					...createContractSession(),
					...(input.scope?.kind === "project" ? { projectId: input.scope.projectId } : {}),
				},
			],
		};
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
		agentSessionId: sessionId,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		title: "New chat",
		defaultMode: "ask" as const,
		createdAt,
		updatedAt: createdAt,
	};
}

function createProviderSummary(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
	return {
		schemaVersion: 2,
		id: providerId,
		displayName: "OpenAI",
		source: "custom",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		enabled: true,
		authMethods: ["api_key"],
		credential: { configured: true, type: "api_key" },
		customHeaderNames: [],
		models: [],
		...overrides,
	};
}

function createAssistantMessage() {
	return {
		schemaVersion: 1 as const,
		id: assistantMessageId,
		runId,
		position: 1,
		assistantTurnId: "01984df0-cf19-759c-a34b-42eaf39d8871",
		revision: 1,
		kind: "text" as const,
		status: "streaming" as const,
		content: "",
		createdAt,
		updatedAt: createdAt,
	};
}

function createRun() {
	return {
		schemaVersion: 1 as const,
		id: runId,
		sessionId,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		mode: "ask" as const,
		status: "running" as const,
		provider: {
			schemaVersion: 1 as const,
			providerId,
			name: "OpenAI",
			source: "custom" as const,
			api: "openai-responses",
			model: "gpt-4.1-mini",
			status: "ready" as const,
		},
		userMessageId,
		createdAt,
		updatedAt: createdAt,
		userMessage: {
			schemaVersion: 1 as const,
			id: userMessageId,
			sessionId,
			runId,
			role: "user" as const,
			content: "Hello",
			createdAt,
		},
		timeline: [createAssistantMessage()],
		lastEventSeq: 3,
	};
}

function createDeltaEvent(delta: string): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: eventId,
		runId,
		sessionId,
		seq: 4,
		type: "timeline.text.delta",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: {
			partId: assistantMessageId,
			revision: 2,
			delta,
		},
	};
}

function createWarningEvent(): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: crypto.randomUUID(),
		runId,
		sessionId,
		seq: 5,
		type: "run.warning",
		source: { kind: "system" },
		visibility: "user",
		createdAt,
		payload: {
			code: "ROOT_AGENTS_SKIPPED",
			reason: "too_large",
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
		seq: 6,
		type: "timeline.text.completed",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt,
		payload: {
			part: {
				...createAssistantMessage(),
				revision: 3,
				status: "completed",
				content: "Hi",
			},
		},
	};
}
