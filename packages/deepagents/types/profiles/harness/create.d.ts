import type { HarnessProfile, HarnessProfileOptions } from "./types.js";
/**
 * Create a frozen {@link HarnessProfile} from user-provided options.
 *
 * Validates all fields, converts mutable collections to their
 * frozen counterparts, and returns a frozen object.
 * Empty options produce a no-op profile (all defaults).
 *
 * @param options - Partial profile configuration.
 * @returns A frozen, validated `HarnessProfile`.
 * @throws {Error} When any field violates validation rules (invalid
 *   middleware names, scaffolding exclusion attempts).
 *
 * @example
 * ```typescript
 * const profile = createHarnessProfile({
 *   systemPromptSuffix: "Think step by step.",
 *   excludedTools: ["execute"],
 * });
 * ```
 */
export declare function createHarnessProfile(options?: HarnessProfileOptions): HarnessProfile;
/**
 * An empty no-op profile used as the default when no registered
 * profile matches. Avoids creating a new object on every miss.
 */
export declare const EMPTY_HARNESS_PROFILE: HarnessProfile;
