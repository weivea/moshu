import type { HarnessProfile, HarnessProfileOptions } from "./types.js";
/**
 * Options for resolving a harness profile from model metadata.
 */
export interface ResolveHarnessProfileOpts {
	/**
	 * Model spec string (e.g., `"anthropic:claude-opus-4-7"`).
	 */
	spec?: string;
	/**
	 * Provider name extracted from a model instance (e.g., `"anthropic"`).
	 */
	providerHint?: string;
	/**
	 * Model identifier extracted from a model instance (e.g., `"claude-opus-4-7"`).
	 */
	identifierHint?: string;
}
/**
 * Ensure lazy-loaded builtin profiles have been registered.
 *
 * Called by the public `registerHarnessProfile` and lookup functions.
 * Built-in registration modules call `registerHarnessProfileImpl`
 * directly to avoid re-entrant bootstrap.
 *
 * @internal
 */
export declare function ensureBuiltinsLoaded(): void;
/**
 * Snapshot the current registry keys as the builtin baseline.
 *
 * Called by the builtin loader after all built-in profiles are
 * registered. This allows {@link hasUserRegisteredProfiles} to
 * distinguish user registrations from built-ins.
 *
 * @internal
 */
export declare function snapshotBuiltinKeys(): void;
/**
 * Core registration implementation. Does not trigger lazy bootstrap.
 *
 * Used by built-in profile modules during bootstrap. External callers
 * should use {@link registerHarnessProfile} instead.
 *
 * @internal
 */
export declare function registerHarnessProfileImpl(key: string, profile: HarnessProfile): void;
/**
 * Register a harness profile for a provider or specific model.
 *
 * Accepts either a pre-built {@link HarnessProfile} (from
 * {@link createHarnessProfile}) or raw {@link HarnessProfileOptions}
 * that will be validated and frozen automatically.
 *
 * Registrations are **additive**: if a profile already exists under
 * `key`, the new profile is merged on top. The incoming profile's
 * fields win on scalar conflicts; set fields union; middleware
 * sequences merge by name.
 *
 * @param key - Either a bare provider (`"openai"`) for provider-wide
 *   defaults, or `"provider:model"` for a per-model override.
 * @param profile - A `HarnessProfile` or options to build one from.
 * @throws {Error} When `key` is malformed or profile validation
 *   fails.
 *
 * @example
 * ```typescript
 * import { registerHarnessProfile } from "@langchain/deepagents";
 *
 * registerHarnessProfile("openai", {
 *   systemPromptSuffix: "Respond concisely.",
 * });
 *
 * registerHarnessProfile("openai:gpt-5.4", {
 *   excludedTools: ["execute"],
 * });
 * ```
 */
export declare function registerHarnessProfile(
	key: string,
	profile: HarnessProfile | HarnessProfileOptions,
): void;
/**
 * Look up the {@link HarnessProfile} for a model spec string.
 *
 * Resolution order:
 *
 * 1. **Exact match** on `spec` (e.g., `"openai:gpt-5.4"`).
 * 2. **Provider prefix** (everything before `:`) when `spec` contains
 *    a colon and both halves are non-empty.
 * 3. When both exist, they are **merged** (provider as base, exact as
 *    override).
 * 4. `undefined` when nothing matches.
 *
 * Malformed specs (empty, multiple colons, empty halves) return
 * `undefined` without consulting the registry.
 *
 * @param spec - Model spec in `"provider:model"` format, or a bare
 *   provider/model identifier.
 * @returns The matching profile, or `undefined`.
 */
export declare function getHarnessProfile(spec: string): HarnessProfile | undefined;
/**
 * Resolve the harness profile for a model, falling back to the
 * empty default when nothing matches.
 *
 * When `spec` is set (the original model parameter), it drives the
 * lookup directly. When absent (pre-built model instance),
 * `providerHint` and `identifierHint` are used to construct lookup
 * keys.
 *
 * @param opts - Model metadata used to resolve the profile.
 * @returns The resolved profile (never `undefined`).
 *
 * @internal
 */
export declare function resolveHarnessProfile(opts?: ResolveHarnessProfileOpts): HarnessProfile;
/**
 * Returns `true` when at least one profile was registered by user
 * code (as opposed to built-in bootstrap).
 *
 * Used to calibrate log verbosity — a "no match" miss is
 * unsurprising when only built-ins are loaded.
 *
 * @internal
 */
export declare function hasUserRegisteredProfiles(): boolean;
/**
 * Apply a profile's prompt overlay to a base prompt string.
 *
 * - `baseSystemPrompt` (when set) replaces `basePrompt` entirely.
 * - `systemPromptSuffix` (when set) is appended with `\n\n`.
 *
 * Both are independently optional. A profile that sets only the suffix
 * layers it on top of whatever base the caller passes in.
 *
 * Used uniformly for the main agent, declarative subagents, and the
 * auto-added general-purpose subagent.
 *
 * @param profile - The harness profile to apply.
 * @param basePrompt - The active base prompt (empty by default).
 * @returns The assembled prompt string.
 */
export declare function applyProfilePrompt(profile: HarnessProfile, basePrompt: string): string;
/**
 * Reset the registry to its empty state. For testing only.
 *
 * @internal
 */
export declare function _resetRegistryForTesting(): void;
