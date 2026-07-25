import { describe, expect, test } from "bun:test";

import {
	AskChatCancelledError,
	AskChatRuntimeError,
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	type AskProviderConfiguration,
	type AskProviderConfigStore,
	InMemoryAskProviderConfigStore,
} from "@moshu/agent-runtime";
import type { ChatRunEvent } from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "@moshu/database";

import { DesktopChatService } from "./chat-service";

describe("DesktopChatService", () => {
	test("persists every streamed event before publishing it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: ["Hello", " world"],
		});
		const service = createService(database, runtime, scheduler);
		const publishedEvents: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe((event) => {
				const persistedIds = database.runs
					.listEvents({ runId: event.runId })
					.map((persistedEvent) => persistedEvent.id);
				expect(persistedIds).toContain(event.id);
				publishedEvents.push(event);
			});

			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "Say hello",
			});

			expect(accepted.run.status).toBe("queued");
			expect(accepted.assistantMessage.status).toBe("streaming");
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.session.title).toBe("Say hello");
			expect(restored.messages.map((message) => message.content)).toEqual([
				"Say hello",
				"Hello world",
			]);
			expect(restored.messages[1]?.status).toBe("complete");
			expect(restored.runs[0]?.status).toBe("completed");
			expect(runtime.inputs[0]?.threadId).toBe(session.id);
			expect(
				runtime.inputs[0]?.messages.map(({ role, content }) => ({
					role,
					content,
				})),
			).toEqual([{ role: "user", content: "Say hello" }]);
			expect(publishedEvents.map((event) => event.type)).toEqual([
				"run.status",
				"message.delta",
				"message.delta",
				"message.completed",
				"run.status",
			]);
			const eventCount = publishedEvents.length;
			expect(
				service.cancel({
					runId: accepted.run.id,
					reason: "Late stop click",
				}).run.status,
			).toBe("completed");
			expect(publishedEvents).toHaveLength(eventCount);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("submits only the current turn and lets Deep Agents restore prior messages", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["Reply"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();

			service.sendMessage({ sessionId: session.id, content: "First question" });
			scheduler.runAll();
			await service.waitForIdle();
			service.sendMessage({
				sessionId: session.id,
				content: "Second question",
			});
			scheduler.runAll();
			await service.waitForIdle();

			expect(
				runtime.inputs.map((input) =>
					input.messages.map(({ role, content }) => ({ role, content })),
				),
			).toEqual([
				[{ role: "user", content: "First question" }],
				[{ role: "user", content: "Second question" }],
			]);
			expect(runtime.inputs.map((input) => input.threadId)).toEqual([session.id, session.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("cancels the runtime and persists partial assistant content", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ pending: true });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({
				sessionId: session.id,
				content: "Keep talking",
			});

			scheduler.runAll();
			await runtime.started;
			const cancelResult = service.cancel({
				runId: accepted.run.id,
				reason: "User stopped the response.",
			});
			expect(cancelResult.run.status).toBe("cancelling");
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			expect(restored.messages[1]?.status).toBe("cancelled");
			expect(restored.runs[0]?.status).toBe("cancelled");
			expect(runtime.cancelledRunIds).toEqual([accepted.run.id]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("persists safe provider errors without exposing credentials", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			error: new AskChatRuntimeError({
				kind: "provider_authentication",
				message: "Provider authentication failed.",
				retryable: false,
				statusCode: 401,
			}),
		});
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const status = service.getProviderStatus();
			expect(status).toEqual({
				schemaVersion: 1,
				configured: true,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
				apiKeyMask: "••••••••cret",
			});
			expect("apiKey" in status).toBe(false);

			const { session } = service.createSession();
			service.sendMessage({
				sessionId: session.id,
				content: "Authenticate",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const restored = await service.getSession({ sessionId: session.id });
			const assistant = restored.messages[1];
			expect(assistant?.status).toBe("failed");
			if (assistant?.status !== "failed") {
				throw new Error("Expected a failed assistant message.");
			}
			expect(assistant.error.safeMessage).toBe("Provider authentication failed.");
			expect(JSON.stringify(restored)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps the saved API key when updating Provider fields on the same origin", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const store = new InMemoryAskProviderConfigStore();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providerConfigStore: store,
		});

		try {
			configureProvider(service);
			service.configureProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/compatible/v1",
				model: "updated-model",
			});

			expect(store.get()).toEqual({
				provider: "openai-compatible",
				baseUrl: "https://api.openai.com/compatible/v1",
				model: "updated-model",
				apiKey: "sk-test-secret",
			});
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("requires a new API key before sending credentials to another origin", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const testedConfigurations: AskProviderConfiguration[] = [];
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async (configuration) => {
				testedConfigurations.push(configuration);
			},
		});

		try {
			configureProvider(service);
			expect(() =>
				service.configureProvider({
					schemaVersion: 1,
					baseUrl: "https://untrusted.example/v1",
					model: "updated-model",
				}),
			).toThrow("new API key");

			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://untrusted.example/v1",
				model: "updated-model",
			});
			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toContain("new API key");
			expect(testedConfigurations).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("tests Provider settings without exposing the API key", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const testedConfigurations: AskProviderConfiguration[] = [];
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async (configuration) => {
				testedConfigurations.push(configuration);
			},
		});

		try {
			configureProvider(service);
			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
			});

			expect(output.ok).toBe(true);
			expect(testedConfigurations[0]?.apiKey).toBe("sk-test-secret");
			expect(JSON.stringify(output)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("maps Provider connection failures to safe errors", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			testProviderConnection: async () => {
				throw new AskChatRuntimeError({
					kind: "provider_authentication",
					message: "Provider authentication failed.",
					retryable: false,
					statusCode: 401,
				});
			},
		});

		try {
			const output = await service.testProvider({
				schemaVersion: 1,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
				apiKey: "sk-test-secret",
			});

			expect(output.ok).toBe(false);
			expect(output.error?.safeMessage).toBe("Provider authentication failed.");
			expect(JSON.stringify(output)).not.toContain("sk-test-secret");
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("deletes the saved Provider configuration", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const store = new InMemoryAskProviderConfigStore();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler, {
			providerConfigStore: store,
		});

		try {
			configureProvider(service);
			const status = service.deleteProvider();

			expect(status.configured).toBe(false);
			expect(store.get()).toBeNull();
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("lists, renames, archives, restores, and deletes Sessions", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ deltas: ["Done"] });
		const service = createService(database, runtime, scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.sendMessage({ sessionId: session.id, content: "Plan a launch" });
			scheduler.runAll();
			await service.waitForIdle();

			expect(service.listSessions({ query: "launch" }).items[0]?.id).toBe(session.id);
			expect(
				service.updateSession({ sessionId: session.id, title: "Launch plan" }).session.title,
			).toBe("Launch plan");
			expect(
				service.setSessionArchived({ sessionId: session.id, archived: true }).session.archivedAt,
			).toBeDefined();
			expect(service.listSessions({ archived: true }).items[0]?.id).toBe(session.id);
			expect(
				service.setSessionArchived({ sessionId: session.id, archived: false }).session.archivedAt,
			).toBeUndefined();
			expect(await service.deleteSession({ sessionId: session.id })).toEqual({
				sessionId: session.id,
			});
			expect(runtime.deletedThreadIds).toEqual([session.id]);
			expect(service.listSessions().items).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("blocks archiving and deleting a Session with an active response", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({ pending: true }), scheduler);

		try {
			configureProvider(service);
			const { session } = service.createSession();
			const accepted = service.sendMessage({ sessionId: session.id, content: "Wait" });

			expect(() => service.setSessionArchived({ sessionId: session.id, archived: true })).toThrow(
				"Stop the active response",
			);
			expect(() => service.deleteSession({ sessionId: session.id })).toThrow(
				"Stop the active response",
			);
			expect(() =>
				service.configureProvider({
					schemaVersion: 1,
					baseUrl: "https://example.test/v1",
					model: "another-model",
				}),
			).toThrow("Stop active responses");
			expect(() => service.deleteProvider()).toThrow("Stop active responses");
			service.cancel({ runId: accepted.run.id });
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("finalizes orphaned Runs after an application restart", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const service = createService(database, new FakeAskChatRuntime({}), scheduler);
		const cancelling = createOrphanedRun(database, "cancelling");
		const running = createOrphanedRun(database, "running");
		const deleting = createOrphanedRun(database, "running");

		try {
			expect(service.cancel({ runId: cancelling.runId }).run.status).toBe("cancelled");
			expect(
				(await service.getSession({ sessionId: cancelling.sessionId })).messages.at(-1)?.status,
			).toBe("cancelled");

			expect(
				service.setSessionArchived({
					sessionId: running.sessionId,
					archived: true,
				}).session.archivedAt,
			).toBeDefined();
			const recovered = await service.getSession({
				sessionId: running.sessionId,
			});
			expect(recovered.runs[0]?.status).toBe("cancelled");
			expect(recovered.messages.at(-1)?.status).toBe("cancelled");

			await service.deleteSession({ sessionId: deleting.sessionId });
			await expect(service.getSession({ sessionId: deleting.sessionId })).rejects.toThrow();
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});

function createOrphanedRun(
	database: ReturnType<typeof openAppDatabase>,
	status: "running" | "cancelling",
) {
	const { session } = database.sessions.create({ title: "Interrupted chat" });
	const created = database.runs.create({
		sessionId: session.id,
		mode: "ask",
		provider: {
			schemaVersion: 1,
			providerId: createUuidV7(),
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-4.1-mini",
			apiKey: "sk-test-secret",
		},
		userMessageId: createUuidV7(),
		assistantMessageId: createUuidV7(),
	});
	database.runs.updateStatus({ runId: created.run.id, status: "running" });
	if (status === "cancelling") {
		database.runs.updateStatus({ runId: created.run.id, status: "cancelling" });
	}
	return { sessionId: session.id, runId: created.run.id };
}

function createService(
	database: ReturnType<typeof openAppDatabase>,
	runtime: AskChatRuntime,
	scheduler: ManualScheduler,
	options: {
		providerConfigStore?: AskProviderConfigStore;
		testProviderConnection?: (configuration: AskProviderConfiguration) => Promise<void>;
	} = {},
) {
	return new DesktopChatService({
		sessions: database.sessions,
		runs: database.runs,
		providerConfigStore: options.providerConfigStore ?? new InMemoryAskProviderConfigStore(),
		runtime,
		schedule: scheduler.schedule,
		...(options.testProviderConnection === undefined
			? {}
			: { testProviderConnection: options.testProviderConnection }),
	});
}

function configureProvider(service: DesktopChatService): void {
	service.configureProvider({
		schemaVersion: 1,
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-4.1-mini",
		apiKey: "sk-test-secret",
	});
}

class ManualScheduler {
	readonly #tasks: Array<() => void> = [];
	readonly schedule = (task: () => void) => {
		this.#tasks.push(task);
	};

	runAll(): void {
		for (const task of this.#tasks.splice(0)) {
			task();
		}
	}
}

class FakeAskChatRuntime implements AskChatRuntime {
	readonly inputs: AskChatRunInput[] = [];
	readonly cancelledRunIds: string[] = [];
	readonly deletedThreadIds: string[] = [];
	readonly started: Promise<void>;
	readonly #deltas: string[];
	readonly #pending: boolean;
	readonly #error?: AskChatRuntimeError;
	readonly #pendingRuns = new Map<string, { reject(error: AskChatCancelledError): void }>();
	readonly #threadMessages = new Map<string, AskChatMessage[]>();
	#resolveStarted: () => void = () => {};

	constructor(options: {
		deltas?: string[];
		pending?: boolean;
		error?: AskChatRuntimeError;
	}) {
		this.#deltas = options.deltas ?? [];
		this.#pending = options.pending ?? false;
		this.#error = options.error;
		this.started = new Promise((resolve) => {
			this.#resolveStarted = resolve;
		});
	}

	async run(input: AskChatRunInput): Promise<AskChatRunResult> {
		this.inputs.push(input);
		this.#resolveStarted();
		const threadId = input.threadId ?? input.runId;
		const messages = this.#threadMessages.get(threadId) ?? [];
		messages.push(...input.messages.map((message) => ({ ...message })));
		this.#threadMessages.set(threadId, messages);

		if (this.#error !== undefined) {
			throw this.#error;
		}

		if (this.#pending) {
			return new Promise<AskChatRunResult>((_resolve, reject) => {
				this.#pendingRuns.set(input.runId, { reject });
			});
		}

		for (const delta of this.#deltas) {
			await input.onEvent?.({
				type: "message.delta",
				runId: input.runId,
				delta,
			});
		}
		messages.push({ role: "assistant", content: this.#deltas.join("") });

		return {
			runId: input.runId,
			text: this.#deltas.join(""),
		};
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("FakeAskChatRuntime.stream is not used by DesktopChatService.");
	}

	cancel(runId: string, reason?: string): boolean {
		const pending = this.#pendingRuns.get(runId);
		if (pending === undefined) {
			return false;
		}

		this.cancelledRunIds.push(runId);
		this.#pendingRuns.delete(runId);
		pending.reject(new AskChatCancelledError(runId, reason));
		return true;
	}

	async deleteThread(threadId: string): Promise<void> {
		this.deletedThreadIds.push(threadId);
		this.#threadMessages.delete(threadId);
	}

	async getThreadMessages(threadId: string): Promise<AskChatMessage[]> {
		return (this.#threadMessages.get(threadId) ?? []).map((message) => ({
			...message,
		}));
	}

	async shutdown(): Promise<void> {
		for (const runId of [...this.#pendingRuns.keys()]) {
			this.cancel(runId, "Shutdown");
		}
	}
}
