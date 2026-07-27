import { describe, expect, test } from "bun:test";
import { providerModelSchema } from "@moshu/contracts";

import {
	clampBudgetTokens,
	normalizeModelListResponse,
	normalizeReasoningSelection,
	resolveModelProtocol,
	resolveReasoningCapability,
} from "../src";

const openAiResponse = {
	object: "list",
	data: [
		{ id: "gpt-4.1-mini", object: "model", created: 1_712_000_000, owned_by: "openai" },
		{ id: "gpt-5.4", object: "model", created: 1_712_000_001, owned_by: "openai" },
	],
};

const copilotResponse = {
	object: "list",
	data: [
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			object: "model",
			vendor: "OpenAI",
			preview: false,
			model_picker_enabled: true,
			supported_endpoints: ["/chat/completions", "/responses"],
			capabilities: {
				family: "gpt-5.5",
				object: "model_capabilities",
				tokenizer: "o200k_base",
				type: "chat",
				limits: {
					max_context_window_tokens: 272_000,
					max_output_tokens: 128_000,
					max_prompt_tokens: 144_000,
				},
				supports: {
					streaming: true,
					tool_calls: true,
					reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
				},
			},
		},
		{
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			object: "model",
			vendor: "Anthropic",
			capabilities: {
				type: "chat",
				limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
				supports: {
					adaptive_thinking: true,
					min_thinking_budget: 1_024,
					max_thinking_budget: 32_000,
				},
			},
		},
		{
			id: "text-embedding-3-small",
			name: "Embedding V3 small",
			object: "model",
			capabilities: { type: "embeddings", limits: {}, supports: { dimensions: true } },
		},
	],
};

const anthropicResponse = {
	data: [
		{
			id: "claude-sonnet-4-6",
			display_name: "Claude Sonnet 4.6",
			type: "model",
			created_at: "2026-02-19T00:00:00Z",
		},
	],
	has_more: false,
};

const openRouterResponse = {
	data: [
		{
			id: "anthropic/claude-opus-4.6",
			name: "Anthropic: Claude Opus 4.6",
			context_length: 200_000,
			architecture: { modality: "text+image->text" },
			top_provider: { max_completion_tokens: 64_000 },
			supported_parameters: ["max_tokens", "reasoning", "tools"],
		},
		{
			id: "meta/llama-4",
			name: "Meta: Llama 4",
			context_length: 128_000,
			supported_parameters: ["max_tokens", "tools"],
		},
	],
};

