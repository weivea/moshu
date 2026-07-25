/**
 * Middleware for providing filesystem tools to an agent.
 *
 * Provides ls, read_file, write_file, edit_file, glob, and grep tools with support for:
 * - Pluggable backends (StateBackend, StoreBackend, FilesystemBackend, CompositeBackend)
 * - Tool result eviction for large outputs
 */
import { ToolMessage, type AgentMiddleware as _AgentMiddleware } from "langchain";
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { AnyBackendProtocol, BackendFactory, FileData } from "../backends/protocol.js";
/**
 * Import langchain for type inference
 */
import type * as _langchain from "langchain";
/**
 * Tools that should be excluded from the large result eviction logic.
 *
 * This array contains tools that should NOT have their results evicted to the filesystem
 * when they exceed token limits. Tools are excluded for different reasons:
 *
 * 1. Tools with built-in truncation (ls, glob, grep):
 *    These tools truncate their own output when it becomes too large. When these tools
 *    produce truncated output due to many matches, it typically indicates the query
 *    needs refinement rather than full result preservation. In such cases, the truncated
 *    matches are potentially more like noise and the LLM should be prompted to narrow
 *    its search criteria instead.
 *
 * 2. Tools with problematic truncation behavior (read_file):
 *    read_file is tricky to handle as the failure mode here is single long lines
 *    (e.g., imagine a jsonl file with very long payloads on each line). If we try to
 *    truncate the result of read_file, the agent may then attempt to re-read the
 *    truncated file using read_file again, which won't help.
 *
 * 3. Tools that never exceed limits (edit_file, write_file):
 *    These tools return minimal confirmation messages and are never expected to produce
 *    output large enough to exceed token limits, so checking them would be unnecessary.
 */
/**
 * All tool names registered by FilesystemMiddleware.
 * This is the single source of truth — used by createDeepAgent to detect
 * collisions with user-supplied tools at construction time.
 */
export declare const FILESYSTEM_TOOL_NAMES: readonly [
	"ls",
	"read_file",
	"write_file",
	"edit_file",
	"glob",
	"grep",
	"execute",
];
/**
 * Built-in filesystem tool names accepted by
 * {@link createFilesystemMiddleware}'s `tools` allowlist.
 */
export type FsToolName = (typeof FILESYSTEM_TOOL_NAMES)[number];
export declare const TOOLS_EXCLUDED_FROM_EVICTION: (
	| "ls"
	| "glob"
	| "grep"
	| "read_file"
	| "write_file"
	| "edit_file"
)[];
/**
 * Approximate number of characters per token for truncation calculations.
 * Using 4 chars per token as a conservative approximation (actual ratio varies by content)
 * This errs on the high side to avoid premature eviction of content that might fit.
 */
export declare const NUM_CHARS_PER_TOKEN = 4;
/**
 * Default values for read_file tool pagination (in lines).
 */
export declare const DEFAULT_READ_LINE_OFFSET = 0;
export declare const DEFAULT_READ_LINE_LIMIT = 100;
/**
 * Maximum size for binary (non-text) files read via read_file, in bytes.
 * Base64-encoded content is ~33% larger, so 10MB raw ≈ 13.3MB in context.
 * This keeps inline multimodal payloads within all major provider limits.
 */
export declare const MAX_BINARY_READ_SIZE_BYTES: number;
/**
 * Create a preview of content showing head and tail with truncation marker.
 *
 * @param contentStr - The full content string to preview.
 * @param headLines - Number of lines to show from the start (default: 5).
 * @param tailLines - Number of lines to show from the end (default: 5).
 * @returns Formatted preview string with line numbers.
 */
export declare function createContentPreview(
	contentStr: string,
	headLines?: number,
	tailLines?: number,
): string;
import type * as _messages from "@langchain/core/messages";
import type { FilesystemPermission } from "../permissions/types.js";
/**
 * Zod schema for legacy FileDataV1 (content as line array).
 */
export declare const FileDataV1Schema: z.ZodObject<
	{
		content: z.ZodArray<z.ZodString>;
		created_at: z.ZodString;
		modified_at: z.ZodString;
	},
	z.core.$strip
>;
/**
 * Zod schema for FileDataV2 (content as string for text or Uint8Array for binary).
 */
export declare const FileDataV2Schema: z.ZodObject<
	{
		content: z.ZodUnion<
			readonly [z.ZodString, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>]
		>;
		mimeType: z.ZodString;
		created_at: z.ZodString;
		modified_at: z.ZodString;
	},
	z.core.$strip
