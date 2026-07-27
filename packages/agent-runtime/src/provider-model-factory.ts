import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
	type BaseChatOpenAIFields,
	ChatOpenAICompletions,
	ChatOpenAIResponses,
} from "@langchain/openai";
import { minOutputTokensAboveThinkingBudget } from "@moshu/contracts";

import type { ModelProtocol } from "./model-catalog";
import type { ResolvedProviderConfiguration } from "./provider-registry";

const anthropicApiVersion = "2023-06-01";

export interface ProviderChatModelParameters {
	model: string;
	baseUrl: string;
	defaultHeaders?: Record<string, string>;
	/** OpenAI-compatible `reasoning_effort`. */
	reasoningEffort?: string;
	/** Anthropic extended thinking budget. `0` disables thinking explicitly. */
	thinkingBudgetTokens?: number;
	maxOutputTokens?: number;
}

/**
 * Builds the request parameters for a provider without instantiating a client, so the mapping
 * between the stored configuration and each wire protocol stays directly testable.
 */
export function buildProviderChatModelParameters(
	configuration: ResolvedProviderConfiguration,
): ProviderChatModelParameters {
	const parameters: ProviderChatModelParameters = {
		model: configuration.model,
		baseUrl: configuration.baseUrl,
	};
	const defaultHeaders = configuration.customHeaders;
	if (defaultHeaders !== undefined && Object.keys(defaultHeaders).length > 0) {
		parameters.defaultHeaders = { ...defaultHeaders };
	}

	const effort = configuration.reasoning?.effort;
	if (effort !== undefined) {
		parameters.reasoningEffort = effort;
	}

	// Only the Anthropic Messages wire format carries a thinking budget, so no other protocol gets
	// one — and no other protocol has its output ceiling rewritten because of one.
	const budgetTokens =
		configuration.protocol === "anthropic-messages"
			? configuration.reasoning?.budgetTokens
			: undefined;
	if (budgetTokens !== undefined) {
		parameters.thinkingBudgetTokens = budgetTokens;
		if (budgetTokens > 0) {
			// Anthropic requires max_tokens to leave room for the answer after the thinking budget.
			const declaredMax = configuration.maxOutputTokens;
			const requiredMax = budgetTokens + minOutputTokensAboveThinkingBudget;
			parameters.maxOutputTokens =
				declaredMax === undefined ? requiredMax : Math.max(declaredMax, requiredMax);
		} else if (configuration.maxOutputTokens !== undefined) {
			parameters.maxOutputTokens = configuration.maxOutputTokens;
		}
	}

	return parameters;
}

export function createProviderChatModel(
	configuration: ResolvedProviderConfiguration,
): BaseLanguageModel {
	const parameters = buildProviderChatModelParameters(configuration);

	if (configuration.protocol === "anthropic-messages") {
		return createAnthropicModel(configuration.apiKey, parameters);
	}

	return createOpenAiCompatibleModel(configuration.apiKey, parameters, configuration.protocol);
}

function createOpenAiCompatibleModel(
	apiKey: string,
	parameters: ProviderChatModelParameters,
	protocol: Exclude<ModelProtocol, "anthropic-messages">,
): ChatOpenAICompletions | ChatOpenAIResponses {
	const fields = {
		apiKey,
		model: parameters.model,
		maxRetries: 0,
		configuration: {
			baseURL: parameters.baseUrl,
			...(parameters.defaultHeaders === undefined
				? {}
				: { defaultHeaders: parameters.defaultHeaders }),
		},
		...(parameters.reasoningEffort === undefined
			? {}
			: { reasoning: { effort: parameters.reasoningEffort } }),
		...(parameters.maxOutputTokens === undefined ? {} : { maxTokens: parameters.maxOutputTokens }),
	} as BaseChatOpenAIFields;

	return protocol === "openai-responses"
		? new ChatOpenAIResponses(fields)
		: new ChatOpenAICompletions(fields);
}

function createAnthropicModel(
	apiKey: string,
	parameters: ProviderChatModelParameters,
): ChatAnthropic {
	const defaultHeaders = {
		"anthropic-version": anthropicApiVersion,
		...(parameters.defaultHeaders ?? {}),
	};

	return new ChatAnthropic({
		apiKey,
		model: parameters.model,
		maxRetries: 0,
		anthropicApiUrl: parameters.baseUrl,
		clientOptions: { defaultHeaders },
		...(parameters.thinkingBudgetTokens === undefined
			? {}
			: {
					thinking:
						parameters.thinkingBudgetTokens > 0
							? { type: "enabled", budget_tokens: parameters.thinkingBudgetTokens }
							: { type: "disabled" },
				}),
		...(parameters.maxOutputTokens === undefined ? {} : { maxTokens: parameters.maxOutputTokens }),
		// Anthropic-compatible gateways that advertise reasoning_effort accept it as extra body.
		...(parameters.reasoningEffort === undefined
			? {}
			: { modelKwargs: { reasoning_effort: parameters.reasoningEffort } }),
	} as ConstructorParameters<typeof ChatAnthropic>[0]);
}