describe("normalizeModelListResponse", () => {
	test("keeps only the identifier when the OpenAI catalog declares nothing else", () => {
		const models = normalizeModelListResponse("openai-compatible", openAiResponse);

		expect(models.map((model) => model.id)).toEqual(["gpt-4.1-mini", "gpt-5.4"]);
		expect(models[0]).toEqual({ id: "gpt-4.1-mini", enabled: false, vendor: "openai" });
		expect(models[0]).not.toHaveProperty("contextWindowTokens");
		expect(models[0]).not.toHaveProperty("reasoningEfforts");
	});

	test("reads limits, effort levels and thinking budgets from the GitHub Copilot catalog", () => {
		const models = normalizeModelListResponse("openai-compatible", copilotResponse);
		const gpt = models.find((model) => model.id === "gpt-5.5");
		const claude = models.find((model) => model.id === "claude-opus-4.6");
		const embedding = models.find((model) => model.id === "text-embedding-3-small");

		expect(gpt).toMatchObject({
			displayName: "GPT-5.5",
			vendor: "OpenAI",
			kind: "chat",
			preview: false,
			contextWindowTokens: 272_000,
			maxOutputTokens: 128_000,
			supportedEndpoints: ["/chat/completions", "/responses"],
			reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
		});
		expect(gpt).not.toHaveProperty("thinking");
		expect(claude?.thinking).toEqual({
			adaptive: true,
			minBudgetTokens: 1_024,
			maxBudgetTokens: 32_000,
		});
		expect(claude).not.toHaveProperty("reasoningEfforts");
		expect(embedding?.kind).toBe("embeddings");
		expect(embedding).not.toHaveProperty("contextWindowTokens");
	});

	test("reads Anthropic display names without inventing capability metadata", () => {
		const models = normalizeModelListResponse("anthropic-compatible", anthropicResponse);

		expect(models).toEqual([
			{ id: "claude-sonnet-4-6", enabled: false, displayName: "Claude Sonnet 4.6" },
		]);
	});

	test("reads OpenRouter context windows and declared reasoning support", () => {
		const models = normalizeModelListResponse("openai-compatible", openRouterResponse);
		const claude = models.find((model) => model.id === "anthropic/claude-opus-4.6");
		const llama = models.find((model) => model.id === "meta/llama-4");

		expect(claude).toMatchObject({
			displayName: "Anthropic: Claude Opus 4.6",
			kind: "text+image->text",
			contextWindowTokens: 200_000,
			maxOutputTokens: 64_000,
			reasoningEfforts: ["low", "medium", "high"],
		});
		expect(llama).not.toHaveProperty("reasoningEfforts");
	});

	test("bounds normalized strings so the catalog stays inside the provider contract", () => {
		const models = normalizeModelListResponse("openai-compatible", {
			data: [
				{
					id: "m".repeat(400),
					name: "n".repeat(400),
					owned_by: "v".repeat(300),
					architecture: { modality: "k".repeat(200) },
					supported_endpoints: ["e".repeat(400)],
					capabilities: { supports: { reasoning_effort: ["x".repeat(80)] } },
				},
			],
		});

		const model = models[0];
		expect(model?.id).toHaveLength(200);
		expect(model?.displayName).toHaveLength(200);
		expect(model?.vendor).toHaveLength(120);
		expect(model?.kind).toHaveLength(64);
		expect(model?.supportedEndpoints?.[0]).toHaveLength(200);
		expect(model?.reasoningEfforts?.[0]).toHaveLength(32);
		expect(() => providerModelSchema.parse(model)).not.toThrow();
	});

	test("ignores malformed payloads and entries without an identifier", () => {
		expect(normalizeModelListResponse("openai-compatible", null)).toEqual([]);
		expect(normalizeModelListResponse("openai-compatible", "nope")).toEqual([]);
		expect(normalizeModelListResponse("openai-compatible", { data: {} })).toEqual([]);
		expect(
			normalizeModelListResponse("openai-compatible", {
				data: [{ object: "model" }, { id: "  " }, { id: "kept" }, { id: "kept" }],
			}),
		).toEqual([{ id: "kept", enabled: false }]);
	});
});

describe("resolveModelProtocol", () => {
	test("uses the Provider family first and preserves catalog order within that family", () => {
		const model = {
			supportedEndpoints: ["/v1/messages", "/responses", "/chat/completions"],
		};

		expect(resolveModelProtocol("openai-compatible", model)).toBe("openai-responses");
		expect(resolveModelProtocol("anthropic-compatible", model)).toBe("anthropic-messages");
		expect(
			resolveModelProtocol("openai-compatible", {
				supportedEndpoints: ["/chat/completions", "/responses"],
			}),
		).toBe("openai-chat-completions");
	});

	test("uses the first recognized cross-family endpoint when the preferred family is absent", () => {
		expect(
			resolveModelProtocol("anthropic-compatible", {
				supportedEndpoints: ["/v1/responses", "/v1/chat/completions"],
			}),
		).toBe("openai-responses");
		expect(
			resolveModelProtocol("openai-compatible", {
				supportedEndpoints: ["https://gateway.example/api/v1/messages"],
			}),
		).toBe("anthropic-messages");
	});

	test("falls back by Provider Type when endpoint metadata is absent or unrecognized", () => {
		expect(resolveModelProtocol("openai-compatible")).toBe("openai-chat-completions");
		expect(resolveModelProtocol("anthropic-compatible", {})).toBe("anthropic-messages");
		expect(
			resolveModelProtocol("openai-compatible", {
				supportedEndpoints: ["/embeddings"],
			}),
		).toBe("openai-chat-completions");
	});
});

