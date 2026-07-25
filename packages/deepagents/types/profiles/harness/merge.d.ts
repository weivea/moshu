import type { HarnessProfile } from "./types.js";
/**
 * Merge two harness profiles, layering `override` on top of `base`.
 *
 * Merge semantics per field:
 *
 * | Field | Strategy |
 * |-------|----------|
 * | `baseSystemPrompt` | Override wins if not `undefined` |
 * | `systemPromptSuffix` | Override wins if not `undefined` |
 * | `toolDescriptionOverrides` | Object spread merge; override wins per key |
 * | `excludedTools` | Set union |
 * | `excludedMiddleware` | Set union |
 * | `extraMiddleware` | Merge by `.name`; override instance replaces base at same position; novel names appended |
 * | `generalPurposeSubagent` | Field-wise merge; override wins per sub-field |
 *
 * @param base - Lower-priority profile (e.g., provider-wide).
 * @param override - Higher-priority profile (e.g., exact model).
 * @returns A new merged profile.
 */
export declare function mergeProfiles(
	base: HarnessProfile,
	override: HarnessProfile,
): HarnessProfile;
