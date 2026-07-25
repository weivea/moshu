import { z } from "zod/v4";
import {
	type AgentMiddleware,
	type InterruptOnConfig,
	type ReactAgent,
	type CreateAgentParams,
	StructuredTool,
} from "langchain";
import { Command } from "@langchain/langgraph";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import type { FilesystemPermission } from "../permissions/types.js";
export type { AgentMiddleware };
/**
 * Config key used by task-tool callers to request dynamic response format.
 *
 * When set in `config.configurable`, the task tool recompiles the target
 * subagent with this response format instead of using the pre-compiled graph.
 */
export declare const SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY = "__deepagents_subagent_response_format";
/**
 * Default system prompt for subagents.
 * Provides a minimal base prompt that can be extended by specific subagent configurations.
 */
export declare const DEFAULT_SUBAGENT_PROMPT =
	"In order to complete the objective that the user asks of you, you have access to a number of standard tools.";
/**
 * Default description for the general-purpose subagent.
 * This description is shown to the model when selecting which subagent to use.
 */
export declare const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
	"General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.";
/**
 * Type definitions for pre-compiled agents.
 *
 * @typeParam TRunnable - The type of the runnable (ReactAgent or Runnable).
 *   When using `createAgent` or `createDeepAgent`, this preserves the middleware
 *   types for type inference. Uses `ReactAgent<any>` to accept agents with any
 *   type configuration (including DeepAgent instances).
 */
export interface CompiledSubAgent<
	TRunnable extends ReactAgent<any> | Runnable = ReactAgent<any> | Runnable,
> {
	/** The name of the agent */
	name: string;
	/** The description of the agent */
	description: string;
	/** The agent instance */
	runnable: TRunnable;
}
/**
 * Specification for a subagent that can be dynamically created.
 *
 * When using `createDeepAgent`, subagents automatically receive a default middleware
 * stack (filesystemMiddleware, summarizationMiddleware, etc.) before any custom
 * `middleware` specified in this spec. Add `todoListMiddleware` explicitly to opt in.
 *
 * Required fields:
 * - `name`: Identifier used to select this subagent in the task tool
 * - `description`: Shown to the model for subagent selection
 * - `systemPrompt`: The system prompt for the subagent
 *
 * Optional fields:
 * - `model`: Override the default model for this subagent
 * - `tools`: Override the default tools for this subagent
 * - `middleware`: Additional middleware appended after defaults
 * - `interruptOn`: Human-in-the-loop configuration for specific tools
 * - `skills`: Skill source paths for SkillsMiddleware (e.g., `["/skills/user/", "/skills/project/"]`)
 *
 * @example
 * ```typescript
 * const researcher: SubAgent = {
 *   name: "researcher",
 *   description: "Research assistant for complex topics",
 *   systemPrompt: "You are a research assistant.",
 *   tools: [webSearchTool],
 *   skills: ["/skills/research/"],
 * };
 * ```
 */
