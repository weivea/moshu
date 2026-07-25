import { Command, ReducedValue, StateSchema } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { type ToolRuntime } from "langchain";
import { z } from "zod/v4";
import type { AnySubAgent } from "../types.js";
/**
 * Specification for an async subagent running on a remote [Agent Protocol](https://github.com/langchain-ai/agent-protocol)
 * server.
 *
 * Async subagents connect to any Agent Protocol-compliant server via the
 * LangGraph SDK. They run as background tasks that the main agent can
 * monitor and update.
 *
 * Compatible with LangGraph Platform (managed) and self-hosted servers.
 * Authentication for LangGraph Platform is handled automatically by the SDK
 * via environment variables (`LANGGRAPH_API_KEY`, `LANGSMITH_API_KEY`, or
 * `LANGCHAIN_API_KEY`). For self-hosted servers, pass custom auth via `headers`.
 */
export interface AsyncSubAgent {
	/** Unique identifier for the async subagent. */
	name: string;
	/** What this subagent does. The main agent uses this to decide when to delegate. */
	description: string;
	/** The graph name or assistant ID on the Agent Protocol server. */
	graphId: string;
	/** URL of the Agent Protocol server. Defaults to the LangGraph SDK's default endpoint. */
	url?: string;
	/** Additional headers to include in requests to the server (e.g. for custom auth). */
	headers?: Record<string, string>;
}
/**
 * Possible statuses for an async subagent task.
 *
 * Statuses set by the middleware tools: `"running"`, `"success"`, `"error"`, `"cancelled"`.
 * Statuses that may be returned by the remote server: `"pending"`, `"timeout"`, `"interrupted"`.
 */
export type AsyncTaskStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	| "cancelled"
	| "timeout"
	| "interrupted";
/**
 * A tracked async subagent task persisted in agent state.
 *
 * Each task maps to a single thread + run on a remote Agent Protocol server.
 * The `taskId` is the same as `threadId`, so it can be used to look up
 * the thread directly via the SDK.
 */
export interface AsyncTask {
	/** Unique identifier for the task (same as thread id). */
	taskId: string;
	/** Name of the async subagent type that is running. */
	agentName: string;
	/** Thread ID on the remote server. */
	threadId: string;
	/** Run ID for the current execution on the thread. */
	runId: string;
	/** Current task status. */
	status: AsyncTaskStatus;
	/** ISO timestamp of when the task was launched. */
	createdAt: string;
	/** The prompt/description passed to the subagent when the task was launched. */
	description?: string;
	/** ISO timestamp of the most recent task update — set when the task status changes or a follow-up message is sent via the update tool. */
	updatedAt?: string;
	/** ISO timestamp of the most recent status poll via the check tool. */
	checkedAt?: string;
}
/**
 * Shape of the async subagent state channel.
 *
 * Used with {@link ToolRuntime} so tools get typed access to `asyncTasks`.
 *
 * Declared as a `type` (not `interface`) so `ToolRuntime<AsyncTaskState>` narrows
 * `runtime.state` correctly (see `@langchain/core` `ToolRuntime` conditional).
 */
type AsyncTaskState = {
	/** All tracked async subagent tasks, keyed by task ID. */
	asyncTasks?: Record<string, AsyncTask>;
};
/**
 * Reducer for the `asyncTasks` state channel.
 *
 * Merges task updates into the existing tasks dict using shallow spread.
 * This allows individual tools to update a single task without overwriting
 * the full map — only the keys present in `update` are replaced.
 *
 * @param existing - The current tasks dict from state (may be undefined on first write).
 * @param update - New or updated task entries to merge in.
 * @returns Merged tasks dict.
 */
export declare function asyncTasksReducer(
	existing?: Record<string, AsyncTask>,
	update?: Record<string, AsyncTask>,
): Record<string, AsyncTask>;
/**
 * Task statuses that will never change.
 *
 * When listing tasks, live-status fetches are skipped for tasks whose
 * cached status is in this set, since they are guaranteed to be final.
 */
/**
 * Names of the tools added by the async subagent middleware.
 *
 * Exported so `agent.ts` can include them in `BUILTIN_TOOL_NAMES` and
 * surface a `ConfigurationError` if a user-provided tool collides.
 */
export declare const ASYNC_TASK_TOOL_NAMES: readonly [
	"start_async_task",
	"check_async_task",
	"update_async_task",
	"cancel_async_task",
	"list_async_tasks",
];
export declare const TERMINAL_STATUSES: Set<AsyncTaskStatus>;
/**
 * Lazily-created, cached LangGraph SDK clients keyed by (url, headers).
 *
 * Agents that share the same URL and headers will reuse a single `Client`
 * instance, avoiding unnecessary connections.
 */