>;
/**
 * Zod v3 schema for FileData (re-export from backends)
 */
export declare const FileDataSchema: z.ZodUnion<
	readonly [
		z.ZodObject<
			{
				content: z.ZodArray<z.ZodString>;
				created_at: z.ZodString;
				modified_at: z.ZodString;
			},
			z.core.$strip
		>,
		z.ZodObject<
			{
				content: z.ZodUnion<
					readonly [z.ZodString, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>]
				>;
				mimeType: z.ZodString;
				created_at: z.ZodString;
				modified_at: z.ZodString;
			},
			z.core.$strip
		>,
	]
>;
/**
 * Type for the files state record.
 */
export type FilesRecord = Record<string, FileData>;
/**
 * Type for file updates, where null indicates deletion.
 */
export type FilesRecordUpdate = Record<string, FileData | null>;
/**
 * Reducer for files state that merges file updates with support for deletions.
 * When a file value is null, the file is deleted from state.
 * When a file value is non-null, it is added or updated in state.
 *
 * This reducer enables concurrent updates from parallel subagents by properly
 * merging their file changes instead of requiring LastValue semantics.
 *
 * @param current - The current files record (from state)
 * @param update - The new files record (from a subagent update), with null values for deletions
 * @returns Merged files record with deletions applied
 */
export declare function fileDataReducer(
	current: FilesRecord | undefined,
	update: FilesRecordUpdate | undefined,
): FilesRecord;
export declare const LS_TOOL_DESCRIPTION: string;
export declare const READ_FILE_TOOL_DESCRIPTION: string;
export declare const WRITE_FILE_TOOL_DESCRIPTION: string;
export declare const EDIT_FILE_TOOL_DESCRIPTION: string;
export declare const GLOB_TOOL_DESCRIPTION: string;
/**
 * Options for creating filesystem middleware.
 */
export interface FilesystemMiddlewareOptions {
	/** Backend instance or factory (default: StateBackend) */
	backend?: AnyBackendProtocol | BackendFactory;
	/** Optional filesystem-specific usage guidance. Omitted by default because tool schemas provide it. */
	systemPrompt?: string | null;
	/**
	 * Optional descriptions for built-in filesystem tools.
	 *
	 * Keys correspond to {@link FsToolName}. Descriptions for tools that are not
	 * enabled by the `tools` allowlist are ignored because those tools are not
	 * exposed to the model.
	 */
	customToolDescriptions?: Partial<Record<FsToolName, string>> | null;
	/**
	 * Allowlist of built-in filesystem tools to expose to the model.
	 *
	 * - `undefined`, `null`, and `"all"` preserve the default behavior: every
	 *   filesystem tool is registered, subject to backend capability filtering.
	 * - Passing an array restricts the middleware to only those tool names.
	 * - `read_file` must be included in every explicit array because it is used
	 *   by normal file-inspection flows and by large-result recovery guidance.
	 * - Backend capability checks still narrow the final visible tool set. For
	 *   example, `execute` is removed when the resolved backend does not support
	 *   command execution, even if it appears in this allowlist.
	 * - User-provided non-filesystem tools are not affected by this allowlist.
	 *
	 *
	 * @example Read/search-only filesystem access
	 * ```ts
	 * createFilesystemMiddleware({
	 *   tools: ["read_file", "ls", "glob", "grep"],
	 * });
	 * ```
	 */
	tools?: readonly FsToolName[] | "all" | null;
	/** Optional token limit before evicting a tool result to the filesystem (default: 20000 tokens, ~80KB) */
	toolTokenLimitBeforeEvict?: number | null;
	/** Optional token limit before evicting a HumanMessage to the filesystem (default: 50000 tokens, ~200KB) */
	humanMessageTokenLimitBeforeEvict?: number | null;
	/**
	 * Filesystem permission rules enforced on every tool call.
	 *
	 * Rules are evaluated in declaration order; first match wins; permissive
	 * default. Applies to `ls`, `read_file`, `write_file`, `edit_file`,
	 * `glob`, and `grep`.
	 *
	 * **Note on `execute`**: permissions are not enforced on `execute` because
	 * shell commands can access any path regardless of path-based rules. Using
	 * permissions with an execution-capable backend (one where `isSandboxBackend`
	 * returns `true`) throws a `ConfigurationError` unless either:
	 *
	 * - `execute` is disabled via `tools`, or
	 * - the backend is a `CompositeBackend` and every permission path is scoped to
	 *   a route prefix.
	 *
	 * When omitted or empty, all filesystem operations are permitted.
	 */
	permissions?: FilesystemPermission[];
}
/**
 * Create middleware that provides built-in filesystem tools and optional custom
 * prompt guidance.
 *
 * By default, the middleware registers every built-in filesystem tool listed in
 * {@link FILESYSTEM_TOOL_NAMES}. Use {@link FilesystemMiddlewareOptions.tools}
 * to narrow that set for read-only, search-only, or otherwise restricted
 * agents. The allowlist only controls built-in filesystem tools; custom tools
 * from the agent or other middleware are left untouched.
 *
 * The middleware also filters tools whose backend capabilities are unavailable
 * at request time. In particular, `execute` is only visible when the resolved
 * backend supports command execution.
 *
 * @param options Filesystem middleware configuration.
 * @returns Agent middleware that contributes filesystem state, tools, prompt
 * guidance, permission checks, and large-result eviction.
 *
 * @example Read-only filesystem middleware
 * ```ts
 * const middleware = createFilesystemMiddleware({
 *   tools: ["read_file", "ls", "glob", "grep"],
 * });
 * ```
 */