describe("resolveReasoningCapability", () => {
	test("uses declared effort levels", () => {
		expect(
			resolveReasoningCapability("openai-compatible", {
				reasoningEfforts: ["low", "high"],
			}),
		).toEqual({ kind: "effort", levels: ["low", "high"] });
	});

	test("uses a declared thinking budget", () => {
		expect(
			resolveReasoningCapability("anthropic-compatible", {
				thinking: { adaptive: true, minBudgetTokens: 2_048, maxBudgetTokens: 32_000 },
			}),
		).toEqual({
			kind: "budget",
			adaptive: true,
			minBudgetTokens: 2_048,
			maxBudgetTokens: 32_000,
		});
	});

	test("offers both controls when an Anthropic model declares effort levels too", () => {
		expect(
			resolveReasoningCapability("anthropic-compatible", {
				reasoningEfforts: ["low", "medium"],
				thinking: { minBudgetTokens: 1_024 },
			}),
		).toEqual({
			kind: "both",
			levels: ["low", "medium"],
			minBudgetTokens: 1_024,
		});
	});

	test("offers an opt-in budget for the Anthropic protocol when nothing is declared", () => {
		expect(resolveReasoningCapability("anthropic-compatible", { maxOutputTokens: 64_000 })).toEqual(
			{
				kind: "budget",
				minBudgetTokens: 1_024,
				maxBudgetTokens: 62_976,
			},
		);
	});

	test("keeps the advertised budget ceiling under the model output limit", () => {
		expect(
			resolveReasoningCapability("anthropic-compatible", {
				thinking: { maxBudgetTokens: 32_000 },
				maxOutputTokens: 8_192,
			}),
		).toEqual({ kind: "budget", minBudgetTokens: 1_024, maxBudgetTokens: 7_168 });
	});

	test("offers no budget for OpenAI-compatible models that declare one", () => {
		expect(
			resolveReasoningCapability("openai-compatible", {
				thinking: { adaptive: true, minBudgetTokens: 1_024, maxBudgetTokens: 24_000 },
				maxOutputTokens: 16_000,
			}),
		).toEqual({ kind: "none" });
		expect(
			resolveReasoningCapability("openai-compatible", {
				reasoningEfforts: ["low", "high"],
				thinking: { minBudgetTokens: 1_024, maxBudgetTokens: 24_000 },
			}),
		).toEqual({ kind: "effort", levels: ["low", "high"] });
	});

	test("offers no control for OpenAI-compatible models without declared reasoning", () => {
		expect(resolveReasoningCapability("openai-compatible", {})).toEqual({ kind: "none" });
		expect(
			resolveReasoningCapability("openai-compatible", {
				maxOutputTokens: 4_096,
				supportedEndpoints: ["/responses"],
			}),
		).toEqual({
			kind: "none",
		});
	});

	test("derives thinking-budget support from the model endpoint, not the Provider Type", () => {
		expect(
			resolveReasoningCapability("openai-compatible", {
				supportedEndpoints: ["/v1/messages"],
				maxOutputTokens: 8_192,
			}),
		).toEqual({
			kind: "budget",
			minBudgetTokens: 1_024,
			maxBudgetTokens: 7_168,
		});
		expect(
			resolveReasoningCapability("anthropic-compatible", {
				supportedEndpoints: ["/chat/completions"],
				thinking: { minBudgetTokens: 1_024 },
			}),
		).toEqual({ kind: "none" });
	});
});

describe("normalizeReasoningSelection", () => {
	test("drops selections the capability cannot honour", () => {
		expect(
			normalizeReasoningSelection({ kind: "none" }, { effort: "high", budgetTokens: 2_048 }),
		).toBeUndefined();
		expect(
			normalizeReasoningSelection({ kind: "effort", levels: ["low"] }, { effort: "xhigh" }),
		).toBeUndefined();
		expect(
			normalizeReasoningSelection(
				{ kind: "effort", levels: ["low"] },
				{ effort: "low", budgetTokens: 4_096 },
			),
		).toEqual({ effort: "low" });
	});

	test("clamps the thinking budget into the advertised range", () => {
		const capability = {
			kind: "budget",
			minBudgetTokens: 1_024,
			maxBudgetTokens: 8_000,
		} as const;

		expect(normalizeReasoningSelection(capability, { budgetTokens: 500 })).toEqual({
			budgetTokens: 1_024,
		});
		expect(normalizeReasoningSelection(capability, { budgetTokens: 999_999 })).toEqual({
			budgetTokens: 8_000,
		});
		expect(normalizeReasoningSelection(capability, { budgetTokens: 0 })).toEqual({
			budgetTokens: 0,
		});
	});

	test("keeps zero as an explicit disable and honours open-ended maximums", () => {
		expect(clampBudgetTokens(0, 1_024, 8_000)).toBe(0);
		expect(clampBudgetTokens(-5, 1_024, 8_000)).toBe(0);
		expect(clampBudgetTokens(50_000, 1_024, undefined)).toBe(50_000);
	});
});
