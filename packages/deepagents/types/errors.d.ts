/**
 * Error codes for {@link ConfigurationError}.
 *
 * Each code represents a distinct misconfiguration that can be detected at
 * agent-construction time. Add new codes here as new validations are added.
 */
export type ConfigurationErrorCode = "TOOL_NAME_COLLISION";
declare const CONFIGURATION_ERROR_SYMBOL: unique symbol;
/**
 * Thrown when `createDeepAgent` receives invalid configuration.
 *
 * Follows the same pattern as {@link SandboxError}: a human-readable
 * `message`, a structured `code` for programmatic handling, and a
 * static `isInstance` guard that works across realms.
 *
 * @example
 * ```typescript
 * try {
 *   createDeepAgent({ tools: [myTool] });
 * } catch (error) {
 *   if (ConfigurationError.isInstance(error)) {
 *     switch (error.code) {
 *       case "TOOL_NAME_COLLISION":
 *         console.error("Rename your tool:", error.message);
 *         break;
 *     }
 *   }
 * }
 * ```
 */
export declare class ConfigurationError extends Error {
	readonly code: ConfigurationErrorCode;
	readonly cause?: Error | undefined;
	[CONFIGURATION_ERROR_SYMBOL]: true;
	readonly name: string;
	constructor(message: string, code: ConfigurationErrorCode, cause?: Error | undefined);
	static isInstance(error: unknown): error is ConfigurationError;
}
export {};
