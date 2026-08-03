import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	ModelRuntime,
	type ProviderRecord,
	type ProviderRegistry,
	SecretVaultCredentialStore,
} from "@moshu/agent-runtime";
import { openAppDatabase } from "@moshu/database";

import { ChatApplicationService } from "./chat-application-service";
import { FileProviderRegistryStore } from "./file-provider-registry-store";

describe("agents-server Pi backend foundation", () => {
	test("enumerates builtin providers and keeps custom credentials out of provider config", async () => {
		const root = join(process.cwd(), ".test-artifacts", `agents-server-${crypto.randomUUID()}`);
		mkdirSync(root, { recursive: true });
		try {
			const vault = new SecretVaultCredentialStore(join(root, "credentials", "vault.json"));
			const modelRuntime = await ModelRuntime.create({
				credentials: vault,
				modelsPath: null,
				allowModelNetwork: false,
			});
			const providerPath = join(root, "providers.json");
			const registry = new FileProviderRegistryStore(providerPath, modelRuntime, vault);
			await registry.initialize();
			const builtinRecords = registry.list().filter((provider) => provider.source === "builtin");
			expect(builtinRecords.map((provider) => provider.id).sort()).toEqual(
				modelRuntime
					.getProviders()
					.map((provider) => provider.id)
					.sort(),
			);
			for (const record of builtinRecords) {
				const auth = modelRuntime.getProvider(record.id)?.auth;
				expect(record.authMethods).toEqual([
					...(auth?.apiKey === undefined ? [] : (["api_key"] as const)),
					...(auth?.oauth === undefined ? [] : (["oauth"] as const)),
				]);
			}

			const custom = await registry.create({
				displayName: "Custom responses",
				api: "openai-responses",
				baseUrl: "https://example.invalid/v1",
				apiKey: "fake-test-secret",
				models: [
					{
						id: "custom-model",
						displayName: "Custom model",
						api: "openai-responses",
						input: ["text"],
						reasoning: true,
						contextWindowTokens: 32_000,
						maxOutputTokens: 4_096,
						thinkingLevels: ["off", "low", "medium", "high"],
						enabled: true,
					},
				],
			});
			expect(custom.source).toBe("custom");
			expect(custom.authMethods).toEqual(["api_key"]);
			expect(custom.credential.configured).toBe(true);
			expect(custom.models[0]?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
			expect(readFileSync(providerPath, "utf8")).not.toContain("fake-test-secret");
			expect(await vault.read(custom.id)).toEqual({
				type: "api_key",
				key: "fake-test-secret",
			});
			expect(modelRuntime.getModel(custom.id, "custom-model")).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("persists a run before scheduling Pi execution and fences concurrent sends", async () => {
		await withBackend(async ({ service, database, tasks }) => {
			const session = service.createSession().session;
			const accepted = service.sendMessage({ sessionId: session.id, content: "Hello Pi" });
			expect(database.runs.get(accepted.run.id).status).toBe("queued");
			expect(() => service.sendMessage({ sessionId: session.id, content: "Concurrent" })).toThrow();
			expect(tasks).toHaveLength(1);
			tasks.shift()?.();
			await Bun.sleep(30);
			const completed = database.runs.get(accepted.run.id);
			expect(completed.status).toBe("completed");
			expect(
				database.runs
					.listEvents({ runId: accepted.run.id })
					.some((event) => event.type === "timeline.text.delta"),
			).toBe(true);
		});
	});

	test("deletes the mapped Pi session and acknowledges durable cleanup", async () => {
		await withBackend(async ({ service, database, runtime }) => {
			const session = service.createSession().session;
			await service.deleteSession({ sessionId: session.id });
			await Bun.sleep(10);
			expect(runtime.deletedThreads).toEqual([session.agentSessionId]);
			expect(database.runs.listPendingAgentSessionCleanups(10)).toEqual([]);
		});
	});
});

async function withBackend(
	run: (context: {
		service: ChatApplicationService;
		database: ReturnType<typeof openAppDatabase>;
		runtime: FakeRuntime;
		tasks: Array<() => void>;
	}) => Promise<void>,
): Promise<void> {
	const root = join(process.cwd(), ".test-artifacts", `chat-service-${crypto.randomUUID()}`);
	mkdirSync(root, { recursive: true });
	const database = openAppDatabase(join(root, "product.db"));
	const runtime = new FakeRuntime();
	const tasks: Array<() => void> = [];
	const service = new ChatApplicationService({
		sessions: database.sessions,
		runs: database.runs,
		providers: createProviderRegistry(),
		runtime,
		isRuntimeReady: () => true,
		schedule: (task) => tasks.push(task),
	});
	try {
		await run({ service, database, runtime, tasks });
	} finally {
		await service.shutdown();
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
}

class FakeRuntime implements AskChatRuntime {
	readonly deletedThreads: string[] = [];

	async run(input: AskChatRunInput): Promise<AskChatRunResult> {
		await input.onEvent?.({
			type: "assistant.text.started",
			runId: input.runId,
			turnIndex: 0,
			contentIndex: 0,
		});
		await input.onEvent?.({
			type: "assistant.text.delta",
			runId: input.runId,
			turnIndex: 0,
			contentIndex: 0,
			delta: "Pi reply",
		});
		await input.onEvent?.({
			type: "assistant.text.completed",
			runId: input.runId,
			turnIndex: 0,
			contentIndex: 0,
			content: "Pi reply",
		});
		return { runId: input.runId, text: "Pi reply" };
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("Not used by ChatApplicationService.");
	}

	cancel(): boolean {
		return false;
	}

	async getThreadMessages(): Promise<AskChatMessage[]> {
		return [];
	}

	async deleteThread(threadId: string): Promise<void> {
		this.deletedThreads.push(threadId);
	}

	async shutdown(): Promise<void> {}
}

function createProviderRegistry(): ProviderRegistry {
	const model = {
		id: "model",
		displayName: "Model",
		api: "openai-responses",
		input: ["text"] as const,
		reasoning: true,
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		thinkingLevels: ["off", "low", "medium", "high"] as const,
		enabled: true,
	};
	const provider: ProviderRecord = {
		id: "provider",
		displayName: "Provider",
		source: "builtin",
		enabled: true,
		authMethods: ["api_key"],
		credential: { configured: true },
		customHeaderNames: [],
		models: [{ ...model, input: [...model.input], thinkingLevels: [...model.thinkingLevels] }],
	};
	let defaultModel = { providerId: provider.id, modelId: model.id };
	return {
		list: () => [structuredClone(provider)],
		get: (id) => (id === provider.id ? structuredClone(provider) : null),
		create: async () => {
			throw new Error("Not implemented.");
		},
		update: async () => {
			throw new Error("Not implemented.");
		},
		delete: async () => {},
		refreshModels: async () => structuredClone(provider),
		setModels: async () => structuredClone(provider),
		setModelsEnabled: () => structuredClone(provider),
		getDefaultModel: () => ({ ...defaultModel }),
		setDefaultModel: (selection) => {
			if (selection !== null) defaultModel = selection;
			return selection;
		},
	};
}