export declare function createFilesystemMiddleware(
	options?: FilesystemMiddlewareOptions,
): _AgentMiddleware<
	StateSchema<{
		files: ReducedValue<FilesRecord | undefined, FilesRecordUpdate | undefined>;
	}>,
	undefined,
	unknown,
	(
		| _langchain.DynamicStructuredTool<
				z.ZodObject<
					{
						path: z.ZodDefault<z.ZodOptional<z.ZodString>>;
					},
					z.core.$strip
				>,
				{
					path: string;
				},
				{
					path?: string | undefined;
				},
				string | ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
				unknown,
				"ls"
		  >
		| _langchain.DynamicStructuredTool<
				z.ZodPreprocess<
					z.ZodObject<
						{
							file_path: z.ZodString;
							offset: z.ZodDefault<z.ZodOptional<z.ZodCoercedNumber<unknown>>>;
							limit: z.ZodDefault<z.ZodOptional<z.ZodCoercedNumber<unknown>>>;
						},
						z.core.$strip
					>
				>,
				{
					file_path: string;
					offset: number;
					limit: number;
				},
				unknown,
				| ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
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
		| _langchain.DynamicStructuredTool<
				z.ZodPreprocess<
					z.ZodObject<
						{
							file_path: z.ZodString;
							content: z.ZodDefault<z.ZodString>;
						},
						z.core.$strip
					>
				>,
				{
					file_path: string;
					content: string;
				},
				unknown,
				| string
				| ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
				| Command<
						unknown,
						{
							files: Record<string, FileData>;
							messages: ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>[];
						},
						string
				  >,
				unknown,
				"write_file"
		  >
		| _langchain.DynamicStructuredTool<
				z.ZodPreprocess<
					z.ZodObject<
						{
							file_path: z.ZodString;
							old_string: z.ZodString;
							new_string: z.ZodString;
							replace_all: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
						},
						z.core.$strip
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
				| ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>
				| Command<
						unknown,
						{
							files: Record<string, FileData>;
							messages: ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>[];
						},
						string
				  >,
				unknown,
				"edit_file"
		  >
		| _langchain.DynamicStructuredTool<
				z.ZodObject<
					{
						pattern: z.ZodString;
						path: z.ZodOptional<z.ZodString>;
					},
					z.core.$strip
				>,
				{
					pattern: string;
					path?: string | undefined;
				},
				{
					pattern: string;
					path?: string | undefined;
				},
				string | ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
				unknown,
				"glob"
		  >
		| _langchain.DynamicStructuredTool<
				z.ZodObject<
					{
						pattern: z.ZodString;
						path: z.ZodDefault<z.ZodOptional<z.ZodString>>;
						glob: z.ZodDefault<z.ZodNullable<z.ZodOptional<z.ZodString>>>;
					},
					z.core.$strip
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
				string | ToolMessage<_messages.MessageStructure<_messages.MessageToolSet>>,
				unknown,
				"grep"
		  >
		| _langchain.DynamicStructuredTool<
				z.ZodObject<
					{
						command: z.ZodString;
					},
					z.core.$strip
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
>;
