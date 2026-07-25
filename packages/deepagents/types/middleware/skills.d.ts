/**
 * Backend-agnostic skills middleware for loading agent skills from any backend.
 *
 * This middleware implements Anthropic's agent skills pattern with progressive disclosure,
 * loading skills from backend storage via configurable sources.
 *
 * ## Architecture
 *
 * Skills are loaded from one or more **sources** - paths in a backend where skills are
 * organized. Sources are loaded in order, with later sources overriding earlier ones
 * when skills have the same name (last one wins). This enables layering: base -> user
 * -> project -> team skills.
 *
 * The middleware uses backend APIs exclusively (no direct filesystem access), making it
 * portable across different storage backends (filesystem, state, remote storage, etc.).
 *
 * ## Usage
 *
 * ```typescript
 * import { createSkillsMiddleware, FilesystemBackend } from "@anthropic/deepagents";
 *
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     "/skills/user/",      // parent dir: every subdir with SKILL.md is loaded
 *     "/skills/project/",   // parent dir: every subdir with SKILL.md is loaded
 *     "/skills/my-skill/",  // direct path: SKILL.md lives at the root of this dir
 *   ],
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * Or use the `skills` parameter on createDeepAgent:
 *
 * ```typescript
 * const agent = createDeepAgent({
 *   skills: ["/skills/user/", "/skills/project/", "/skills/my-skill/"],
 * });
 * ```
 */