export declare class ClientCache {
	private agents;
	private clients;
	constructor(agents: Record<string, AsyncSubAgent>);
	/**
	 * Build headers for a remote Agent Protocol server.
	 *
	 * Adds `x-auth-scheme: langsmith` by default unless already provided.
	 * For self-hosted servers that don't require this header, it is typically
	 * ignored. Override via the `headers` field on the AsyncSubAgent config.
	 */
	private resolveHeaders;
	/**
	 * Build a stable cache key from a spec's url and resolved headers.
	 */
	private cacheKey;
	/**
	 * Get or create a `Client` for the named agent.
	 */
	getClient(name: string): Client;
}
/**
 * Extract the callback thread ID from the tool runtime.
 *
 * The thread ID is included in the subagent's input state so the subagent
 * can notify the parent when it completes (via
 * `CompletionCallbackMiddleware`).
 *
 * @returns Object with `callbackThreadId` if available. Empty object otherwise.
 */
export declare function extractCallbackContext(
	runtime: ToolRuntime<AsyncTaskState>,
): Record<string, string>;
/**
 * Build the `start_async_task` tool.
 *
 * Creates a thread on the remote server, starts a run, and returns a
 * `Command` that persists the new task in state.
 */
export declare function buildStartTool(
	agentMap: Record<string, AsyncSubAgent>,
	clients: ClientCache,
	toolDescription: string,
): import("langchain").DynamicStructuredTool<
	z.ZodObject<
		{
			description: z.ZodString;
			agentName: z.ZodString;
		},
		z.core.$strip
	>,
	{
		description: string;
		agentName: string;
	},
	{
		description: string;
		agentName: string;
	},
	string | Command<unknown, Record<string, unknown>, string>,
	unknown,
	"start_async_task"
>;
/**
 * Build the `check_async_task` tool.
 *
 * Fetches the current run status from the remote server and, if the run
 * succeeded, retrieves the thread state to extract the result.
 */
export declare function buildCheckTool(
	clients: ClientCache,
): import("langchain").DynamicStructuredTool<
	z.ZodObject<
		{
			taskId: z.ZodString;
		},
		z.core.$strip
	>,
	{
		taskId: string;
	},
	{
		taskId: string;
	},
	string | Command<unknown, Record<string, unknown>, string>,
	unknown,
	"check_async_task"
>;
/**
 * Build the `update_async_task` tool.
 *
 * Sends a follow-up message to a running async subagent by creating a new
 * run on the same thread with `multitaskStrategy: "interrupt"`. The subagent
 * sees the full conversation history plus the new message. The `taskId`
 * remains the same; only the internal `runId` is updated.
 */
export declare function buildUpdateTool(
	agentMap: Record<string, AsyncSubAgent>,
	clients: ClientCache,
): import("langchain").DynamicStructuredTool<
	z.ZodObject<
		{
			taskId: z.ZodString;
			message: z.ZodString;
		},
		z.core.$strip
	>,
	{
		taskId: string;
		message: string;
	},
	{
		taskId: string;
		message: string;
	},
	string | Command<unknown, Record<string, unknown>, string>,
	unknown,
	"update_async_task"
>;
/**
 * Build the `cancel_async_task` tool.
 *
 * Cancels the current run on the remote server and updates the task's
 * cached status to `"cancelled"`.
 */
export declare function buildCancelTool(
	clients: ClientCache,
): import("langchain").DynamicStructuredTool<
	z.ZodObject<
		{
			taskId: z.ZodString;
		},
		z.core.$strip
	>,
	{
		taskId: string;
	},
	{
		taskId: string;
	},
	string | Command<unknown, Record<string, unknown>, string>,
	unknown,
	"cancel_async_task"
>;
/**
 * Build the `list_async_tasks` tool.
 *
 * Lists all tracked tasks with their live statuses fetched in parallel.
 * Supports optional filtering by cached status.
 */
export declare function buildListTool(
	clients: ClientCache,
): import("langchain").DynamicStructuredTool<
	z.ZodObject<
		{
			statusFilter: z.ZodOptional<z.ZodNullable<z.ZodString>>;
		},
		z.core.$strip
	>,
	{
		statusFilter?: string | null | undefined;
	},
	{
		statusFilter?: string | null | undefined;
	},
	string | Command<unknown, Record<string, unknown>, string>,
	unknown,
	"list_async_tasks"
