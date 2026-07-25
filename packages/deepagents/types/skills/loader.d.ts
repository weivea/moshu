/**
 * Skill loader for parsing and loading agent skills from SKILL.md files.
 *
 * This module implements Anthropic's agent skills pattern with YAML frontmatter parsing.
 * Each skill is a directory containing a SKILL.md file with:
 * - YAML frontmatter (name, description required)
 * - Markdown instructions for the agent
 * - Optional supporting files (scripts, configs, etc.)
 *
 * @example
 * ```markdown
 * ---
 * name: web-research
 * description: Structured approach to conducting thorough web research
 * ---
 *
 * # Web Research Skill
 *
 * ## When to Use
 * - User asks you to research a topic
 * ...
 * ```
 *
 * @see https://agentskills.io/specification
 */
/** Maximum size for SKILL.md files (10MB) */
export declare const MAX_SKILL_FILE_SIZE: number;
/** Agent Skills spec constraints */
export declare const MAX_SKILL_NAME_LENGTH = 64;
export declare const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/**
 * Metadata for a skill per Agent Skills spec.
 * @see https://agentskills.io/specification
 */
export interface SkillMetadata {
	/** Name of the skill (max 64 chars, lowercase alphanumeric and hyphens) */
	name: string;
	/** Description of what the skill does (max 1024 chars) */
	description: string;
	/** Absolute path to the SKILL.md file */
	path: string;
	/** Source of the skill ('user' or 'project') */
	source: "user" | "project";
	/** Optional: License name or reference to bundled license file */
	license?: string;
	/** Optional: Environment requirements (max 500 chars) */
	compatibility?: string;
	/** Optional: Arbitrary key-value mapping for additional metadata */
	metadata?: Record<string, string>;
	/** Optional: Space-delimited list of pre-approved tools */
	allowedTools?: string;
}
/**
 * Options for listing skills.
 */
export interface ListSkillsOptions {
	/** Path to user-level skills directory */
	userSkillsDir?: string | null;
	/** Path to project-level skills directory */
	projectSkillsDir?: string | null;
}
/**
 * Parse YAML frontmatter from a SKILL.md file per Agent Skills spec.
 *
 * @param skillMdPath - Path to the SKILL.md file
 * @param source - Source of the skill ('user' or 'project')
 * @returns SkillMetadata with all fields, or null if parsing fails
 */
export declare function parseSkillMetadata(
	skillMdPath: string,
	source: "user" | "project",
): SkillMetadata | null;
/**
 * List skills from user and/or project directories.
 *
 * When both directories are provided, project skills with the same name as
 * user skills will override them.
 *
 * @param options - Options specifying which directories to search
 * @returns Merged list of skill metadata from both sources, with project skills
 *          taking precedence over user skills when names conflict
 */
export declare function listSkills(options: ListSkillsOptions): SkillMetadata[];
