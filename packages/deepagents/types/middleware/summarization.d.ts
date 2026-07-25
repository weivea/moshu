/**
 * Summarization middleware with backend support for conversation history offloading.
 *
 * This module extends the base LangChain summarization middleware with additional
 * backend-based features for persisting conversation history before summarization.
 *
 * ## Usage
 *
 * ```typescript
 * import { createSummarizationMiddleware } from "@anthropic/deepagents";
 * import { FilesystemBackend } from "@anthropic/deepagents";
 *
 * const backend = new FilesystemBackend({ rootDir: "/data" });
 *
 * const middleware = createSummarizationMiddleware({
 *   model: "gpt-4o-mini",
 *   backend,
 *   trigger: { type: "fraction", value: 0.85 },
 *   keep: { type: "fraction", value: 0.10 },
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * ## Storage
 *
 * Offloaded messages are stored as markdown at `/conversation_history/{thread_id}.md`.
 *
 * Each summarization event appends a new section to this file, creating a running log
 * of all evicted messages.
 *
 * ## Relationship to LangChain Summarization Middleware
 *
 * The base `summarizationMiddleware` from `langchain` provides core summarization
 * functionality. This middleware adds:
 * - Backend-based conversation history offloading
 * - Tool argument truncation for old messages
 *
 * For simple use cases without backend offloading, use `summarizationMiddleware`
 * from `langchain` directly.
 */
import { z } from "zod";
import { HumanMessage, type AgentMiddleware as _AgentMiddleware } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { AnyBackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
export { summarizationMiddleware } from "langchain";
/**
 * import @langchain/core/messages for type inference
 */
import type * as _core from "@langchain/core/messages";
/**
 * Context size specification for summarization triggers and retention policies.
 */
export interface ContextSize {
	/** Type of context measurement */
	type: "messages" | "tokens" | "fraction";
	/** Threshold value */
	value: number;
}
/**
 * Settings for truncating large tool arguments in old messages.
 */
export interface TruncateArgsSettings {
	/**
	 * Threshold to trigger argument truncation.
	 * If not provided, truncation is disabled.
	 */
	trigger?: ContextSize;
	/**
	 * Context retention policy for message truncation.
	 * Defaults to keeping last 20 messages.
	 */
	keep?: ContextSize;
	/**
	 * Maximum character length for tool arguments before truncation.
	 * Defaults to 2000.
	 */
	maxLength?: number;
	/**
	 * Text to replace truncated arguments with.
	 * Defaults to "...(argument truncated)".
	 */
	truncationText?: string;
}
/**
 * Options for the summarization middleware.
 */
export interface SummarizationMiddlewareOptions {
	/**
	 * The language model to use for generating summaries.
	 * Can be a model string (e.g., "gpt-4o-mini") or a language model instance.
	 * If omitted, middleware will use the active request model.
	 */
	model?: string | BaseChatModel | BaseLanguageModel;
	/**
	 * Backend instance or factory for persisting conversation history.
	 */
	backend:
		| AnyBackendProtocol
		| BackendFactory
		| ((config: { state: unknown; store?: BaseStore }) => StateBackend);
	/**
	 * Threshold(s) that trigger summarization.
	 * Can be a single ContextSize or an array for multiple triggers.
	 */
	trigger?: ContextSize | ContextSize[];
	/**
	 * Context retention policy after summarization.
	 * Defaults to keeping last 20 messages.
	 */
	keep?: ContextSize;
	/**
	 * Prompt template for generating summaries.
	 */
	summaryPrompt?: string;
	/**
	 * Max tokens to include when generating summary.
	 * Defaults to 4000.
	 */
	trimTokensToSummarize?: number;
	/**
	 * Path prefix for storing conversation history.
	 * Defaults to "/conversation_history".
	 */
	historyPathPrefix?: string;
	/**
	 * Settings for truncating large tool arguments in old messages.
	 * If not provided, argument truncation is disabled.
	 */
	truncateArgsSettings?: TruncateArgsSettings;
}
/**
 * Compute summarization defaults based on model profile.
 * Mirrors Python's `_compute_summarization_defaults`.
 *
 * If the model has a profile with `maxInputTokens`, uses fraction-based
 * settings. Otherwise, uses fixed token/message counts.
 *
 * @param resolvedModel - The resolved chat model instance.
 */
export declare function computeSummarizationDefaults(resolvedModel: BaseChatModel): {
	trigger: ContextSize;
	keep: ContextSize;
	truncateArgsSettings: TruncateArgsSettings;
};
/**
 * Zod schema for a summarization event that tracks what was summarized and
 * where the cutoff is.
 *
 * Instead of rewriting LangGraph state with `RemoveMessage(REMOVE_ALL_MESSAGES)`,
 * the middleware stores this event and uses it to reconstruct the effective message
 * list on subsequent calls.
 */
declare const SummarizationEventSchema: z.ZodObject<
	{
		cutoffIndex: z.ZodNumber;
		summaryMessage: z.ZodCustom<
			HumanMessage<_core.MessageStructure<_core.MessageToolSet>>,
			HumanMessage<_core.MessageStructure<_core.MessageToolSet>>
		>;
		filePath: z.ZodNullable<z.ZodString>;
	},
	z.core.$strip
>;
/**
 * Represents a summarization event that tracks what was summarized and where the cutoff is.
 */
export type SummarizationEvent = z.infer<typeof SummarizationEventSchema>;
/**
 * Create summarization middleware with backend support for conversation history offloading.
 *
 * This middleware:
 * 1. Monitors conversation length against configured thresholds
 * 2. When triggered, offloads old messages to backend storage
 * 3. Generates a summary of offloaded messages
 * 4. Replaces old messages with the summary, preserving recent context
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for summarization and history offloading
 */
export declare function createSummarizationMiddleware(
	options: SummarizationMiddlewareOptions,
): _AgentMiddleware<
	z.ZodObject<
		{
			_summarizationSessionId: z.ZodOptional<z.ZodString>;
			_summarizationEvent: z.ZodOptional<
				z.ZodObject<
					{
						cutoffIndex: z.ZodNumber;
						summaryMessage: z.ZodCustom<
							HumanMessage<_core.MessageStructure<_core.MessageToolSet>>,
							HumanMessage<_core.MessageStructure<_core.MessageToolSet>>
						>;
						filePath: z.ZodNullable<z.ZodString>;
					},
					z.core.$strip
				>
			>;
		},
		z.core.$strip
	>,
	undefined,
	unknown,
	readonly (ClientTool | ServerTool)[],
	readonly []
>;