>;
/**
 * Options for creating async subagent middleware.
 */
export interface AsyncSubAgentMiddlewareOptions {
	/** List of async subagent specifications. Must have at least one. */
	asyncSubAgents: AsyncSubAgent[];
	/** Optional system prompt override. Tool schemas provide the built-in guidance. */
	systemPrompt?: string | null;
}
/**
 * Create middleware that adds async subagent tools to an agent.
 *
 * Provides five tools for launching, checking, updating, cancelling, and
 * listing background tasks on remote Agent Protocol servers. Task state is
 * persisted in the `asyncTasks` state channel so it survives
 * context compaction.
 *
 * Works with any Agent Protocol-compliant server — LangGraph Platform (managed)
 * or self-hosted (e.g. a Hono/Express server implementing the Agent Protocol spec).
 *
 * @throws {Error} If no async subagents are provided or names are duplicated.
 *
 * @example
 * ```ts
 * const middleware = createAsyncSubAgentMiddleware({
 *   asyncSubAgents: [{
 *     name: "researcher",
 *     description: "Research agent for deep analysis",
 *     url: "https://my-agent-protocol-server.example.com",
 *     graphId: "research_agent",
 *   }],
 * });
 * ```
 */
/**
 * Type guard to distinguish async SubAgents from sync SubAgents/CompiledSubAgents.
 *
 * Uses the presence of the `graphId` field as the runtime discriminant —
 * `AsyncSubAgent` requires it, while `SubAgent` and `CompiledSubAgent` do not have it.
 */
export declare function isAsyncSubAgent(subAgent: AnySubAgent): subAgent is AsyncSubAgent;
export declare function createAsyncSubAgentMiddleware(
	options: AsyncSubAgentMiddlewareOptions,
): import("langchain").AgentMiddleware<
	StateSchema<{
		asyncTasks: ReducedValue<
			| Record<
					string,
					{
						taskId: string;
						agentName: string;
						threadId: string;
						runId: string;
						status: string;
						createdAt: string;
						description?: string | undefined;
						updatedAt?: string | undefined;
						checkedAt?: string | undefined;
					}
			  >
			| undefined,
			| Record<
					string,
					{
						taskId: string;
						agentName: string;
						threadId: string;
						runId: string;
						status: string;
						createdAt: string;
						description?: string | undefined;
						updatedAt?: string | undefined;
						checkedAt?: string | undefined;
					}
			  >
			| undefined
		>;
	}>,
	undefined,
	unknown,
	(
		| import("langchain").DynamicStructuredTool<
				z.ZodObject<
					{
						description: z.ZodString;
						agentName: z.ZodString;
					},
					z.core.$strip
				>,
				{
					description: string;
					agentName: string;
				},
				{
					description: string;
					agentName: string;
				},
				string | Command<unknown, Record<string, unknown>, string>,
				unknown,
				"start_async_task"
		  >
		| import("langchain").DynamicStructuredTool<
				z.ZodObject<
					{
						taskId: z.ZodString;
					},
					z.core.$strip
				>,
				{
					taskId: string;
				},
				{
					taskId: string;
				},
				string | Command<unknown, Record<string, unknown>, string>,
				unknown,
				"check_async_task"
		  >
		| import("langchain").DynamicStructuredTool<
				z.ZodObject<
					{
						taskId: z.ZodString;
						message: z.ZodString;
					},
					z.core.$strip
				>,
				{
					taskId: string;
					message: string;
				},
				{
					taskId: string;
					message: string;
				},
				string | Command<unknown, Record<string, unknown>, string>,
				unknown,
				"update_async_task"
		  >
		| import("langchain").DynamicStructuredTool<
				z.ZodObject<
					{
						taskId: z.ZodString;
					},
					z.core.$strip
				>,
				{
					taskId: string;
				},
				{
					taskId: string;
				},
				string | Command<unknown, Record<string, unknown>, string>,
				unknown,
				"cancel_async_task"
		  >
		| import("langchain").DynamicStructuredTool<
				z.ZodObject<
					{
						statusFilter: z.ZodOptional<z.ZodNullable<z.ZodString>>;
					},
					z.core.$strip
				>,
				{
					statusFilter?: string | null | undefined;
				},
				{
					statusFilter?: string | null | undefined;
				},
				string | Command<unknown, Record<string, unknown>, string>,
				unknown,
				"list_async_tasks"
		  >
	)[],
	readonly []
>;
export {};
