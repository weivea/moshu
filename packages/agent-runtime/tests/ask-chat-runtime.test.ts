import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel, FakeStreamingChatModel } from "@langchain/core/utils/testing";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
	type AskAgentFactory,
	type AskAgentStreamInput,
	type AskAgentStreamOptions,
	AskChatCancelledError,
	AskChatRuntimeError,
	type AskChatRuntimeOptions,
	type AskModelFactory,
	BunSqliteSaver,
	DeepAgentsAskChatRuntime,
	type ResolvedProviderConfiguration,
} from "../src";

const askTestProvider: ResolvedProviderConfiguration = {
	providerId: "0192f0aa-0000-7000-8000-000000000001",
	providerName: "Test provider",
	type: "openai-compatible",
	protocol: "openai-chat-completions",
	baseUrl: "https://example.com/v1",
	apiKey: "sk-test",
	model: "gpt-4.1-mini",
};

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
			provider: askTestProvider,
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
			provider: askTestProvider,
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
			thread_id: "ask:history-thread",
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
			provider: askTestProvider,
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
				provider: askTestProvider,
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
			const checkpointThreadId = "ask:fake-model-thread";
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
					provider: askTestProvider,
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

	test("restores conversation history from the Deep Agents checkpoint thread", async () => {
		const saver = new BunSqliteSaver(":memory:");
		let modelCount = 0;
		const runtime = createDeepAgentsRuntime(
			() =>
				new FakeListChatModel({
					responses: [modelCount++ === 0 ? "First reply" : "Second reply"],
				}),
			saver,
		);

		try {
			await runtime.run({
				runId: "first-run",
				provider: askTestProvider,
				threadId: "persistent-thread",
				messages: [{ role: "user", content: "First question", id: "first-message" }],
			});
			await runtime.run({
				runId: "second-run",
				provider: askTestProvider,
				threadId: "persistent-thread",
				messages: [{ role: "user", content: "Second question" }],
			});

			const latest = await saver.getTuple({
				configurable: {
					thread_id: "ask:persistent-thread",
					checkpoint_ns: "",
				},
			});
			const state = JSON.stringify(latest?.checkpoint.channel_values);
			expect(state).toContain("First question");
			expect(state).toContain("First reply");
			expect(state).toContain("Second question");
			expect(state).toContain("Second reply");
			const messages = await runtime.getThreadMessages("persistent-thread");
			expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
				{ role: "user", content: "First question" },
				{ role: "assistant", content: "First reply" },
				{ role: "user", content: "Second question" },
				{ role: "assistant", content: "Second reply" },
			]);
			expect(messages[0]?.id).toBe("first-message");
		} finally {
			await runtime.shutdown();
			saver.close();
		}
	});

	test("deletes the persistent Deep Agents checkpoint thread", async () => {
		const saver = new BunSqliteSaver(":memory:");
		const runtime = createDeepAgentsRuntime(
			() => new FakeListChatModel({ responses: ["Reply"] }),
			saver,
		);

		try {
			await runtime.run({
				runId: "delete-run",
				provider: askTestProvider,
				threadId: "delete-thread",
				messages: [{ role: "user", content: "Delete this conversation" }],
			});
			expect(
				await saver.getTuple({
					configurable: { thread_id: "ask:delete-thread", checkpoint_ns: "" },
				}),
			).toBeDefined();

			const cancelled = new AbortController();
			cancelled.abort(new Error("checkpoint deletion cancelled"));
			await expect(runtime.deleteThread("delete-thread", cancelled.signal)).rejects.toThrow(
				"checkpoint deletion cancelled",
			);
			expect(
				await saver.getTuple({
					configurable: { thread_id: "ask:delete-thread", checkpoint_ns: "" },
				}),
			).toBeDefined();

			await runtime.deleteThread("delete-thread");

			expect(
				await saver.getTuple({
					configurable: { thread_id: "ask:delete-thread", checkpoint_ns: "" },
				}),
			).toBeUndefined();
		} finally {
			await runtime.shutdown();
			saver.close();
		}
	});

	test("reads checkpoint-owned transcript after reopening the saver", async () => {
		await withTempDirectory(async (directoryPath) => {
			const databasePath = join(directoryPath, "reopened-transcript.db");
			const firstSaver = new BunSqliteSaver(databasePath);
			const firstRuntime = createDeepAgentsRuntime(
				() => new FakeListChatModel({ responses: ["Persisted reply"] }),
				firstSaver,
			);

			try {
				await firstRuntime.run({
					runId: "persisted-run",
					provider: askTestProvider,
					threadId: "persisted-thread",
					messages: [
						{
							role: "user",
							content: "Persisted question",
							id: "persisted-message",
						},
					],
				});
			} finally {
				await firstRuntime.shutdown();
				firstSaver.close();
			}

			const reopenedSaver = new BunSqliteSaver(databasePath);
			const reopenedRuntime = createDeepAgentsRuntime(
				() => new FakeListChatModel({ responses: [] }),
				reopenedSaver,
			);
			try {
				const messages = await reopenedRuntime.getThreadMessages("persisted-thread");
				expect(messages.map(({ role, content, id }) => ({ role, content, id }))).toEqual([
					{
						role: "user",
						content: "Persisted question",
						id: "persisted-message",
					},
					expect.objectContaining({
						role: "assistant",
						content: "Persisted reply",
					}),
				]);
			} finally {
				await reopenedRuntime.shutdown();
				reopenedSaver.close();
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
		const runtime = new DeepAgentsAskChatRuntime({});

		try {
			const result = await runtime.run({
				runId: "openai-compatible-smoke",
				provider: {
					...askTestProvider,
					apiKey: "local-test-key",
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					model: "moshu-smoke",
				},
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

	test("replays legacy Responses assistant strings as output_text without losing history", async () => {
		const observedBodies: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				observedBodies.push(await request.json());
				return new Response(createOpenAiResponsesStream("Second reply"), {
					headers: {
						"content-type": "text/event-stream",
					},
				});
			},
		});
		const saver = new BunSqliteSaver(":memory:");
		const provider: ResolvedProviderConfiguration = {
			...askTestProvider,
			protocol: "openai-responses",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			apiKey: "local-test-key",
			model: "moshu-responses",
		};
		const legacyRuntime = createDeepAgentsRuntime(
			() =>
				new FakeListChatModel({
					responses: ["First reply"],
					generationInfo: {
						model_provider: "openai",
						gateway_marker: "preserved",
					},
				}),
			saver,
		);
		const upgradedRuntime = new DeepAgentsAskChatRuntime({ checkpointer: saver });

		try {
			await legacyRuntime.run({
				runId: "responses-legacy-first",
				threadId: "responses-legacy-thread",
				provider,
				messages: [{ role: "user", content: "First question" }],
			});
			await legacyRuntime.shutdown();

			await expect(
				upgradedRuntime.run({
					runId: "responses-legacy-second",
					threadId: "responses-legacy-thread",
					provider,
					messages: [{ role: "user", content: "Follow-up question" }],
				}),
			).resolves.toMatchObject({ text: "Second reply" });

			expect(observedBodies[0]).toMatchObject({
				input: [
					{ role: "system", content: [{ type: "input_text" }] },
					{
						role: "user",
						content: [{ type: "input_text", text: "First question" }],
					},
					{
						role: "assistant",
						content: [{ type: "output_text", text: "First reply" }],
					},
					{
						role: "user",
						content: [{ type: "input_text", text: "Follow-up question" }],
					},
				],
			});
			expect(JSON.stringify(observedBodies[0])).not.toContain(
				'"role":"assistant","content":[{"type":"input_text"',
			);
		} finally {
			await legacyRuntime.shutdown();
			await upgradedRuntime.shutdown();
			saver.close();
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
						provider: askTestProvider,
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
			provider: askTestProvider,
			messages: [{ role: "user", content: "Wait" }],
		});

		expect(() =>
			runtime.stream({
				runId: "active-run",
				provider: askTestProvider,
				messages: [{ role: "user", content: "Duplicate" }],
			}),
		).toThrow('An ask chat run with id "active-run" is already active.');

		expect(runtime.cancel("active-run", "user_cancelled")).toBe(true);
		await expect(run.result).rejects.toBeInstanceOf(AskChatCancelledError);
		expect(runtime.cancel("active-run")).toBe(false);
	});

	test("stops a 500-item nested text stream and closes both iterators after cancellation", async () => {
		let nestedPulls = 0;
		let nestedReturns = 0;
		let outerReturns = 0;
		const nestedText: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					async next() {
						nestedPulls += 1;
						await Promise.resolve();
						return index++ < 500
							? { done: false as const, value: "x" }
							: { done: true as const, value: undefined };
					},
					async return() {
						nestedReturns += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		};
		const outerStream: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]() {
				let delivered = false;
				return {
					async next() {
						if (delivered) {
							return { done: true as const, value: undefined };
						}
						delivered = true;
						return { done: false as const, value: { text: nestedText } };
					},
					async return() {
						outerReturns += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		};
		const runtime = createRuntime(async () => ({
			stream: async () => outerStream,
		}));
		const result = runtime.run({
			runId: "nested-500-cancel",
			provider: askTestProvider,
			messages: [{ role: "user", content: "stop quickly" }],
			onEvent: () => {
				runtime.cancel("nested-500-cancel", "first item received");
			},
		});

		await expect(result).rejects.toBeInstanceOf(AskChatCancelledError);
		expect(nestedPulls).toBeLessThanOrEqual(2);
		expect(nestedReturns).toBe(1);
		expect(outerReturns).toBe(1);
	});

	test("closes an infinite yielding text iterator promptly on cancellation", async () => {
		let pulls = 0;
		let returns = 0;
		let resolveFirstDelta: () => void = () => {};
		const firstDelta = new Promise<void>((resolve) => {
			resolveFirstDelta = resolve;
		});
		const infiniteText: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						pulls += 1;
						await Promise.resolve();
						return { done: false as const, value: "x" };
					},
					async return() {
						returns += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		};
		const runtime = createRuntime(async () => ({
			stream: async () => createAsyncIterable([{ text: infiniteText }]),
		}));
		const result = runtime.run({
			runId: "infinite-cancel",
			provider: askTestProvider,
			messages: [{ role: "user", content: "stop" }],
			onEvent: resolveFirstDelta,
		});
		const rejection = result.catch((error: unknown) => error);

		await firstDelta;
		expect(runtime.cancel("infinite-cancel", "done")).toBe(true);
		expect(await withDeadline(rejection, 250, "infinite iterator cancellation")).toBeInstanceOf(
			AskChatCancelledError,
		);
		expect(pulls).toBeLessThanOrEqual(3);
		expect(returns).toBe(1);
	});

	test("does not await a provider iterator whose return never settles after cancellation", async () => {
		let returns = 0;
		const text: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						return { done: false as const, value: "x" };
					},
					return() {
						returns += 1;
						return new Promise<IteratorResult<string>>(() => {});
					},
				};
			},
		};
		const runtime = createRuntime(async () => ({
			stream: async () => createAsyncIterable([{ text }]),
		}));
		const result = runtime.run({
			runId: "hanging-return-cancel",
			provider: askTestProvider,
			messages: [{ role: "user", content: "stop" }],
			onEvent: () => {
				runtime.cancel("hanging-return-cancel", "done");
			},
		});

		expect(
			await withDeadline(
				result.catch((error: unknown) => error),
				250,
				"hanging iterator return",
			),
		).toBeInstanceOf(AskChatCancelledError);
		expect(returns).toBe(1);
	});

	test("fences a pending stream acquisition until its resolved iterator is closed", async () => {
		let resolveAcquisition: ((stream: AsyncIterable<unknown>) => void) | undefined;
		let acquisitionStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			acquisitionStarted = resolve;
		});
		const acquisition = new Promise<AsyncIterable<unknown>>((resolve) => {
			resolveAcquisition = resolve;
		});
		let firstShared = true;
		let iteratorReturns = 0;
		let iteratorPulls = 0;
		const runtime = createRuntime(
			async () => ({
				stream: async (_input, options) => {
					if (options.configurable.thread_id === "ask:pending-acquire" && firstShared) {
						firstShared = false;
						acquisitionStarted?.();
						return acquisition;
					}
					return createAsyncIterable([]);
				},
			}),
			{
				threadCleanupWaitTimeoutMs: 250,
				shutdownCleanupTimeoutMs: 250,
			},
		);
		const first = runtime.run({
			runId: "pending-acquire-first",
			provider: askTestProvider,
			threadId: "pending-acquire",
			messages: [{ role: "user", content: "cancel while acquiring" }],
		});
		await started;
		expect(runtime.cancel("pending-acquire-first")).toBe(true);
		await expect(first).rejects.toBeInstanceOf(AskChatCancelledError);

		let sameThreadSettled = false;
		const sameThread = runtime
			.run({
				runId: "pending-acquire-second",
				provider: askTestProvider,
				threadId: "pending-acquire",
				messages: [{ role: "user", content: "wait for close" }],
			})
			.finally(() => {
				sameThreadSettled = true;
			});
		await expect(
			runtime.run({
				runId: "pending-acquire-unrelated",
				provider: askTestProvider,
				threadId: "pending-acquire-other",
				messages: [{ role: "user", content: "continue" }],
			}),
		).resolves.toMatchObject({ runId: "pending-acquire-unrelated" });
		await Bun.sleep(10);
		expect(sameThreadSettled).toBe(false);

		resolveAcquisition?.({
			[Symbol.asyncIterator]() {
				return {
					async next() {
						iteratorPulls += 1;
						return { done: true as const, value: undefined };
					},
					async return() {
						iteratorReturns += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		});
		await expect(sameThread).resolves.toMatchObject({ runId: "pending-acquire-second" });
		expect(iteratorPulls).toBe(0);
		expect(iteratorReturns).toBe(1);
		await runtime.shutdown();
	});

	test("observes a pending stream acquisition rejection after cancellation", async () => {
		let rejectAcquisition: ((error: unknown) => void) | undefined;
		let acquisitionStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			acquisitionStarted = resolve;
		});
		const acquisition = new Promise<AsyncIterable<unknown>>((_resolve, reject) => {
			rejectAcquisition = reject;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		let firstShared = true;
		const runtime = createRuntime(async () => ({
			stream: async (_input, options) => {
				if (options.configurable.thread_id === "ask:rejected-acquire" && firstShared) {
					firstShared = false;
					acquisitionStarted?.();
					return acquisition;
				}
				return createAsyncIterable([]);
			},
		}));
		try {
			const first = runtime.run({
				runId: "rejected-acquire-first",
				provider: askTestProvider,
				threadId: "rejected-acquire",
				messages: [{ role: "user", content: "cancel while acquiring" }],
			});
			await started;
			runtime.cancel("rejected-acquire-first");
			await expect(first).rejects.toBeInstanceOf(AskChatCancelledError);
			rejectAcquisition?.(new Error("late acquisition rejection"));
			await expect(
				runtime.run({
					runId: "rejected-acquire-second",
					provider: askTestProvider,
					threadId: "rejected-acquire",
					messages: [{ role: "user", content: "continue after rejection" }],
				}),
			).resolves.toMatchObject({ runId: "rejected-acquire-second" });
			await Bun.sleep(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await runtime.shutdown();
		}
	});

	test("keeps a never-settling stream acquisition fenced while shutdown stays bounded", async () => {
		let acquisitionStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			acquisitionStarted = resolve;
		});
		let firstShared = true;
		const runtime = createRuntime(
			async () => ({
				stream: async (_input, options) => {
					if (options.configurable.thread_id === "ask:never-acquire" && firstShared) {
						firstShared = false;
						acquisitionStarted?.();
						return new Promise<AsyncIterable<unknown>>(() => {});
					}
					return createAsyncIterable([]);
				},
			}),
			{
				threadCleanupWaitTimeoutMs: 15,
				shutdownCleanupTimeoutMs: 15,
			},
		);
		const first = runtime.run({
			runId: "never-acquire-first",
			provider: askTestProvider,
			threadId: "never-acquire",
			messages: [{ role: "user", content: "cancel while acquiring" }],
		});
		await started;
		runtime.cancel("never-acquire-first");
		await expect(first).rejects.toBeInstanceOf(AskChatCancelledError);
		await expect(
			withDeadline(
				runtime.run({
					runId: "never-acquire-second",
					provider: askTestProvider,
					threadId: "never-acquire",
					messages: [{ role: "user", content: "must not overlap" }],
				}),
				100,
				"pending acquisition fence",
			),
		).rejects.toMatchObject({ kind: "thread_busy" });
		await expect(
			runtime.run({
				runId: "never-acquire-unrelated",
				provider: askTestProvider,
				threadId: "never-acquire-other",
				messages: [{ role: "user", content: "unrelated" }],
			}),
		).resolves.toMatchObject({ runId: "never-acquire-unrelated" });
		await expect(
			withDeadline(runtime.shutdown(), 100, "pending acquisition shutdown"),
		).rejects.toMatchObject({ kind: "shutdown_timeout" });
	});

	test("fences slow provider cleanup from the same thread and delete while unrelated threads proceed", async () => {
		let resolveCleanup: ((result: IteratorResult<string>) => void) | undefined;
		const cleanup = new Promise<IteratorResult<string>>((resolve) => {
			resolveCleanup = resolve;
		});
		const startedThreads: string[] = [];
		const deletedThreads: string[] = [];
		let firstStream = true;
		const checkpointer = {
			async deleteThread(threadId: string) {
				deletedThreads.push(threadId);
			},
		} as unknown as BaseCheckpointSaver;
		const runtime = createRuntime(
			async () => ({
				stream: async (_input, options) => {
					startedThreads.push(options.configurable.thread_id);
					if (!firstStream) {
						return createAsyncIterable([]);
					}
					firstStream = false;
					const text: AsyncIterable<string> = {
						[Symbol.asyncIterator]() {
							return {
								async next() {
									return { done: false as const, value: "x" };
								},
								return() {
									return cleanup;
								},
							};
						},
					};
					return createAsyncIterable([{ text }]);
				},
			}),
			{
				checkpointer,
				threadCleanupWaitTimeoutMs: 250,
				shutdownCleanupTimeoutMs: 250,
			},
		);
		const first = runtime.run({
			runId: "slow-cleanup-first",
			provider: askTestProvider,
			threadId: "shared-thread",
			messages: [{ role: "user", content: "cancel" }],
			onEvent: () => {
				runtime.cancel("slow-cleanup-first");
			},
		});
		await expect(first).rejects.toBeInstanceOf(AskChatCancelledError);

		let sameThreadSettled = false;
		const sameThread = runtime
			.run({
				runId: "slow-cleanup-second",
				provider: askTestProvider,
				threadId: "shared-thread",
				messages: [{ role: "user", content: "wait for cleanup" }],
			})
			.finally(() => {
				sameThreadSettled = true;
			});
		let deletionSettled = false;
		const deletion = runtime.deleteThread("shared-thread").finally(() => {
			deletionSettled = true;
		});
		await expect(
			runtime.run({
				runId: "unrelated-thread",
				provider: askTestProvider,
				threadId: "other-thread",
				messages: [{ role: "user", content: "continue" }],
			}),
		).resolves.toMatchObject({ runId: "unrelated-thread" });
		await Bun.sleep(10);
		expect(sameThreadSettled).toBe(false);
		expect(deletionSettled).toBe(false);
		expect(deletedThreads).toEqual([]);
		expect(startedThreads).toEqual(["ask:shared-thread", "ask:other-thread"]);

		resolveCleanup?.({ done: true, value: undefined });
		await expect(sameThread).resolves.toMatchObject({ runId: "slow-cleanup-second" });
		await expect(deletion).resolves.toBeUndefined();
		expect(deletedThreads).toEqual(["ask:shared-thread"]);
		expect(startedThreads).toEqual(["ask:shared-thread", "ask:other-thread", "ask:shared-thread"]);
		await runtime.shutdown();
	});

	test("fails closed on a never-settling cleanup and bounds runtime shutdown", async () => {
		let firstStream = true;
		const runtime = createRuntime(
			async () => ({
				stream: async () => {
					if (!firstStream) {
						return createAsyncIterable([]);
					}
					firstStream = false;
					const text: AsyncIterable<string> = {
						[Symbol.asyncIterator]() {
							return {
								async next() {
									return { done: false as const, value: "x" };
								},
								return: () => new Promise<IteratorResult<string>>(() => {}),
							};
						},
					};
					return createAsyncIterable([{ text }]);
				},
			}),
			{
				threadCleanupWaitTimeoutMs: 15,
				shutdownCleanupTimeoutMs: 15,
			},
		);
		const first = runtime.run({
			runId: "never-cleanup-first",
			provider: askTestProvider,
			threadId: "never-cleanup-thread",
			messages: [{ role: "user", content: "cancel" }],
			onEvent: () => {
				runtime.cancel("never-cleanup-first");
			},
		});
		await expect(first).rejects.toBeInstanceOf(AskChatCancelledError);

		await expect(
			withDeadline(
				runtime.run({
					runId: "never-cleanup-second",
					provider: askTestProvider,
					threadId: "never-cleanup-thread",
					messages: [{ role: "user", content: "must not overlap" }],
				}),
				100,
				"same-thread cleanup fence",
			),
		).rejects.toMatchObject({ kind: "thread_busy" });
		await expect(
			runtime.run({
				runId: "never-cleanup-unrelated",
				provider: askTestProvider,
				threadId: "never-cleanup-other",
				messages: [{ role: "user", content: "unrelated" }],
			}),
		).resolves.toMatchObject({ runId: "never-cleanup-unrelated" });
		await expect(
			withDeadline(runtime.shutdown(), 100, "never-settling cleanup shutdown"),
		).rejects.toMatchObject({ kind: "shutdown_timeout" });
		expect(() =>
			runtime.run({
				runId: "after-shutdown",
				provider: askTestProvider,
				messages: [{ role: "user", content: "closed" }],
			}),
		).toThrow("shutting down");
	});

	test("shutdown does not consume the remainder of a yielding provider iterator", async () => {
		let pulls = 0;
		let returns = 0;
		let resolveFirstDelta: () => void = () => {};
		const firstDelta = new Promise<void>((resolve) => {
			resolveFirstDelta = resolve;
		});
		const text: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						pulls += 1;
						await Promise.resolve();
						return { done: false as const, value: "x" };
					},
					async return() {
						returns += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		};
		const runtime = createRuntime(async () => ({
			stream: async () => createAsyncIterable([{ text }]),
		}));
		const result = runtime
			.run({
				runId: "yielding-shutdown",
				provider: askTestProvider,
				messages: [{ role: "user", content: "shutdown" }],
				onEvent: resolveFirstDelta,
			})
			.catch((error: unknown) => error);

		await firstDelta;
		await withDeadline(runtime.shutdown(), 250, "runtime shutdown");
		expect(await result).toBeInstanceOf(AskChatCancelledError);
		expect(pulls).toBeLessThanOrEqual(3);
		expect(returns).toBe(1);
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
				provider: askTestProvider,
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
							provider: askTestProvider,
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
							thread_id: `ask:session-${runId}`,
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

	test("builds the agent from the provider supplied with the run", async () => {
		const observedProviders: string[] = [];
		const runtime = new DeepAgentsAskChatRuntime({
			agentFactory: async (configuration) => {
				observedProviders.push(`${configuration.providerId}:${configuration.model}`);
				return { stream: async () => createAsyncIterable([]) };
			},
		});

		try {
			await runtime.run({
				runId: "per-run-provider",
				provider: { ...askTestProvider, model: "gpt-per-run" },
				messages: [{ role: "user", content: "Hello" }],
			});
		} finally {
			await runtime.shutdown();
		}

		expect(observedProviders).toEqual([`${askTestProvider.providerId}:gpt-per-run`]);
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
				provider: askTestProvider,
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
				provider: askTestProvider,
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
					provider: askTestProvider,
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
			provider: askTestProvider,
			messages: [{ role: "user", content: "One" }],
		});
		const secondRun = runtime.stream({
			runId: "shutdown-2",
			provider: askTestProvider,
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

function createOpenAiResponsesStream(text: string): string {
	const message = {
		id: "msg_moshu_responses",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const response = {
		id: "resp_moshu_responses",
		object: "response",
		created_at: 1_753_418_400,
		status: "completed",
		model: "moshu-responses",
		output: [message],
		output_text: text,
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			total_tokens: 2,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	const events = [
		{
			type: "response.output_text.delta",
			sequence_number: 0,
			item_id: message.id,
			output_index: 0,
			content_index: 0,
			delta: text,
			logprobs: [],
		},
		{
			type: "response.completed",
			sequence_number: 1,
			response,
		},
	];

	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function createRuntime(
	agentFactory: AskAgentFactory,
	options: Pick<
		AskChatRuntimeOptions,
		"checkpointer" | "threadCleanupWaitTimeoutMs" | "shutdownCleanupTimeoutMs"
	> = {},
): DeepAgentsAskChatRuntime {
	return new DeepAgentsAskChatRuntime({
		agentFactory,
		...options,
	});
}

function createDeepAgentsRuntime(
	modelFactory: AskModelFactory,
	checkpointer: BunSqliteSaver,
): DeepAgentsAskChatRuntime {
	return new DeepAgentsAskChatRuntime({
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

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
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

describe("provider error classification", () => {
	test("reads the status code and message through a wrapped cause chain", async () => {
		const wrapped = new Error("Middleware failed", {
			cause: Object.assign(new Error("429 rate limit exceeded"), { status: 429 }),
		});
		const runtime = createRuntime(async () => ({
			stream: async () => {
				throw wrapped;
			},
		}));

		try {
			await expect(
				runtime.run({
					runId: "wrapped-rate-limit",
					provider: askTestProvider,
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toMatchObject({ kind: "provider_rate_limited", statusCode: 429, retryable: true });
		} finally {
			await runtime.shutdown();
		}
	});

	test("keeps the original provider failure attached as the error cause", async () => {
		const upstream = Object.assign(new Error("500 upstream exploded"), { status: 500 });
		const runtime = createRuntime(async () => ({
			stream: async () => {
				throw new Error("Middleware failed", { cause: upstream });
			},
		}));

		try {
			const error = await runtime
				.run({
					runId: "wrapped-server-error",
					provider: askTestProvider,
					messages: [{ role: "user", content: "Hello" }],
				})
				.catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(AskChatRuntimeError);
			expect((error as AskChatRuntimeError).statusCode).toBe(500);
			expect(String((error as Error).cause)).toContain("Middleware failed");
		} finally {
			await runtime.shutdown();
		}
	});
});
