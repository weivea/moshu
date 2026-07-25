import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { RunnableInterface } from "@langchain/core/runnables";
/**
 * Detect whether a model is an Anthropic model.
 *
 * Used to gate Anthropic-specific prompt caching optimizations
 * (cache_control breakpoints).
 *
 * Accepts the wider `RunnableInterface` shape (the type of `request.model`
 * inside `wrapModelCall`, aliased as `AgentLanguageModelLike` in langchain)
 * because the function only depends on `.getName()`, which is part of the
 * Runnable contract. `BaseLanguageModel` extends `Runnable`, so existing
 * call sites still type-check.
 */
export declare function isAnthropicModel(
	model: BaseLanguageModel | RunnableInterface<unknown, unknown> | string,
): boolean;
/**
 * Detect whether a model is an AWS Bedrock Converse model.
 *
 * Accepts the wider `RunnableInterface` shape (the type of `request.model`
 * inside `wrapModelCall`, aliased as `AgentLanguageModelLike` in langchain)
 * because the function only depends on `.getName()`, which is part of the
 * Runnable contract. `BaseLanguageModel` extends `Runnable`, so existing
 * call sites still type-check.
 */
export declare function isBedrockConverseModel(
	model: BaseLanguageModel | RunnableInterface<unknown, unknown> | string,
): boolean;
/**
 * Extract the provider name from a model instance for profile lookup.
 *
 * Checks `_defaultConfig.modelProvider` (ConfigurableModel) and falls
 * back to known model class name → provider mappings.
 *
 * @internal
 */
export declare function getModelProvider(model: BaseLanguageModel): string | undefined;
/**
 * Extract the model identifier from a model instance for profile
 * lookup.
 *
 * Checks `_defaultConfig.model`, `model_name`, and `modelName` in
 * that order.
 *
 * @internal
 */
export declare function getModelIdentifier(model: BaseLanguageModel): string | undefined;
