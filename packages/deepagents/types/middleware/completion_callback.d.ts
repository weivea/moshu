/**
 * Callback middleware for async subagents.
 *
 * @experimental - this middleware is experimental and may change in future releases.
 *
 * This middleware sends a notification to a callback thread when a subagent
 * completes successfully or raises an error. The callback agent can then
 * process that notification instead of relying only on polling via
 * `check_async_task`.
 *
 * ## Architecture
 *
 * A parent agent launches a subagent with `start_async_task` and can later
 * inspect task state with `check_async_task`. This middleware adds an optional
 * completion signal by creating a run on the callback thread when the subagent
 * finishes.
 *
 * ```
 * Parent                        Subagent
 *     |                            |
 *     |--- start_async_task -----> |
 *     |<-- task_id (immediately) - |
 *     |                            |  (working...)
 *     |                            |  (done!)
 *     |                            |
 *     |<-- runs.create(            |
 *     |      callback_thread,      |
 *     |      "completed: ...")     |
 *     |                            |
 *     |  (processes result)        |
 * ```
 *
 * The middleware calls `runs.create()` on the callback thread. From the
 * callback agent's perspective, this appears as a new user message containing
 * structured output from the subagent.
 *
 * ## Callback context
 *
 * - `callbackGraphId` identifies the callback graph or assistant. It is
 *   provided when the middleware is constructed.
 * - `url` and `headers` optionally configure a remote callback destination.
 *   Omit `url` for same-deployment ASGI transport.
 * - `callback_thread_id` is stored in the subagent state by the parent's
 *   `start_async_task` tool. Because it is stored in state rather than config,
 *   it survives thread updates and interrupts.
 * - If `callback_thread_id` is not present in state, the middleware does
 *   nothing.
 *
 * ## Usage
 *
 * ```typescript
 * import { createCompletionCallbackMiddleware } from "@moshu/deepagents";
 *
 * // Same deployment (callback agent and subagent share a server):
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 * });
 *
 * // Remote deployment (callback destination on a different server):
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 *   url: "https://my-deployment.langsmith.dev",
 * });
 *
 * const agent = createDeepAgent({
 *   model,
 *   middleware: [notifier],
 * });
 * ```
 *
 * The middleware reads `callbackThreadId` from the agent state at the end of
 * execution. This value is injected by the parent's `start_async_task` tool
 * when it creates the run.
 *
 * @module
 */
import * as z from "zod";
import {
	/**
	 * required for type inference
	 */
	type AgentMiddleware as _AgentMiddleware,
} from "langchain";
/**
 * Options for creating the completion callback middleware.
 */
export interface CompletionCallbackOptions {
	/**
	 * Callback graph or assistant identifier. Used as the `assistant_id`
	 * argument in `runs.create()`.
	 */
	callbackGraphId: string;
	/**
	 * URL of the callback LangGraph server. Omit to use same-deployment
	 * ASGI transport.
	 */
	url?: string;
	/**
	 * Additional headers to include in requests to the callback server.
	 */
	headers?: Record<string, string>;
}
/**
 * Build headers for the callback LangGraph server.
 *
 * Ensures `x-auth-scheme: langsmith` is present unless explicitly overridden.
 */
export declare function resolveHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string>;
/**
 * Send a notification run to the callback thread.
 *
 * @param callbackGraphId - The callback graph ID used as `assistant_id`
 *   in the `runs.create` call.
 * @param callbackThreadId - The callback thread ID.
 * @param message - The message content to send.
 * @param options - Optional url and headers for the callback server.
 */
export declare function notifyParent(
	callbackGraphId: string,
	callbackThreadId: string,
	message: string,
	options?: {
		url?: string;
		headers?: Record<string, string>;
	},
): Promise<void>;
/**
 * Extract a summary from the subagent's final message.
 *
 * Returns at most 500 characters from the last message's content.
 * Throws if no messages exist or if the last message is not an AIMessage.
 *
 * @param state - The agent state dict.
 * @param taskId - Optional task ID to include in truncation hint.
 */
export declare function extractLastMessage(state: Record<string, unknown>, taskId?: string): string;
/**
 * Create a completion callback middleware for async subagents.
 *
 * **Experimental** — this middleware is experimental and may change.
 *
 * This middleware is added to a subagent's middleware stack. On success or
 * model-call error, it sends a notification to the configured callback
 * thread by calling `runs.create()`.
 *
 * The callback destination is configured with `callbackGraphId` and
 * optional `url` and `headers`. The target thread is read from
 * `callbackThreadId` in the subagent state.
 *
 * If `callbackThreadId` is not present in state, the middleware does
 * nothing.
 *
 * @param options - Configuration options.
 * @returns An `AgentMiddleware` instance.
 *
 * @example
 * ```typescript
 * import { createCompletionCallbackMiddleware } from "@moshu/deepagents";
 *
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 * });
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [notifier],
 * });
 * ```
 */
export declare function createCompletionCallbackMiddleware(
	options: CompletionCallbackOptions,
): _AgentMiddleware<
	z.ZodObject<
		{
			callbackThreadId: z.ZodOptional<z.ZodString>;
		},
		z.core.$strip
	>,
	undefined,
	unknown,
	readonly (
		| import("@langchain/core/tools").ClientTool
		| import("@langchain/core/tools").ServerTool
	)[],
	readonly []
>;
