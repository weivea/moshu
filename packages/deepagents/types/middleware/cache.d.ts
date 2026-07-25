/**
 * Import langchain for type inference
 */
import type * as _langchain from "langchain";
/**
 * Creates a middleware that places a cache breakpoint at the end of the static
 * system prompt content.
 *
 * This middleware tags the last block of the system message with
 * `cache_control: { type: "ephemeral" }` at the time it runs, capturing all
 * static content injected by preceding middleware (e.g. todo list instructions,
 * filesystem tools, subagent instructions) in a single cache breakpoint.
 *
 * This should run after all static system prompt middleware and before any
 * dynamic middleware (e.g. memory) so the breakpoint sits at the boundary
 * between stable and changing content.
 *
 * When used alongside memory middleware (which adds its own breakpoint on the
 * memory block), the result is two separate cache breakpoints:
 * - One covering all static content
 * - One covering the memory block
 *
 * The `cache_control` marker is Anthropic-specific. The middleware is gated
 * per-call on `request.model` so it is a no-op when `modelFallbackMiddleware`
 * (or any other middleware) has swapped the request to a non-Anthropic
 * provider. Without this gate, the marker leaks to providers that reject it
 * (e.g. OpenAI returns `400 Unknown parameter: 'cache_control'`).
 *
 * This is a no-op when the system message has no content blocks.
 */
export declare function createCacheBreakpointMiddleware(): _langchain.AgentMiddleware<
	undefined,
	undefined,
	unknown,
	readonly (
		| import("@langchain/core/tools").ClientTool
		| import("@langchain/core/tools").ServerTool
	)[],
	readonly []
>;
