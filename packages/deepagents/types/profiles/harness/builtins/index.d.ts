/**
 * Register all built-in harness profiles and snapshot the resulting
 * registry keys as the builtin baseline.
 *
 * Called once during lazy bootstrap by `ensureBuiltinsLoaded()`.
 * Uses `registerHarnessProfileImpl` internally (not the public
 * `registerHarnessProfile`) to avoid triggering re-entrant bootstrap.
 *
 * @internal
 */
export declare function loadBuiltinProfiles(): void;
