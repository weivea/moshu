import { describe, expect, test } from "bun:test";

import {
	BunSqliteSaver,
	InMemoryAskProviderConfigStore,
	createAskChatRuntime,
} from "@moshu/agent-runtime";

describe("Application Host Deep Agents runtime", () => {
	test("executes the default OpenAI-compatible graph in the desktop Bun runtime", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				const chunks = [
					createOpenAiChunk("Desktop", null, "assistant"),
					createOpenAiChunk(" Deep Agents", null),
					createOpenAiChunk("", "stop"),
				];
				return new Response(
					`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: {
							"content-type": "text/event-stream",
						},
					},
				);
			},
		});
		const providerConfigStore = new InMemoryAskProviderConfigStore();
		providerConfigStore.set({
			provider: "openai-compatible",
			apiKey: "host-smoke-key",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			model: "host-smoke-model",
		});
		const saver = new BunSqliteSaver(":memory:");
		const runtime = createAskChatRuntime({
			providerConfigStore,
			checkpointer: saver,
		});

		try {
			await expect(
				runtime.run({
					runId: "host-smoke-run",
					threadId: "host-smoke-session",
					messages: [{ role: "user", content: "Run in the Application Host" }],
				}),
			).resolves.toMatchObject({
				runId: "host-smoke-run",
				text: "Desktop Deep Agents",
			});
			expect(
				await saver.getTuple({
					configurable: {
						thread_id: "ask:host-smoke-session",
						checkpoint_ns: "",
					},
				}),
			).toBeDefined();
		} finally {
			await runtime.shutdown();
			saver.close();
			server.stop(true);
		}
	});
});

function createOpenAiChunk(content: string, finishReason: "stop" | null, role?: "assistant") {
	return {
		id: "chatcmpl-host-smoke",
		object: "chat.completion.chunk",
		created: 1_753_418_400,
		model: "host-smoke-model",
		choices: [
			{
				index: 0,
				delta: {
					...(role === undefined ? {} : { role }),
					...(content.length === 0 ? {} : { content }),
				},
				finish_reason: finishReason,
			},
		],
	};
}
