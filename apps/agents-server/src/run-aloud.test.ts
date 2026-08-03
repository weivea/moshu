import { expect, test } from "bun:test";
import type {
	AskChatMessage,
	AskChatRunInput,
	AskChatRunResult,
	AskChatRunStream,
	AskChatRuntime,
	ProviderRecord,
	ProviderRegistry,
} from "@moshu/agent-runtime";
import type { ChatRunEvent, ProviderModel, ToolPublicPayload } from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "@moshu/database";
import { ChatApplicationService } from "./chat-application-service";

test("projects interleaved runtime text and parallel tools into a durable Run timeline", async () => {
	const database = openAppDatabase(":memory:");
	const scheduler = new ManualScheduler();
	const runtime = new InterleavedRuntime();
	const service = new ChatApplicationService({
		sessions: database.sessions,
		runs: database.runs,
		actions: database.actions,
		providers: createProviderRegistry(),
		runtime,
		schedule: scheduler.schedule,
	});
	const published: ChatRunEvent[] = [];

	try {
		const { session } = service.createSession();
		service.subscribe((event) => {
			expect(
				database.runs.listEvents({ runId: event.runId }).some((stored) => stored.id === event.id),
			).toBe(true);
			published.push(event);
		});

		const accepted = service.sendMessage({
			sessionId: session.id,
			content: "Inspect and answer.",
		});
		expect(accepted.run.timeline).toEqual([]);
		expect(accepted.run.status).toBe("queued");

		scheduler.runAll();
		await service.waitForIdle();

		const snapshot = await service.getSession({ sessionId: session.id });
		const run = snapshot.runs[0];
		expect(run?.status).toBe("completed");
		expect(run?.timeline.map((part) => part.kind)).toEqual([
			"text",
			"tool",
			"tool",
			"text",
			"tool",
			"text",
		]);
		expect(run?.timeline.map((part) => part.position)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(
			run?.timeline.filter((part) => part.kind === "text").map((part) => part.content),
		).toEqual(["A", "B", "C"]);
		expect(
			run?.timeline.filter((part) => part.kind === "tool").map((part) => part.toolCallId),
		).toEqual(["call-1", "call-2", "call-3"]);
		expect(
			run?.timeline.filter((part) => part.kind === "tool").map((part) => part.output?.value),
		).toEqual(["one", "two", "three"]);
		expect(published.at(-1)?.type).toBe("run.status");
		expect(run?.lastEventSeq).toBe(published.at(-1)?.seq);
	} finally {
		await service.shutdown();
		database.close();
	}
});

class InterleavedRuntime implements AskChatRuntime {
	async run(input: AskChatRunInput): Promise<AskChatRunResult> {
		await emitText(input, 1, 0, "A");
		await emitToolCall(input, 1, 1, "call-1", "read", "Read first file");
		await emitToolCall(input, 1, 2, "call-2", "grep", "Search second value");
		await emitToolProgress(input, "call-1", "read", "reading");
		await emitToolProgress(input, "call-2", "grep", "searching");
		await emitToolResult(input, "call-2", "grep", "two");
		await emitToolResult(input, "call-1", "read", "one");
		await emitText(input, 2, 0, "B");
		await emitToolCall(input, 2, 1, "call-3", "ls", "List directory");
		await emitToolResult(input, "call-3", "ls", "three");
		await emitText(input, 3, 0, "C");
		return { runId: input.runId, text: "C" };
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("Not used.");
	}

	cancel(): boolean {
		return false;
	}

	async getThreadMessages(): Promise<AskChatMessage[]> {
		return [];
	}

	async deleteThread(): Promise<void> {}

	async shutdown(): Promise<void> {}
}

class ManualScheduler {
	readonly #tasks: Array<() => void> = [];
	readonly schedule = (task: () => void): void => {
		this.#tasks.push(task);
	};

	runAll(): void {
		for (const task of this.#tasks.splice(0)) {
			task();
		}
	}
}

async function emitText(
	input: AskChatRunInput,
	turnIndex: number,
	contentIndex: number,
	content: string,
): Promise<void> {
	await input.onEvent?.({
		type: "assistant.text.started",
		runId: input.runId,
		turnIndex,
		contentIndex,
	});
	await input.onEvent?.({
		type: "assistant.text.delta",
		runId: input.runId,
		turnIndex,
		contentIndex,
		delta: content,
	});
	await input.onEvent?.({
		type: "assistant.text.completed",
		runId: input.runId,
		turnIndex,
		contentIndex,
		content,
	});
}

async function emitToolCall(
	input: AskChatRunInput,
	turnIndex: number,
	contentIndex: number,
	toolCallId: string,
	name: "read" | "grep" | "ls",
	summary: string,
): Promise<void> {
	await input.onEvent?.({
		type: "tool.call.created",
		runId: input.runId,
		turnIndex,
		contentIndex,
		toolCallId,
		tool: { kind: "builtin", name },
		input: payload({ path: "." }),
		summary,
	});
}

async function emitToolProgress(
	input: AskChatRunInput,
	toolCallId: string,
	name: "read" | "grep",
	progress: string,
): Promise<void> {
	await input.onEvent?.({
		type: "tool.execution.updated",
		runId: input.runId,
		toolCallId,
		tool: { kind: "builtin", name },
		progress: payload(progress),
	});
}

async function emitToolResult(
	input: AskChatRunInput,
	toolCallId: string,
	name: "read" | "grep" | "ls",
	output: string,
): Promise<void> {
	await input.onEvent?.({
		type: "tool.execution.completed",
		runId: input.runId,
		toolCallId,
		tool: { kind: "builtin", name },
		output: payload(output),
		isError: false,
	});
}

function payload(value: ToolPublicPayload["value"]): ToolPublicPayload {
	return {
		format: typeof value === "string" ? "text" : "json",
		value,
		truncated: false,
		redactionCount: 0,
	};
}

function createProviderRegistry(): ProviderRegistry {
	const model: ProviderModel = {
		id: "deterministic",
		displayName: "Deterministic",
		api: "openai-responses",
		input: ["text"],
		reasoning: false,
		contextWindowTokens: 32_000,
		maxOutputTokens: 4_096,
		thinkingLevels: ["off"],
		enabled: true,
	};
	const provider: ProviderRecord = {
		id: createUuidV7(),
		displayName: "Test Provider",
		source: "custom",
		api: "openai-responses",
		baseUrl: "https://example.invalid/v1",
		enabled: true,
		authMethods: ["api_key"],
		credential: { configured: true, type: "api_key" },
		customHeaderNames: [],
		models: [model],
	};
	const selection = { providerId: provider.id, modelId: model.id };
	return {
		list: () => [structuredClone(provider)],
		get: (providerId) => (providerId === provider.id ? structuredClone(provider) : null),
		create: async () => structuredClone(provider),
		update: async () => structuredClone(provider),
		delete: async () => {},
		refreshModels: async () => structuredClone(provider),
		setModels: async () => structuredClone(provider),
		setModelsEnabled: () => structuredClone(provider),
		getDefaultModel: () => selection,
		setDefaultModel: () => selection,
	};
}
