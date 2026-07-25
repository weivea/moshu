import { describe, expect, test } from "bun:test";
import { FakeListChatModel, FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AskChatCancelledError,
	AskChatRuntimeError,
	BunSqliteSaver,
	DeepAgentsAskChatRuntime,
	InMemoryAskProviderConfigStore,
	type AskAgentFactory,
	type AskAgentStreamInput,
	type AskAgentStreamOptions,
	type AskModelFactory,
} from "../src";

describe("DeepAgentsAskChatRuntime", () => {
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
			threadId: "history-thread",
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
		expect(capturedOptions?.configurable).toEqual({
			thread_id: "ask:history-thread:history-run",
			checkpoint_ns: "",
			run_id: "history-run",
		});
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

	test("executes the default adapter through Deep Agents and persists graph checkpoints", async () => {
		await withTempDirectory(async (directoryPath) => {
			const databasePath = join(directoryPath, "deep-agent-checkpoints.db");
			const checkpointThreadId = "ask:fake-model-thread:fake-model-run";
			const saver = new BunSqliteSaver(databasePath);
			const runtime = createDeepAgentsRuntime(
				() =>
					new FakeListChatModel({
						responses: ["Hi!"],
					}),
				saver,
			);
			let latestCheckpointId: string | undefined;

			try {
				const run = runtime.stream({
					runId: "fake-model-run",
					threadId: "fake-model-thread",
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
				const checkpoints = await collectAsync(
					saver.list({
						configurable: {
							thread_id: checkpointThreadId,
							checkpoint_ns: "",
						},
					}),
				);
				expect(checkpoints.length).toBeGreaterThan(0);
				latestCheckpointId = checkpoints[0]?.checkpoint.id;
			} finally {
				await runtime.shutdown();
				saver.close();
			}

			expect(latestCheckpointId).toBeDefined();
			const reopened = new BunSqliteSaver(databasePath);
			try {
				const restored = await reopened.getTuple({
					configurable: {
						thread_id: checkpointThreadId,
						checkpoint_ns: "",
						checkpoint_id: latestCheckpointId,
					},
				});
				expect(JSON.stringify(restored?.checkpoint.channel_values)).toContain("Hi!");
				expect(JSON.stringify(restored)).not.toContain("sk-test");
			} finally {
				reopened.close();
			}
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
					createOpenAiChunk("Hello", null, "assistant"),
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
		const runtime = new DeepAgentsAskChatRuntime({
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
				messages: [{ role: "system" }, { role: "user", content: "Say hello" }],
			});
			expect(JSON.stringify(observedRequest.body)).not.toContain('"tools"');
		} finally {
			await runtime.shutdown();
			server.stop(true);
		}
	});

	test("rejects model-requested tools at the Deep Agents execution boundary", async () => {
		await withTempDirectory(async (directoryPath) => {
			const targetPath = join(directoryPath, "must-not-exist.txt");
			const saver = new BunSqliteSaver(":memory:");
			const runtime = createDeepAgentsRuntime(
				() =>
					new FakeStreamingChatModel({
						chunks: [
							new AIMessageChunk({
								content: "",
								tool_calls: [
									{
										id: "unauthorized-write",
										name: "write_file",
										args: {
											path: targetPath,
											content: "forbidden",
										},
										type: "tool_call",
									},
								],
							}),
						],
					}),
				saver,
			);

			try {
				await expect(
					runtime.run({
						runId: "unauthorized-tool-run",
						threadId: "unauthorized-tool-thread",
						messages: [{ role: "user", content: "Write a file" }],
					}),
				).rejects.toMatchObject({
					kind: "provider_failure",
					message: "Provider request failed.",
					retryable: false,
				});
				expect(await Bun.file(targetPath).exists()).toBe(false);
			} finally {
				await runtime.shutdown();
				saver.close();
			}
		});
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

	test("cancels an active Deep Agents graph after streaming has started", async () => {
		const saver = new BunSqliteSaver(":memory:");
		const runtime = createDeepAgentsRuntime(
			() =>
				new FakeListChatModel({
					responses: ["This response should be cancelled before it finishes."],
					sleep: 2,
				}),
			saver,
		);
		let resolveFirstDelta: () => void = () => {};
		const firstDelta = new Promise<void>((resolve) => {
			resolveFirstDelta = resolve;
		});

		try {
			const result = runtime.run({
				runId: "deep-cancel-run",
				threadId: "deep-cancel-thread",
				messages: [{ role: "user", content: "Keep talking" }],
				onEvent: () => {
					resolveFirstDelta();
				},
			});

			await firstDelta;
			expect(runtime.cancel("deep-cancel-run", "user_cancelled")).toBe(true);
			await expect(result).rejects.toBeInstanceOf(AskChatCancelledError);
			expect(runtime.cancel("deep-cancel-run")).toBe(false);
		} finally {
			await runtime.shutdown();
			saver.close();
		}
	});

	test("isolates three concurrent Deep Agents runs and AsyncLocalStorage contexts", async () => {
		interface RunContext {
			runId: string;
		}

		const contextStorage = new AsyncLocalStorage<RunContext>();
		const observations: Array<{
			source: "factory" | "model" | "event";
			expected: string;
			actual: string | undefined;
		}> = [];
		const boundToolNames: string[][] = [];
		const saver = new BunSqliteSaver(":memory:");
		const runtime = createDeepAgentsRuntime(() => {
			const context = contextStorage.getStore();
			if (context === undefined) {
				throw new Error("Expected a run context while creating the model.");
			}

			observations.push({
				source: "factory",
				expected: context.runId,
				actual: context.runId,
			});
			return new ContextRecordingFakeModel({
				response: `reply:${context.runId}`,
				recordContext: () => {
					observations.push({
						source: "model",
						expected: context.runId,
						actual: contextStorage.getStore()?.runId,
					});
				},
				recordBoundTools: (names) => {
					boundToolNames.push(names);
				},
			});
		}, saver);
		const runIds = ["concurrent-a", "concurrent-b", "concurrent-c"] as const;

		try {
			const results = await Promise.all(
				runIds.map((runId) =>
					contextStorage.run({ runId }, () =>
						runtime.run({
							runId,
							threadId: `session-${runId}`,
							messages: [{ role: "user", content: `prompt:${runId}` }],
							onEvent: () => {
								observations.push({
									source: "event",
									expected: runId,
									actual: contextStorage.getStore()?.runId,
								});
							},
						}),
					),
				),
			);

			expect(results.map((result) => result.text)).toEqual(runIds.map((runId) => `reply:${runId}`));
			expect(observations.length).toBeGreaterThan(runIds.length);
			expect(observations.every((entry) => entry.actual === entry.expected)).toBe(true);
			expect(boundToolNames.every((names) => names.length === 0)).toBe(true);

			for (const runId of runIds) {
				expect(observations).toContainEqual({
					source: "model",
					expected: runId,
					actual: runId,
				});
				expect(observations).toContainEqual({
					source: "event",
					expected: runId,
					actual: runId,
				});
				const checkpoints = await collectAsync(
					saver.list({
						configurable: {
							thread_id: `ask:session-${runId}:${runId}`,
							checkpoint_ns: "",
						},
					}),
				);
				const channelValues = JSON.stringify(
					checkpoints.map((tuple) => tuple.checkpoint.channel_values),
				);
				expect(checkpoints.length).toBeGreaterThan(0);
				expect(channelValues).toContain(`prompt:${runId}`);
				for (const otherRunId of runIds) {
					if (otherRunId !== runId) {
						expect(channelValues).not.toContain(`prompt:${otherRunId}`);
					}
				}
			}
		} finally {
			await runtime.shutdown();
			saver.close();
		}
	});

	test("rejects when the provider is not configured", async () => {
		const store = new InMemoryAskProviderConfigStore();
		const runtime = new DeepAgentsAskChatRuntime({
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

function createOpenAiChunk(content: string, finishReason: "stop" | null, role?: "assistant") {
	return {
		id: "chatcmpl-moshu-smoke",
		object: "chat.completion.chunk",
		created: 1_753_418_400,
		model: "moshu-smoke",
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

function createRuntime(agentFactory: AskAgentFactory): DeepAgentsAskChatRuntime {
	const store = new InMemoryAskProviderConfigStore();
	store.set({
		provider: "openai-compatible",
		apiKey: "sk-test",
		model: "gpt-4.1-mini",
		baseUrl: "https://example.com/v1",
	});

	return new DeepAgentsAskChatRuntime({
		providerConfigStore: store,
		agentFactory,
	});
}

function createDeepAgentsRuntime(
	modelFactory: AskModelFactory,
	checkpointer: BunSqliteSaver,
): DeepAgentsAskChatRuntime {
	const store = new InMemoryAskProviderConfigStore();
	store.set({
		provider: "openai-compatible",
		apiKey: "sk-test",
		model: "test-model",
		baseUrl: "https://example.com/v1",
	});

	return new DeepAgentsAskChatRuntime({
		providerConfigStore: store,
		modelFactory,
		checkpointer,
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

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) {
		values.push(value);
	}
	return values;
}

class ContextRecordingFakeModel extends FakeListChatModel {
	readonly #recordContext: () => void;
	readonly #recordBoundTools: (names: string[]) => void;

	constructor(options: {
		response: string;
		recordContext: () => void;
		recordBoundTools: (names: string[]) => void;
	}) {
		super({
			responses: [options.response],
			sleep: 1,
		});
		this.#recordContext = options.recordContext;
		this.#recordBoundTools = options.recordBoundTools;
	}

	override bindTools(
		tools: Parameters<FakeListChatModel["bindTools"]>[0],
	): ReturnType<FakeListChatModel["bindTools"]> {
		this.#recordBoundTools(tools.map((tool) => tool.name));
		return this;
	}

	override async _sleep(): Promise<void> {
		this.#recordContext();
		await Bun.sleep(1);
	}
}

async function withTempDirectory(run: (directoryPath: string) => Promise<void>): Promise<void> {
	const directoryPath = mkdtempSync(join(tmpdir(), "moshu-deep-agent-"));
	try {
		await run(directoryPath);
	} finally {
		rmSync(directoryPath, { force: true, recursive: true });
	}
}
