/**
 * Middleware for loading agent-specific long-term memory into the system prompt.
 *
 * This middleware loads the agent's long-term memory from agent.md files
 * and injects it into the system prompt. Memory is loaded from:
 * - User memory: ~/.deepagents/{agent_name}/agent.md
 * - Project memory: {project_root}/.deepagents/agent.md
 *
 * @deprecated Use `createMemoryMiddleware` from `./memory.js` instead.
 * This middleware uses direct filesystem access (Node.js fs module) which is not
 * portable across backends. The `createMemoryMiddleware` function uses the
 * `BackendProtocol` abstraction and follows the AGENTS.md specification.
 *
 * Migration example:
 * ```typescript
 * // Before (deprecated):
 * import { createAgentMemoryMiddleware } from "./agent-memory.js";
 * const middleware = createAgentMemoryMiddleware({ settings, assistantId });
 *
 * // After (recommended):
 * import { createMemoryMiddleware } from "./memory.js";
 * import { FilesystemBackend } from "../backends/filesystem.js";
 *
 * const middleware = createMemoryMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     `~/.deepagents/${assistantId}/AGENTS.md`,
 *     `${projectRoot}/.deepagents/AGENTS.md`,
 *   ],
 * });
 * ```
 */
import {
	/**
	 * required for type inference
	 */
	type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import type { Settings } from "../config.js";
/**
 * Options for the agent memory middleware.
 */
export interface AgentMemoryMiddlewareOptions {
	/** Settings instance with project detection and paths */
	settings: Settings;
	/** The agent identifier */
	assistantId: string;
	/** Optional custom template for injecting agent memory into system prompt */
	systemPromptTemplate?: string;
}
/**
 * Create middleware for loading agent-specific long-term memory.
 *
 * This middleware loads the agent's long-term memory from a file (agent.md)
 * and injects it into the system prompt. The memory is loaded once at the
 * start of the conversation and stored in state.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for memory loading and injection
 *
 * @deprecated Use `createMemoryMiddleware` from `./memory.js` instead.
 * This function uses direct filesystem access which limits portability.
 */
export declare function createAgentMemoryMiddleware(
	options: AgentMemoryMiddlewareOptions,
): _AgentMiddleware<
	any,
	undefined,
	unknown,
	readonly (
		| import("@langchain/core/tools").ClientTool
		| import("@langchain/core/tools").ServerTool
	)[],
	readonly []
>;
