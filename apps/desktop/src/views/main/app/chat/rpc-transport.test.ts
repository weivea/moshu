import { describe, expect, test } from "vitest";

import type {
	CancelChatRunOutput,
	ChatProviderStatus as ContractChatProviderStatus,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ConfigureChatProviderInput,
	CreateChatSessionOutput,
	DeleteChatSessionOutput,
	GetChatSessionSnapshotOutput,
	ListChatSessionsOutput,
	SetChatSessionArchivedOutput,
	TestChatProviderOutput,
	UpdateChatSessionOutput,
} from "@moshu/contracts";

import { createRpcChatTransport, type RpcChatClient } from "./rpc-transport";
import type { ChatTransportEvent } from "./transport";

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
			sessionId,
			message: "Hello",
		});
		expect(accepted.requestId).toBe(runId);
		expect(accepted.assistantMessage.status).toBe("streaming");

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
});

class FakeRpcChatClient implements RpcChatClient {
	lastConfiguration?: ConfigureChatProviderInput;
	#listeners = new Set<(event: ChatRunEvent) => void>();
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

	async sendChatMessage(_input: {
		sessionId: string;
		content: string;
	}): Promise<ChatSendAcceptedOutput> {
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

	async cancelChatRun(_runId: string, _reason?: string): Promise<CancelChatRunOutput> {
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

	emit(event: ChatRunEvent) {
		for (const listener of this.#listeners) {
			listener(event);
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
