import { type AgentMiddleware } from "langchain";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { InteropZodObject } from "@langchain/core/utils/types";
import type {
	AnySubAgent,
	CreateDeepAgentParams,
	DeepAgent,
	DeepAgentTypeConfig,
	FlattenSubAgentMiddleware,
	InferStructuredResponse,
	SupportedResponseFormat,
} from "./types.js";
/**
 * required for type inference
 */
import type * as _messages from "@langchain/core/messages";
import type * as _langgraph from "@langchain/langgraph";
import type { AnyStateSchema, StreamTransformer } from "@langchain/langgraph";
/**
 * Create a Deep Agent.
 *
 * This is the main entry point for building a production-style agent with
 * deepagents. It gives you a strong default runtime (filesystem, tasks,
 * subagents, summarization) and lets you opt into skills, memory,
 * human-in-the-loop interrupts, async subagents, and custom middleware.
 *
 * The runtime is intentionally opinionated: defaults work out of the box, and
 * when you customize behavior, the middleware ordering stays deterministic.
 *
 * @param params Configuration parameters for the agent
 * @returns Deep Agent instance with inferred state/response types
 *
 * @example
 * ```typescript
 * // Custom state from middleware and/or the agent stateSchema param — both are merged
 * const ResearchMiddleware = createMiddleware({
 *   name: "ResearchMiddleware",
 *   stateSchema: z.object({ research: z.string().default("") }),
 * });
 *
 * const agent = createDeepAgent({
 *   middleware: [ResearchMiddleware],
 *   stateSchema: z.object({ author: z.string().default("Me") }),
 * });
 *
 * const result = await agent.invoke({ messages: [...] });
 * // result.research and result.author are properly typed as strings
 * ```
 */
export declare function createDeepAgent<
	TResponse extends SupportedResponseFormat = SupportedResponseFormat,
	ContextSchema extends InteropZodObject = InteropZodObject,
	const TMiddleware extends readonly AgentMiddleware[] = readonly [],
	const TSubagents extends readonly AnySubAgent[] = readonly [],
	const TTools extends readonly (ClientTool | ServerTool)[] = readonly [],
	const TStreamTransformers extends ReadonlyArray<() => StreamTransformer<any>> = readonly [],
	TStateSchema extends AnyStateSchema | InteropZodObject | undefined = undefined,
