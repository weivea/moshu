/**
 * Register the built-in Codex harness profiles.
 *
 * Registers the same profile under each Codex model spec. Per-model
 * keys (not the bare `"openai"` prefix) keep the default behavior of
 * non-Codex OpenAI models unchanged.
 *
 * @internal
 */
export declare function register(): void;