import { z } from "zod";
import {
	/**
	 * required for type inference
	 */
	type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { StateSchema, ReducedValue } from "@langchain/langgraph";
import type { AnyBackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
export declare const MAX_SKILL_FILE_SIZE: number;
export declare const DEFAULT_SKILL_READ_LINE_LIMIT = 1000;
export declare const MAX_SKILL_NAME_LENGTH = 64;
export declare const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export declare const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
/**
 * File extensions a skill module entrypoint may use.
 */
export declare const SKILL_MODULE_EXTENSIONS: string[];
/**
 * Metadata for a skill per Agent Skills specification.
 */
export interface SkillMetadata {
	/**
	 * Skill identifier.
	 *
	 * Constraints per Agent Skills specification:
	 *
	 * - 1-64 characters
	 * - Unicode lowercase alphanumeric and hyphens only (`a-z` and `-`).
	 * - Must not start or end with `-`
	 * - Must not contain consecutive `--`
	 * - Must match the parent directory name containing the `SKILL.md` file
	 */
	name: string;
	/**
	 * What the skill does.
	 *
	 * Constraints per Agent Skills specification:
	 *
	 * - 1-1024 characters
	 * - Should describe both what the skill does and when to use it
	 * - Should include specific keywords that help agents identify relevant tasks
	 */
	description: string;
	/** Path to the SKILL.md file in the backend */
	path: string;
	/** License name or reference to bundled license file. */
	license?: string | null;
	/**
	 * Environment requirements.
	 *
	 * Constraints per Agent Skills specification:
	 *
	 * - 1-500 characters if provided
	 * - Should only be included if there are specific compatibility requirements
	 * - Can indicate intended product, required packages, etc.
	 */
	compatibility?: string | null;
	/**
	 * Arbitrary key-value mapping for additional metadata.
	 *
	 * Clients can use this to store additional properties not defined by the spec.
	 *
	 * It is recommended to keep key names unique to avoid conflicts.
	 */
	metadata?: Record<string, string>;
	/**
	 * Tool names the skill recommends using.
	 *
	 * Warning: this is experimental.
	 *
	 * Constraints per Agent Skills specification:
	 *
	 * - Space-delimited list of tool names
	 */
	allowedTools?: string[];
	/**
	 * Path to a JS/TS entrypoint file for a QuickJS REPL module, relative to the skill
	 * directory.
	 */
	module?: string;
}
/**
 * Options for the skills middleware.
 */
export interface SkillsMiddlewareOptions {
	/**
	 * Backend instance or factory function for file operations.
	 * Use a factory for StateBackend since it requires runtime state.
	 */
	backend:
		| AnyBackendProtocol
		| BackendFactory
		| ((config: { state: unknown; store?: BaseStore }) => StateBackend);
	/**
	 * List of skill source paths to load.
	 * Paths must use POSIX conventions (forward slashes).
	 * Later sources override earlier ones for skills with the same name (last one wins).
	 *
	 * Two formats are accepted for each entry:
	 *
	 * - **Parent directory** (e.g. `"/skills/"`, `"/skills/user/"`): the directory
	 *   is scanned and every subdirectory that contains a `SKILL.md` is loaded as
	 *   a separate skill.
	 *
	 * - **Direct skill path** (e.g. `"/skills/my-skill/"`): the path points to a
	 *   single skill directory whose `SKILL.md` lives at its root. Detected
	 *   automatically when the directory listing contains a `SKILL.md` file.
	 *
	 * Both formats can be mixed in the same array:
	 * ```typescript
	 * sources: [
	 *   "/skills/",                         // loads all skills in the directory
	 *   "/skills/my-skill/",                // loads a single skill by path
	 * ]
	 * ```
	 */
	sources: string[];
}
/**
 * Zod schema for a single skill metadata entry.
 */
export declare const SkillMetadataEntrySchema: z.ZodObject<
	{
		name: z.ZodString;
		description: z.ZodString;
		path: z.ZodString;
		license: z.ZodOptional<z.ZodNullable<z.ZodString>>;
		compatibility: z.ZodOptional<z.ZodNullable<z.ZodString>>;
		metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
		allowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
		module: z.ZodOptional<z.ZodString>;
	},
	z.core.$strip
>;
/**
 * Type for a single skill metadata entry.
 */
export type SkillMetadataEntry = z.infer<typeof SkillMetadataEntrySchema>;
/**
 * Reducer for skillsMetadata that merges arrays from parallel subagents.
 * Skills are deduplicated by name, with later values overriding earlier ones.
 *
 * @param current - The current skillsMetadata array (from state)
 * @param update - The new skillsMetadata array (from a subagent update)
 * @returns Merged array with duplicates resolved by name (later values win)
 */
export declare function skillsMetadataReducer(
	current: SkillMetadataEntry[] | undefined,
	update: SkillMetadataEntry[] | undefined,
): SkillMetadataEntry[];
/**
 * Validate skill name per Agent Skills specification.
 *
 * Constraints per Agent Skills specification:
 *
 * - 1-64 characters
 * - Unicode lowercase alphanumeric and hyphens only (`a-z` and `-`).
 * - Must not start or end with `-`
 * - Must not contain consecutive `--`
 * - Must match the parent directory name containing the `SKILL.md` file
 *
 * Unicode lowercase alphanumeric means any lowercase or decimal digit, which
 * covers accented Latin characters (e.g., `'café'`, `'über-tool'`) and other
 * scripts.
 *
 * @param name - The skill name from YAML frontmatter
 * @param directoryName - The parent directory name
 * @returns `{ valid, error }` tuple. Error is empty string if valid.
 */
export declare function validateSkillName(
	name: string,
	directoryName: string,
): {
	valid: boolean;
	error: string;
};
/**
 * Validate and normalize the metadata field from YAML frontmatter.
 *
 * YAML parsing can return any type for the `metadata` key. This ensures the
 * value in {@link SkillMetadata} is always a `Record<string, string>` by
 * coercing via `String()` and rejecting non-object inputs.
 *
 * @param raw - Raw value from `frontmatterData.metadata`.
 * @param skillPath - Path to the `SKILL.md` file (for warning messages).
 * @returns A validated `Record<string, string>`.
 */
export declare function validateMetadata(raw: unknown, skillPath: string): Record<string, string>;
/**
 * Build a parenthetical annotation string from optional skill fields.
 *
 * Combines license and compatibility into a comma-separated string for
 * display in the system prompt skill listing.
 *
 * @param skill - Skill metadata to extract annotations from.
 * @returns Annotation string like `'License: MIT, Compatibility: Python 3.10+'`,
 *   or empty string if neither field is set.
 */
export declare function formatSkillAnnotations(skill: SkillMetadata): string;
/**
 * Parse YAML frontmatter from `SKILL.md` content.
 *
 * Extracts metadata per Agent Skills specification from YAML frontmatter
 * delimited by `---` markers at the start of the content.
 *
 * @param content - Content of the `SKILL.md` file
 * @param skillPath - Path to the `SKILL.md` file (for error messages and metadata)
 * @param directoryName - Name of the parent directory containing the skill
 * @returns `SkillMetadata` if parsing succeeds, `null` if parsing fails or
 *   validation errors occur
 */
export declare function parseSkillMetadataFromContent(
	content: string,
	skillPath: string,
	directoryName: string,
): SkillMetadata | null;
/**
 * Format skills metadata for display in system prompt.
 * Shows allowed tools for each skill if specified.
 */
export declare function formatSkillsList(skills: SkillMetadata[], sources: string[]): string;
/**
 * Validate and normalize the `module` frontmatter key from a `SKILL.md`.
 *
 * Returns the normalized path (e.g. `"index.ts"`, `"lib/entry.js"`) or
 * `undefined` when the key is absent, empty, non-string, absolute, contains
 * path traversal, or uses an unsupported extension. Invalid values silently
 * degrade the skill to prose-only.
 */
export declare function validateModulePath(raw: unknown): string | undefined;
/**
 * Create backend-agnostic middleware for loading and exposing agent skills.
 *
 * This middleware loads skills from configurable backend sources and injects
 * skill metadata into the system prompt. It implements the progressive disclosure
 * pattern: skill names and descriptions are shown in the prompt, but the agent
 * reads full SKILL.md content only when needed.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for skills loading and injection
 *
 * @example
 * ```typescript
 * const middleware = createSkillsMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: ["/skills/user/", "/skills/project/"],
 * });
 * ```
 */
export declare function createSkillsMiddleware(options: SkillsMiddlewareOptions): _AgentMiddleware<
	StateSchema<{
		skillsMetadata: ReducedValue<
			| {
					name: string;
					description: string;
					path: string;
					license?: string | null | undefined;
					compatibility?: string | null | undefined;
					metadata?: Record<string, string> | undefined;
					allowedTools?: string[] | undefined;
					module?: string | undefined;
			  }[]
			| undefined,
			| {
					name: string;
					description: string;
					path: string;
					license?: string | null | undefined;
					compatibility?: string | null | undefined;
					metadata?: Record<string, string> | undefined;
					allowedTools?: string[] | undefined;
					module?: string | undefined;
			  }[]
			| undefined
		>;
		files: ReducedValue<
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
