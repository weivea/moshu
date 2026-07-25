/**
 * Register the built-in Claude Opus 4.7 harness profile.
 *
 * Layers a system-prompt suffix onto `anthropic:claude-opus-4-7`
 * tuned to the model's documented behaviors: parallel tool calls,
 * grounded answers, post-tool reflection, active investigation, and
 * subagent spawning guidance.
 *
 * @internal
 */
export declare function register(): void;
