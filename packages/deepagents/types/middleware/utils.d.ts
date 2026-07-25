/**
 * Utility functions for middleware.
 *
 * This module provides shared helpers used across middleware implementations.
 */
import { SystemMessage } from "@langchain/core/messages";
import type { AgentMiddleware } from "langchain";
/**
 * Merge custom middleware into an assembled stack by `.name`.
 *
 * Matching custom middleware replaces the existing entry in place. New
 * middleware is appended after the base stack in caller-provided order.
 */
export declare function mergeMiddleware(
	base: readonly AgentMiddleware[],
	custom: readonly AgentMiddleware[],
): AgentMiddleware[];
/**
 * Merge custom middleware into default and tail middleware segments.
 *
 * Same-name custom entries replace matching defaults in either segment. Novel
 * custom entries are inserted between the default and tail segments unless
 * `appendNew` is false.
 */
export declare function mergeMiddlewareStack(
	defaultMiddleware: readonly AgentMiddleware[],
	customMiddleware: readonly AgentMiddleware[],
	tailMiddleware?: readonly AgentMiddleware[],
	options?: {
		appendNew?: boolean;
	},
): AgentMiddleware[];
/**
 * Append text to a system message.
 *
 * Creates a new SystemMessage with the text appended to the existing content.
 * If the original message has content, the new text is separated by two newlines.
 *
 * @param systemMessage - Existing system message or null/undefined.
 * @param text - Text to add to the system message.
 * @returns New SystemMessage with the text appended.
 *
 * @example
 * ```typescript
 * const original = new SystemMessage({ content: "You are a helpful assistant." });
 * const updated = appendToSystemMessage(original, "Always be concise.");
 * // Result: SystemMessage with content "You are a helpful assistant.\n\nAlways be concise."
 * ```
 */
export declare function appendToSystemMessage(
	systemMessage: SystemMessage | null | undefined,
	text: string,
): SystemMessage;
/**
 * Prepend text to a system message.
 *
 * Creates a new SystemMessage with the text prepended to the existing content.
 * If the original message has content, the new text is separated by two newlines.
 *
 * @param systemMessage - Existing system message or null/undefined.
 * @param text - Text to prepend to the system message.
 * @returns New SystemMessage with the text prepended.
 *
 * @example
 * ```typescript
 * const original = new SystemMessage({ content: "Always be concise." });
 * const updated = prependToSystemMessage(original, "You are a helpful assistant.");
 * // Result: SystemMessage with content "You are a helpful assistant.\n\nAlways be concise."
 * ```
 */
export declare function prependToSystemMessage(
	systemMessage: SystemMessage | null | undefined,
	text: string,
): SystemMessage;