export interface SubAgent {
	/** Identifier used to select this subagent in the task tool */
	name: string;
	/** Description shown to the model for subagent selection */
	description: string;
	/** The system prompt to use for the agent */
	systemPrompt: string;
	/** The tools to use for the agent (tool instances, not names). Defaults to defaultTools */
	tools?: StructuredTool[];
	/** The model for the agent. Defaults to defaultModel */
	model?: LanguageModelLike | string;
	/** Additional middleware to append after default_middleware */
	middleware?: readonly AgentMiddleware[];
	/** Human-in-the-loop configuration for specific tools. Requires a checkpointer. */
	interruptOn?: Record<string, boolean | InterruptOnConfig>;
	/**
	 * Skill source paths for SkillsMiddleware.
	 *
	 * List of paths to skill directories (e.g., `["/skills/user/", "/skills/project/"]`).
	 * When specified, the subagent will have its own SkillsMiddleware that loads skills
	 * from these paths. This allows subagents to have different skill sets than the main agent.
	 *
	 * Note: Custom subagents do NOT inherit skills from the main agent by default.
	 * Only the general-purpose subagent inherits the main agent's skills.
	 *
	 * @example
	 * ```typescript
	 * const researcher: SubAgent = {
	 *   name: "researcher",
	 *   description: "Research assistant",
	 *   systemPrompt: "You are a researcher.",
	 *   skills: ["/skills/research/", "/skills/web-search/"],
	 * };
	 * ```
	 */
	skills?: string[];
	/**
	 * Structured output response format for the subagent.
	 *
	 * When specified, the subagent will produce a `structuredResponse` conforming to the
	 * given schema. The structured response is JSON-serialized and returned as the
	 * ToolMessage content to the parent agent, replacing the default last-message extraction.
	 *
	 * Accepts any format supported by `createAgent`: Zod schemas, JSON schema objects,
	 * `toolStrategy(schema)`, `providerStrategy(schema)`, etc.
	 *
	 * @example
	 * ```typescript
	 * import { z } from "zod"
	 *
	 * const analyzer: SubAgent = {
	 *   name: "analyzer",
	 *   description: "Analyzes data and returns structured findings",
	 *   systemPrompt: "Analyze the data and return your findings.",
	 *   responseFormat: z.object({
	 *     findings: z.string(),
	 *     confidence: z.number(),
	 *   }),
	 * };
	 * ```
	 */
	responseFormat?: CreateAgentParams["responseFormat"];
	/**
	 * Filesystem permission rules for this subagent.
	 *
	 * When specified, these rules **replace** the parent agent's permissions
	 * for all tool calls made by this subagent. When omitted, the subagent
	 * inherits the parent agent's permissions.
	 *
	 * Subagent permissions are a full replacement, not a merge.
	 *
	 * @example
	 * ```ts
	 * // Parent denies /restricted/**; this subagent can read it.
	 * const reader: SubAgent = {
	 *   name: "reader",
	 *   permissions: [
	 *     { operations: ["read"], paths: ["/restricted/**"] },
	 *   ],
	 * };
	 * ```
	 */
	permissions?: FilesystemPermission[];
}
/**
 * Base specification for the general-purpose subagent.
 *
 * This constant provides the default configuration for the general-purpose subagent
 * that is automatically included when `generalPurposeAgent: true` (the default).
 *
 * The general-purpose subagent:
 * - Has access to all tools from the main agent
 * - Inherits skills from the main agent (when skills are configured)
 * - Uses the same model as the main agent (by default)
 * - Is ideal for delegating complex, multi-step tasks
 *
 * You can spread this constant and override specific properties when creating
 * custom subagents that should behave similarly to the general-purpose agent:
 *
 * @example
 * ```typescript
 * import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent } from "@anthropic/deepagents";
 *
 * // Use as-is (automatically included with generalPurposeAgent: true)
 * const agent = createDeepAgent({ model: "claude-sonnet-4-5-20250929" });
 *
 * // Or create a custom variant with different tools
 * const customGP: SubAgent = {
 *   ...GENERAL_PURPOSE_SUBAGENT,
 *   name: "research-gp",
 *   tools: [webSearchTool, readFileTool],
 * };
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   subagents: [customGP],
 *   // Disable the default general-purpose agent since we're providing our own
 *   // (handled automatically when using createSubAgentMiddleware directly)
 * });
 * ```
 */
export declare const GENERAL_PURPOSE_SUBAGENT: Pick<
	SubAgent,
	"name" | "description" | "systemPrompt"
>;
/**
 * Create a runnable agent from a declarative `SubAgent` spec.
 *
 * This is the shared entrypoint for compiling a `SubAgent` into a
 * `ReactAgent`. Pre-compiled `CompiledSubAgent` runnables bypass this
 * function entirely.
 *
 * The spec must have `model` and `tools` set — the caller is responsible
 * for coalescing any defaults before calling this function.
 *
 * @param spec - Declarative subagent specification. Must specify `model` and `tools`.
 * @returns A compiled `ReactAgent` ready for task-tool invocation.
 */
export declare function createSubAgent(
	spec: SubAgent,
	options?: {
		responseFormat?: CreateAgentParams["responseFormat"];
	},
): ReactAgent;
/**
 * Options for creating subagent middleware
 */
export interface SubAgentMiddlewareOptions {
	/** The model to use for subagents */
	defaultModel: LanguageModelLike | string;
	/** The tools to use for the default general-purpose subagent */
	defaultTools?: StructuredTool[];
	/** Default middleware to apply to custom subagents (WITHOUT skills from main agent) */
	defaultMiddleware?: AgentMiddleware[] | null;
	/**
	 * Middleware specifically for the general-purpose subagent (includes skills from main agent).
	 * If not provided, falls back to defaultMiddleware.
	 */
	generalPurposeMiddleware?: AgentMiddleware[] | null;
	/** The tool configs for the default general-purpose subagent */
	defaultInterruptOn?: Record<string, boolean | InterruptOnConfig> | null;
	/** A list of additional subagents to provide to the agent */
	subagents?: (SubAgent | CompiledSubAgent)[];
	/** Full system prompt override */
	systemPrompt?: string | null;
	/** Whether to include the general-purpose agent */
	generalPurposeAgent?: boolean;
	/** Custom description for the task tool */
	taskDescription?: string | null;
}
/**
 * Create subagent middleware with task tool
 */
export declare function createSubAgentMiddleware(
	options: SubAgentMiddlewareOptions,
): AgentMiddleware<
	undefined,
	undefined,
	unknown,
	readonly [
		import("langchain").DynamicStructuredTool<
			z.ZodObject<
				{
					description: z.ZodString;
					subagent_type: z.ZodString;
				},
				z.core.$strip
			>,
			{
				description: string;
				subagent_type: string;
			},
			{
				description: string;
				subagent_type: string;
			},
			string | Command<unknown, Record<string, unknown>, string>,
			unknown,
			"task"
		>,
	],
	readonly []
>;
