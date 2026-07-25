import { describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import {
	AskChatCancelledError,
	AskChatRuntimeError,
	InMemoryAskChatRuntime,
	InMemoryAskProviderConfigStore,
	type AskAgentFactory,
	type AskAgentStreamInput,
	type AskAgentStreamOptions,
} from "../src";

describe("InMemoryAskChatRuntime", () => {
	test("streams normalized deltas in order and returns final text with usage", async () => {
		const callbackEvents: string[] = [];
		const runtime = createRuntime(async () => ({
			stream: async () =>
				createAsyncIterable([
					{
						text: createStringAsyncIterable(["Hel", "lo"]),
						usage: Promise.resolve({
							input_tokens: 4,
							output_tokens: 2,
							total_tokens: 6,
						}),
					},
				]),
		}));

		const run = runtime.stream({
			runId: "ordered-run",
			messages: [{ role: "user", content: "Say hello" }],
			onEvent: async (event) => {
				callbackEvents.push(event.delta);
			},
		});

		const iteratedEvents: string[] = [];
		for await (const event of run) {
			iteratedEvents.push(event.delta);
		}

		await expect(run.result).resolves.toEqual({
			runId: "ordered-run",
			text: "Hello",
			usage: {
				inputTokens: 4,
				outputTokens: 2,
				totalTokens: 6,
			},
		});
		expect(iteratedEvents).toEqual(["Hel", "lo"]);
		expect(callbackEvents).toEqual(["Hel", "lo"]);
	});

	test("passes user and assistant history to the agent stream", async () => {
		let capturedInput: AskAgentStreamInput | undefined;
		let capturedOptions: AskAgentStreamOptions | undefined;

		const runtime = createRuntime(async () => ({
			stream: async (input, options) => {
				capturedInput = input;
				capturedOptions = options;
				return createAsyncIterable([]);
			},
		}));

		const result = await runtime.run({
			runId: "history-run",
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
				{ role: "user", content: "How are you?" },
			],
		});

		expect(result).toEqual({
			runId: "history-run",
			text: "",
		});
		expect(capturedOptions).toMatchObject({ streamMode: "messages" });
		expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
		expect(capturedInput?.messages).toHaveLength(3);
		expect(HumanMessage.isInstance(capturedInput?.messages[0])).toBe(true);
		expect(AIMessage.isInstance(capturedInput?.messages[1])).toBe(true);
		expect(HumanMessage.isInstance(capturedInput?.messages[2])).toBe(true);
		expect(capturedInput?.messages[0]?.content).toBe("Hello");
		expect(capturedInput?.messages[1]?.content).toBe("Hi there");
		expect(capturedInput?.messages[2]?.content).toBe("How are you?");
	});

	test("avoids duplicating accumulated structured content", async () => {
		const runtime = createRuntime(async () => ({
			stream: async () =>
				createAsyncIterable([
					[
						new AIMessageChunk({
							content: [{ type: "text", text: "Hello" }],
						}),
						{},
					],
					[
						new AIMessageChunk({
							content: [{ type: "text", text: "Hello world" }],
						}),
						{},
					],
				]),
		}));

		const run = runtime.stream({
			runId: "structured-run",
			messages: [{ role: "user", content: "Say hello" }],
		});

		const deltas: string[] = [];
		for await (const event of run) {
			deltas.push(event.delta);
		}

		expect(deltas).toEqual(["Hello", " world"]);
		await expect(run.result).resolves.toMatchObject({ text: "Hello world" });
	});

	test("returns empty text for empty replies", async () => {
		const runtime = createRuntime(async () => ({
			stream: async () =>
				createAsyncIterable([
					[
						new AIMessageChunk({
							content: "",
						}),
						{},
					],
				]),
		}));

		await expect(
			runtime.run({
				runId: "empty-run",
				messages: [{ role: "user", content: "Respond with nothing" }],
			}),
		).resolves.toEqual({
			runId: "empty-run",
			text: "",
		});
	});

	test("supports offline LangChain createAgent streaming with a fake model", async () => {
		const runtime = createRuntime(async () => {
			const agent = createAgent({
				model: new FakeListChatModel({
					responses: ["Hi!"],
				}),
				tools: [],
			});

			return {
				stream: (input, options) =>
					agent.stream(
						{
							messages: [...input.messages],
						},
						options,
					),
			};
		});

		const run = runtime.stream({
			runId: "fake-model-run",
			messages: [{ role: "user", content: "Hi" }],
		});

		const deltas: string[] = [];
		for await (const event of run) {
			deltas.push(event.delta);
		}

		expect(deltas.join("")).toBe("Hi!");
		await expect(run.result).resolves.toMatchObject({
			runId: "fake-model-run",
			text: "Hi!",
		});
	});

	test("streams through the default OpenAI-compatible ChatOpenAI adapter", async () => {
		const observedRequest: {
			authorizationHeader: string | null;
			body: unknown;
		} = {
			authorizationHeader: null,
			body: undefined,
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== "/v1/chat/completions") {
					return new Response("Not found", { status: 404 });
				}

				observedRequest.authorizationHeader = request.headers.get("authorization");
				observedRequest.body = await request.json();
				const chunks = [
					createOpenAiChunk("Hello", null),
					createOpenAiChunk(" from Moshu", null),
					createOpenAiChunk("", "stop"),
				];
				const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

				return new Response(body, {
					headers: {
						"content-type": "text/event-stream",
					},
				});
			},
		});
		const store = new InMemoryAskProviderConfigStore();
		store.set({
			provider: "openai-compatible",
			apiKey: "local-test-key",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			model: "moshu-smoke",
		});
		const runtime = new InMemoryAskChatRuntime({
			providerConfigStore: store,
		});

		try {
			const result = await runtime.run({
				runId: "openai-compatible-smoke",
				messages: [{ role: "user", content: "Say hello" }],
			});

			expect(result.text).toBe("Hello from Moshu");
			expect(observedRequest.authorizationHeader).toBe("Bearer local-test-key");
			expect(observedRequest.body).toMatchObject({
				model: "moshu-smoke",
				stream: true,
				messages: [{ role: "user", content: "Say hello" }],
			});
			expect(JSON.stringify(observedRequest.body)).not.toContain('"tools"');
		} finally {
			await runtime.shutdown();
			server.stop(true);
		}
	});

	test("propagates cancellation and rejects duplicate active run ids", async () => {
		const runtime = createRuntime(async () => ({
			stream: async (_input, options) => createAbortAwareStream(options.signal, "cancel me"),
		}));

		const run = runtime.stream({
			runId: "active-run",
			messages: [{ role: "user", content: "Wait" }],
		});

		expect(() =>
			runtime.stream({
				runId: "active-run",
				messages: [{ role: "user", content: "Duplicate" }],
			}),
		).toThrow('An ask chat run with id "active-run" is already active.');

		expect(runtime.cancel("active-run", "user_cancelled")).toBe(true);
		await expect(run.result).rejects.toBeInstanceOf(AskChatCancelledError);
		expect(runtime.cancel("active-run")).toBe(false);
	});

	test("rejects when the provider is not configured", async () => {
		const store = new InMemoryAskProviderConfigStore();
		const runtime = new InMemoryAskChatRuntime({
			providerConfigStore: store,
			agentFactory: async () => ({
				stream: async () => createAsyncIterable([]),
			}),
		});

		await expect(
			runtime.run({
				runId: "unconfigured-run",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toMatchObject({
			kind: "not_configured",
			message: "Ask provider is not configured.",
			retryable: false,
		});
	});

	test("sanitizes provider authentication failures", async () => {
		const runtime = createRuntime(async () => ({
			stream: async () => {
				throw {
					status: 401,
					message:
						'invalid api key sk-secret Authorization: Bearer sk-secret body={"token":"sk-secret"}',
				};
			},
		}));

		await expect(
			runtime.run({
				runId: "auth-run",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toMatchObject({
			kind: "provider_authentication",
			message: "Provider authentication failed.",
			retryable: false,
			statusCode: 401,
		});

		const error = await captureRejection(
			runtime.run({
				runId: "auth-run-2",
				messages: [{ role: "user", content: "Hello again" }],
			}),
		);
		expect(error).toBeInstanceOf(AskChatRuntimeError);
		expect(String(error)).not.toContain("sk-secret");
		expect(String(error)).not.toContain("Authorization");
		expect(String(error)).not.toContain("body=");
	});

	test("maps rate-limit, network, and model failures to safe semantics", async () => {
		const cases: Array<{
			runId: string;
			error: unknown;
			kind: AskChatRuntimeError["kind"];
			retryable: boolean;
		}> = [
			{
				runId: "rate-limit-run",
				error: { status: 429, message: "quota exceeded" },
				kind: "provider_rate_limited",
				retryable: true,
			},
			{
				runId: "network-run",
				error: new Error("fetch failed ECONNRESET"),
				kind: "provider_network",
				retryable: true,
			},
			{
				runId: "model-run",
				error: { status: 404, message: "model not found" },
				kind: "provider_model",
				retryable: false,
			},
		];

		for (const testCase of cases) {
			const runtime = createRuntime(async () => ({
				stream: async () => {
					throw testCase.error;
				},
			}));

			await expect(
				runtime.run({
					runId: testCase.runId,
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toMatchObject({
				kind: testCase.kind,
				retryable: testCase.retryable,
			});
		}
	});

	test("shutdown cancels all active runs", async () => {
		const runtime = createRuntime(async () => ({
			stream: async (_input, options) => createAbortAwareStream(options.signal, "shutdown"),
		}));

		const firstRun = runtime.stream({
			runId: "shutdown-1",
			messages: [{ role: "user", content: "One" }],
		});
		const secondRun = runtime.stream({
			runId: "shutdown-2",
			messages: [{ role: "user", content: "Two" }],
		});

		await runtime.shutdown();

		await expect(firstRun.result).rejects.toBeInstanceOf(AskChatCancelledError);
		await expect(secondRun.result).rejects.toBeInstanceOf(AskChatCancelledError);
		expect(runtime.cancel("shutdown-1")).toBe(false);
		expect(runtime.cancel("shutdown-2")).toBe(false);
	});
});

function createOpenAiChunk(content: string, finishReason: "stop" | null) {
	return {
		id: "chatcmpl-moshu-smoke",
		object: "chat.completion.chunk",
		created: 1_753_418_400,
		model: "moshu-smoke",
		choices: [
			{
				index: 0,
				delta: content.length === 0 ? {} : { content },
				finish_reason: finishReason,
			},
		],
	};
}

function createRuntime(agentFactory: AskAgentFactory): InMemoryAskChatRuntime {
	const store = new InMemoryAskProviderConfigStore();
	store.set({
		provider: "openai-compatible",
		apiKey: "sk-test",
		model: "gpt-4.1-mini",
		baseUrl: "https://example.com/v1",
	});

	return new InMemoryAskChatRuntime({
		providerConfigStore: store,
		agentFactory,
	});
}

function createAsyncIterable(values: readonly unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) {
				yield value;
			}
		},
	};
}

function createStringAsyncIterable(values: readonly string[]): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) {
				yield value;
			}
		},
	};
}

function createAbortAwareStream(signal: AbortSignal, delta: string): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			yield [new AIMessageChunk({ content: delta }), {}];
			await waitForAbort(signal);
			throw new DOMException("Aborted", "AbortError");
		},
	};
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		throw new Error("Expected promise to reject.");
	} catch (error) {
		return error;
	}
}
