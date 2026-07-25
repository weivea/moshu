import {
	/**
	 * required for type inference
	 */
	type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { type BaseMessage } from "@langchain/core/messages";
/**
 * Patch tool call / tool response parity in a messages array.
 *
 * Ensures strict 1:1 correspondence between AIMessage tool_calls and
 * ToolMessage responses:
 *
 * 1. **Dangling tool_calls** — an AIMessage contains a tool_call with no
 *    matching ToolMessage anywhere after it. A synthetic cancellation
 *    ToolMessage is inserted immediately after the AIMessage.
 *
 * 2. **Orphaned ToolMessages** — a ToolMessage whose `tool_call_id` does not
 *    match any tool_call in a preceding AIMessage. The ToolMessage is removed.
 *
 * Both directions are required for providers that enforce strict parity
 * (e.g. Google Gemini returns 400 INVALID_ARGUMENT otherwise).
 *
 * @param messages - The messages array to patch
 * @returns Object with patched messages and needsPatch flag
 */
export declare function patchDanglingToolCalls(messages: BaseMessage[]): {
	patchedMessages: BaseMessage[];
	needsPatch: boolean;
};
/**
 * Create middleware that enforces strict tool call / tool response parity in
 * the messages history.
 *
 * Two kinds of violations are repaired:
 * 1. **Dangling tool_calls** — an AIMessage contains tool_calls with no
 *    matching ToolMessage responses. Synthetic cancellation ToolMessages are
 *    injected so every tool_call has a response.
 * 2. **Orphaned ToolMessages** — a ToolMessage exists whose `tool_call_id`
 *    does not match any tool_call in a preceding AIMessage. These are removed.
 *
 * This is critical for providers like Google Gemini that reject requests with
 * mismatched function call / function response counts (400 INVALID_ARGUMENT).
 *
 * This middleware patches in two places:
 * 1. `beforeAgent`: Patches state at the start of the agent loop (handles most cases)
 * 2. `wrapModelCall`: Patches the request right before model invocation (handles
 *    edge cases like HITL rejection during graph resume where state updates from
 *    beforeAgent may not be applied in time)
 *
 * @returns AgentMiddleware that enforces tool call / response parity
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createPatchToolCallsMiddleware } from "./middleware/patch_tool_calls";
 *
 * const agent = createAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [createPatchToolCallsMiddleware()],
 * });
 * ```
 */
export declare function createPatchToolCallsMiddleware(): _AgentMiddleware<
	undefined,
	undefined,
	unknown,
	readonly (
		| import("@langchain/core/tools").ClientTool
		| import("@langchain/core/tools").ServerTool
	)[],
	readonly []
>;
