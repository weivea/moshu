/**
 * Middleware for loading agent memory/context from AGENTS.md files.
 *
 * This module implements support for the AGENTS.md specification (https://agents.md/),
 * loading memory/context from configurable sources and injecting into the system prompt.
 *
 * ## Overview
 *
 * AGENTS.md files provide project-specific context and instructions to help AI agents
 * work effectively. Unlike skills (which are on-demand workflows), memory is always
 * loaded and provides persistent context.
 *
 * ## Usage
 *
 * ```typescript
 * import { createMemoryMiddleware } from "@anthropic/deepagents";
 * import { FilesystemBackend } from "@anthropic/deepagents";
 *
 * // Security: FilesystemBackend allows reading/writing from the entire filesystem.
 * // Either ensure the agent is running within a sandbox OR add human-in-the-loop (HIL)
 * // approval to file operations.
 * const backend = new FilesystemBackend({ rootDir: "/" });
 *
 * const middleware = createMemoryMiddleware({
 *   backend,
 *   sources: [
 *     "~/.deepagents/AGENTS.md",
 *     "./.deepagents/AGENTS.md",
 *   ],
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * ## Memory Sources
 *
 * Sources are simply paths to AGENTS.md files that are loaded in order and combined.
 * Multiple sources are concatenated in order, with all content included.
 * Later sources appear after earlier ones in the combined prompt.
 *
 * ## File Format
 *
 * AGENTS.md files are standard Markdown with no required structure.
 * Common sections include:
 * - Project overview
 * - Build/test commands
 * - Code style guidelines
 * - Architecture notes
 */
import { z } from "zod";
import {
	/**
	 * required for type inference
	 */
	type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import type { AnyBackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { StateSchema } from "@langchain/langgraph";
/**
 * Import @langchain/langgraph for type inference
 */
import type * as _langgraph from "@langchain/langgraph";
/**
 * Options for the memory middleware.
 */
export interface MemoryMiddlewareOptions {
	/**
	 * Backend instance or factory function for file operations.
	 * Use a factory for StateBackend since it requires runtime state.
	 */
	backend:
		| AnyBackendProtocol
		| BackendFactory
		| ((config: { state: unknown; store?: BaseStore }) => StateBackend);
	/**
	 * List of memory file paths to load (e.g., ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"]).
	 * Display names are automatically derived from the paths.
	 * Sources are loaded in order.
	 */
	sources: string[];
	/**
	 * Whether to add cache_control breakpoints to the memory content block.
	 * When true, the memory block is tagged with `cache_control: { type: "ephemeral" }`
	 * to enable prompt caching for providers that support it (e.g., Anthropic).
	 * @default false
	 */
	addCacheControl?: boolean;
}
/**
 * Create middleware for loading agent memory from AGENTS.md files.
 *
 * Loads memory content from configured sources and injects into the system prompt.
 * Supports multiple sources that are combined together.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for memory loading and injection
 *
 * @example
 * ```typescript
 * const middleware = createMemoryMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     "~/.deepagents/AGENTS.md",
 *     "./.deepagents/AGENTS.md",
 *   ],
 * });
 * ```
 */
export declare function createMemoryMiddleware(options: MemoryMiddlewareOptions): _AgentMiddleware<
	StateSchema<{
		/**
		 * Dict mapping source paths to their loaded content.
		 * Marked as private so it's not included in the final agent state.
		 */
		memoryContents: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
		files: _langgraph.ReducedValue<
			import("./fs.js").FilesRecord | undefined,
			import("./fs.js").FilesRecordUpdate | undefined
		>;
	}>,
	undefined,
	unknown,
	readonly (
		| import("@langchain/core/tools").ClientTool
		| import("@langchain/core/tools").ServerTool
	)[],
	readonly []
>;
