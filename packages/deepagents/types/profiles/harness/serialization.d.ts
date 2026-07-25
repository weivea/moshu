import { z } from "zod/v4";
import type { HarnessProfile } from "./types.js";
/**
 * Zod schema for the general-purpose subagent config section of an
 * external harness profile config file.
 */
export declare const generalPurposeSubagentConfigSchema: z.ZodObject<
	{
		enabled: z.ZodOptional<z.ZodBoolean>;
		description: z.ZodOptional<z.ZodString>;
		systemPrompt: z.ZodOptional<z.ZodString>;
	},
	z.core.$strict
>;
/**
 * Zod schema for parsing a harness profile from an external JSON or
 * YAML config file.
 *
 * Uses `.strict()` to reject unknown keys (catches typos early). Array
 * fields (`excludedTools`, `excludedMiddleware`) accept arrays of
 * strings; the result is passed to {@link createHarnessProfile} which
 * converts them to `Set`.
 *
 * Does not include `extraMiddleware` — middleware instances cannot be
 * represented in JSON/YAML.
 *
 * @example
 * ```typescript
 * import { readFileSync } from "fs";
 * import YAML from "yaml";
 *
 * const raw = YAML.parse(readFileSync("profile.yaml", "utf-8"));
 * const config = harnessProfileConfigSchema.parse(raw);
 * const profile = createHarnessProfile(config);
 * ```
 */
export declare const harnessProfileConfigSchema: z.ZodObject<
	{
		baseSystemPrompt: z.ZodOptional<z.ZodString>;
		systemPromptSuffix: z.ZodOptional<z.ZodString>;
		toolDescriptionOverrides: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
		excludedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
		excludedMiddleware: z.ZodOptional<z.ZodArray<z.ZodString>>;
		generalPurposeSubagent: z.ZodOptional<
			z.ZodObject<
				{
					enabled: z.ZodOptional<z.ZodBoolean>;
					description: z.ZodOptional<z.ZodString>;
					systemPrompt: z.ZodOptional<z.ZodString>;
				},
				z.core.$strict
			>
		>;
	},
	z.core.$strict
>;
/**
 * TypeScript type inferred from the Zod config schema.
 *
 * Represents the JSON/YAML-compatible shape of a harness profile. This
 * is the type of data that comes out of `harnessProfileConfigSchema.parse()`.
 */
export type HarnessProfileConfigData = z.infer<typeof harnessProfileConfigSchema>;
/**
 * Parse an untrusted JSON/YAML object into a validated
 * {@link HarnessProfile}.
 *
 * Combines Zod schema validation with prototype-pollution protection
 * and profile construction validation. Use this for any config data
 * that originates from files, network, or user input.
 *
 * @param data - Raw object from `JSON.parse()` or `YAML.parse()`.
 * @returns A frozen, validated `HarnessProfile`.
 * @throws {z.ZodError} When the data fails schema validation.
 * @throws {Error} When profile-level validation fails (e.g.,
 *   scaffolding violation in `excludedMiddleware`).
 */
export declare function parseHarnessProfileConfig(data: unknown): HarnessProfile;
/**
 * Serialize a {@link HarnessProfile} to a JSON-compatible object.
 *
 * Omits `undefined` fields and `extraMiddleware` (runtime-only).
 * Throws if `extraMiddleware` contains instances — callers should
 * strip it before serializing if they've set it.
 *
 * @param profile - The profile to serialize.
 * @returns A plain object matching {@link HarnessProfileConfigData}.
 * @throws {Error} When `extraMiddleware` is non-empty (cannot be
 *   serialized to JSON).
 */
export declare function serializeProfile(profile: HarnessProfile): HarnessProfileConfigData;
