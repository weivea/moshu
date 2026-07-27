import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions, ChatOpenAIResponses } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

import {
	buildProviderChatModelParameters,
	createProviderChatModel,
	type ResolvedProviderConfiguration,
} from "../src";

const baseConfiguration: ResolvedProviderConfiguration = {
	providerId: "0192f0aa-0000-7000-8000-000000000001",
	providerName: "Gateway",
	type: "openai-compatible",
	protocol: "openai-chat-completions",
	baseUrl: "https://example.com/v1",
	apiKey: "sk-test",
	model: "gpt-5.5",
};

describe("buildProviderChatModelParameters", () => {
	test("sends no reasoning parameter when the session selected none", () => {
		const parameters = buildProviderChatModelParameters(baseConfiguration);

		expect(parameters).toEqual({ model: "gpt-5.5", baseUrl: "https://example.com/v1" });
	});

	test("maps an effort selection to the OpenAI-compatible parameter", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			protocol: "openai-responses",
			reasoning: { effort: "high" },
		});

		expect(parameters.reasoningEffort).toBe("high");
		expect(parameters).not.toHaveProperty("thinkingBudgetTokens");
	});

	test("forwards custom headers without leaking them into the model name", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			customHeaders: { "X-Org": "acme" },
		});

		expect(parameters.defaultHeaders).toEqual({ "X-Org": "acme" });
	});

	test("raises the output ceiling above an Anthropic thinking budget", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			type: "anthropic-compatible",
			protocol: "anthropic-messages",
			model: "claude-opus-4.6",
			maxOutputTokens: 4_000,
			reasoning: { budgetTokens: 8_192 },
		});

		expect(parameters.thinkingBudgetTokens).toBe(8_192);
		expect(parameters.maxOutputTokens).toBe(9_216);
	});

	test("keeps a declared output ceiling that already exceeds the budget", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			type: "anthropic-compatible",
			protocol: "anthropic-messages",
			maxOutputTokens: 64_000,
			reasoning: { budgetTokens: 8_192 },
		});

		expect(parameters.maxOutputTokens).toBe(64_000);
	});

	test("never rewrites the output ceiling for a provider that ignores thinking budgets", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			maxOutputTokens: 16_000,
			reasoning: { budgetTokens: 8_000 },
		});

		expect(parameters).not.toHaveProperty("thinkingBudgetTokens");
		expect(parameters).not.toHaveProperty("maxOutputTokens");
	});

	test("treats a zero budget as an explicit disable", () => {
		const parameters = buildProviderChatModelParameters({
			...baseConfiguration,
			type: "anthropic-compatible",
			protocol: "anthropic-messages",
			maxOutputTokens: 4_096,
			reasoning: { budgetTokens: 0 },
		});

		expect(parameters.thinkingBudgetTokens).toBe(0);
		expect(parameters.maxOutputTokens).toBe(4_096);
	});
});

describe("createProviderChatModel", () => {
	test("uses explicit protocol adapters and never delegates routing to ChatOpenAI", () => {
		expect(createProviderChatModel(baseConfiguration)).toBeInstanceOf(ChatOpenAICompletions);
		expect(
			createProviderChatModel({
				...baseConfiguration,
				protocol: "openai-responses",
			}),
		).toBeInstanceOf(ChatOpenAIResponses);
		expect(
			createProviderChatModel({
				...baseConfiguration,
				type: "anthropic-compatible",
				protocol: "anthropic-messages",
			}),
		).toBeInstanceOf(ChatAnthropic);
	});

	test("keeps a Responses-looking model name on Chat Completions when the protocol says so", () => {
		const model = createProviderChatModel({
			...baseConfiguration,
			model: "gpt-5.6-sol",
			protocol: "openai-chat-completions",
		});

		expect(model).toBeInstanceOf(ChatOpenAICompletions);
		expect(model).not.toBeInstanceOf(ChatOpenAIResponses);
	});

	test("sends Chat Completions and Anthropic Messages to their explicit endpoints", async () => {
		const observedPaths: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				observedPaths.push(path);
				return path === "/v1/messages"
					? Response.json(createAnthropicReply("Anthropic answer"))
					: Response.json(createChatCompletionsReply("OpenAI answer"));
			},
		});

		try {
			const chatCompletions = createProviderChatModel({
				...baseConfiguration,
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				model: "gpt-5.6-sol",
			});
			const anthropicMessages = createProviderChatModel({
				...baseConfiguration,
				type: "anthropic-compatible",
				protocol: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${server.port}`,
				model: "claude-opus-4.6",
			});

			await expect(chatCompletions.invoke([new HumanMessage("Hello")])).resolves.toMatchObject({
				content: "OpenAI answer",
			});
			await expect(anthropicMessages.invoke([new HumanMessage("Hello")])).resolves.toMatchObject({
				content: "Anthropic answer",
			});
			expect(observedPaths).toEqual(["/v1/chat/completions", "/v1/messages"]);
		} finally {
			server.stop(true);
		}
	});
});

describe("OpenAI Responses history", () => {
	test("serializes Responses replies as output_text on the next turn", async () => {
		const observedBodies: unknown[] = [];
		const observedPaths: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				observedPaths.push(new URL(request.url).pathname);
				observedBodies.push(await request.json());
				if (observedBodies.length === 1) {
					return Response.json(createResponsesReply("First answer"));
				}
				return Response.json(
					{
						error: {
							message: "Request captured",
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
			},
		});
		const model = createProviderChatModel({
			...baseConfiguration,
			protocol: "openai-responses",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		});

		try {
			const firstReply = await model.invoke([new HumanMessage("First question")]);

			expect(firstReply.response_metadata.model_provider).toBe("openai");
			expect(firstReply.content).toEqual([{ type: "text", text: "First answer", annotations: [] }]);
			await expect(
				model.invoke([
					new HumanMessage("First question"),
					firstReply,
					new HumanMessage("Follow-up question"),
				]),
			).rejects.toThrow();

			expect(observedBodies[1]).toMatchObject({
				input: [
					{ role: "user", content: "First question" },
					{
						role: "assistant",
						content: [{ type: "output_text", text: "First answer" }],
					},
					{ role: "user", content: "Follow-up question" },
				],
			});
			expect(JSON.stringify(observedBodies[1])).not.toContain(
				'"role":"assistant","content":[{"type":"input_text"',
			);
			expect(observedPaths).toEqual(["/v1/responses", "/v1/responses"]);
		} finally {
			server.stop(true);
		}
	});
});

function createChatCompletionsReply(text: string) {
	return {
		id: "chatcmpl_moshu_test",
		object: "chat.completion",
		created: 1_753_418_400,
		model: "moshu-test",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text, refusal: null },
				finish_reason: "stop",
				logprobs: null,
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function createAnthropicReply(text: string) {
	return {
		id: "msg_moshu_test",
		type: "message",
		role: "assistant",
		model: "moshu-test",
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 1, output_tokens: 1 },
	};
}

function createResponsesReply(text: string) {
	return {
		id: "resp_moshu_test",
		object: "response",
		created_at: 1_753_418_400,
		status: "completed",
		model: "moshu-test",
		output_text: text,
		output: [
			{
				id: "msg_moshu_test",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		],
		usage: {
			input_tokens: 1,
			output_tokens: 1,
			total_tokens: 2,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
}
