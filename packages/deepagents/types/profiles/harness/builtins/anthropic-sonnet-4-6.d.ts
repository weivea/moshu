/**
 * Register the built-in Claude Sonnet 4.6 harness profile.
 *
 * Layers universal Claude guidance (parallel tool calls, grounded
 * answers, post-tool reflection) onto `anthropic:claude-sonnet-4-6`.
 *
 * No Sonnet-specific overlays — Anthropic's guidance for Sonnet 4.6
 * centers on API-level configuration rather than system-prompt
 * adjustments. This module exists as the audit anchor: its presence
 * documents the review and justifies the absence of model-specific
 * content.
 *
 * @internal
 */
export declare function register(): void;