>(
	params?: CreateDeepAgentParams<
		TResponse,
		ContextSchema,
		TMiddleware,
		TSubagents,
		TTools,
		TStreamTransformers,
		TStateSchema
	>,
): DeepAgent<
	DeepAgentTypeConfig<
		InferStructuredResponse<TResponse>,
		TStateSchema,
		ContextSchema,
		readonly [
			AgentMiddleware<
				_langgraph.StateSchema<{
					files: _langgraph.ReducedValue<
						import("./middleware/fs.js").FilesRecord | undefined,
						import("./middleware/fs.js").FilesRecordUpdate | undefined
					>;
				}>,
				undefined,
				unknown,
				(
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodObject<
								{
									path: import("zod").ZodDefault<
										import("zod").ZodOptional<import("zod").ZodString>
									>;
								},
								import("zod/v4/core").$strip
							>,
							{
								path: string;
							},
							{
								path?: string | undefined;
							},
							string | _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
							unknown,
							"ls"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodPreprocess<
								import("zod").ZodObject<
									{
										file_path: import("zod").ZodString;
										offset: import("zod").ZodDefault<
											import("zod").ZodOptional<import("zod").ZodCoercedNumber<unknown>>
										>;
										limit: import("zod").ZodDefault<
											import("zod").ZodOptional<import("zod").ZodCoercedNumber<unknown>>
										>;
									},
									import("zod/v4/core").$strip
								>
							>,
							{
								file_path: string;
								offset: number;
								limit: number;
							},
							unknown,
							| _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
							| {
									type: string;
									text: string;
							  }[]
							| {
									type: string;
									mimeType: string;
									data: string;
							  }[],
							unknown,
							"read_file"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodPreprocess<
								import("zod").ZodObject<
									{
										file_path: import("zod").ZodString;
										content: import("zod").ZodDefault<import("zod").ZodString>;
									},
									import("zod/v4/core").$strip
								>
							>,
							{
								file_path: string;
								content: string;
							},
							unknown,
							| string
							| _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
							| _langgraph.Command<
									unknown,
									{
										files: Record<string, import("./browser.js").FileData>;
										messages: _messages.ToolMessage<
											_messages.MessageStructure<_messages.MessageToolSet>
										>[];
									},
									string
							  >,
							unknown,
							"write_file"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodPreprocess<
								import("zod").ZodObject<
									{
										file_path: import("zod").ZodString;
										old_string: import("zod").ZodString;
										new_string: import("zod").ZodString;
										replace_all: import("zod").ZodDefault<
											import("zod").ZodOptional<import("zod").ZodBoolean>
										>;
									},
									import("zod/v4/core").$strip
								>
							>,
							{
								file_path: string;
								old_string: string;
								new_string: string;
								replace_all: boolean;
							},
							unknown,
							| string
							| _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
							| _langgraph.Command<
									unknown,
									{
										files: Record<string, import("./browser.js").FileData>;
										messages: _messages.ToolMessage<
											_messages.MessageStructure<_messages.MessageToolSet>
										>[];
									},
									string
							  >,
							unknown,
							"edit_file"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodObject<
								{
									pattern: import("zod").ZodString;
									path: import("zod").ZodOptional<import("zod").ZodString>;
								},
								import("zod/v4/core").$strip
							>,
							{
								pattern: string;
								path?: string | undefined;
							},
							{
								pattern: string;
								path?: string | undefined;
							},
							string | _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
							unknown,
							"glob"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodObject<
								{
									pattern: import("zod").ZodString;
									path: import("zod").ZodDefault<
										import("zod").ZodOptional<import("zod").ZodString>
									>;
									glob: import("zod").ZodDefault<
										import("zod").ZodNullable<import("zod").ZodOptional<import("zod").ZodString>>
									>;
								},
								import("zod/v4/core").$strip
							>,
							{
								pattern: string;
								path: string;
								glob: string | null;
							},
							{
								pattern: string;
								path?: string | undefined;
								glob?: string | null | undefined;
							},
							string | _messages.ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
							unknown,
							"grep"
					  >
					| import("langchain").DynamicStructuredTool<
							import("zod").ZodObject<
								{
									command: import("zod").ZodString;
								},
								import("zod/v4/core").$strip
							>,
							{
								command: string;
							},
							{
								command: string;
							},
							string,
							unknown,
							"execute"
					  >
				)[],
				readonly []
			>,
			AgentMiddleware<
				undefined,
				undefined,
				unknown,
				readonly [
					import("langchain").DynamicStructuredTool<
						import("zod").ZodObject<
							{
								description: import("zod").ZodString;
								subagent_type: import("zod").ZodString;
							},
							import("zod/v4/core").$strip
						>,
						{
							description: string;
							subagent_type: string;
						},
						{
							description: string;
							subagent_type: string;
						},
						string | _langgraph.Command<unknown, Record<string, unknown>, string>,
						unknown,
						"task"
					>,
				],
				readonly []
			>,
			AgentMiddleware<
				import("zod").ZodObject<
					{
						_summarizationSessionId: import("zod").ZodOptional<import("zod").ZodString>;
						_summarizationEvent: import("zod").ZodOptional<
							import("zod").ZodObject<
								{
									cutoffIndex: import("zod").ZodNumber;
									summaryMessage: import("zod").ZodCustom<
										_messages.HumanMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
										_messages.HumanMessage<_messages.MessageStructure<_messages.MessageToolSet>>
									>;
									filePath: import("zod").ZodNullable<import("zod").ZodString>;
								},
								import("zod/v4/core").$strip
							>
						>;
					},
					import("zod/v4/core").$strip
				>,
				undefined,
				unknown,
				readonly (ClientTool | ServerTool)[],
				readonly []
			>,
			AgentMiddleware<
				undefined,
				undefined,
				unknown,
				readonly (ClientTool | ServerTool)[],
				readonly []
			>,
			...TMiddleware,
			...FlattenSubAgentMiddleware<TSubagents>,
		],
		TTools,
		TSubagents,
		TStreamTransformers
	>
>;
