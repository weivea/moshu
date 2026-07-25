import { describe, expect, test } from "bun:test";

import {
	AskChatCancelledError,
	AskChatRuntimeError,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	InMemoryAskProviderConfigStore,
} from "@moshu/agent-runtime";
import type { ChatRunEvent } from "@moshu/contracts";
import { openAppDatabase } from "@moshu/database";

import { DesktopChatService } from "./chat-service";

describe("DesktopChatService", () => {
	test("persists every streamed event before publishing it", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({
			deltas: ["Hello", " world"],
		});
		const service = createService(database.chat, runtime, scheduler);
		const publishedEvents: ChatRunEvent[] = [];

		try {
			configureProvider(service);
			const { session } = service.createSession();
			service.subscribe((event) => {
				const persistedIds = database.chat
					.replayRunEvents({ runId: event.runId })
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

			const restored = service.getSession({ sessionId: session.id });
			expect(restored.messages.map((message) => message.content)).toEqual([
				"Say hello",
				"Hello world",
			]);
			expect(restored.messages[1]?.status).toBe("complete");
			expect(restored.runs[0]?.status).toBe("completed");
			expect(runtime.inputs[0]?.messages).toEqual([{ role: "user", content: "Say hello" }]);
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

	test("cancels the runtime and persists partial assistant content", async () => {
		const database = openAppDatabase(":memory:");
		const scheduler = new ManualScheduler();
		const runtime = new FakeAskChatRuntime({ pending: true });
		const service = createService(database.chat, runtime, scheduler);

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

			const restored = service.getSession({ sessionId: session.id });
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
		const service = createService(database.chat, runtime, scheduler);

		try {
			configureProvider(service);
			const status = service.getProviderStatus();
			expect(status).toEqual({
				schemaVersion: 1,
				configured: true,
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
			});
			expect("apiKey" in status).toBe(false);

			const { session } = service.createSession();
			service.sendMessage({
				sessionId: session.id,
				content: "Authenticate",
			});
			scheduler.runAll();
			await service.waitForIdle();

			const restored = service.getSession({ sessionId: session.id });
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
});

function createService(
	repository: ReturnType<typeof openAppDatabase>["chat"],
	runtime: AskChatRuntime,
	scheduler: ManualScheduler,
) {
	return new DesktopChatService({
		repository,
		providerConfigStore: new InMemoryAskProviderConfigStore(),
		runtime,
		schedule: scheduler.schedule,
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
	readonly started: Promise<void>;
	readonly #deltas: string[];
	readonly #pending: boolean;
	readonly #error?: AskChatRuntimeError;
	readonly #pendingRuns = new Map<string, { reject(error: AskChatCancelledError): void }>();
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

	async shutdown(): Promise<void> {
		for (const runId of [...this.#pendingRuns.keys()]) {
			this.cancel(runId, "Shutdown");
		}
	}
}
