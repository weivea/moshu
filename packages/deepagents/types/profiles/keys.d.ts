/**
 * Normalize and validate a profile registry key.
 *
 * Trims leading/trailing whitespace, then enforces the `"provider"` or
 * `"provider:model"` shape. Rejects empty strings, multiple colons, and
 * empty halves.
 *
 * @param key - The registry key to validate.
 * @returns The trimmed, validated key.
 * @throws {Error} When the key is malformed.
 *
 * @example
 * ```typescript
 * validateProfileKey("anthropic:claude-opus-4-7"); // "anthropic:claude-opus-4-7"
 * validateProfileKey("  openai  ");                 // "openai"
 * validateProfileKey("openai:");                    // throws
 * validateProfileKey("");                            // throws
 * ```
 */
export declare function validateProfileKey(key: string): string;
