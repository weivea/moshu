import type { FilesystemOperation, FilesystemPermission, PermissionMode } from "./types.js";
/**
 * Validate permission rule paths at setup time. Throws if any path is
 * relative, contains `..`, or contains `~`.
 */
export declare function validatePermissionPaths(permissions: FilesystemPermission[]): void;
/**
 * Canonicalize and validate an absolute path before permission checking.
 *
 * Throws for:
 * - Empty or non-string input
 * - Non-absolute paths (must start with `/`)
 * - Paths containing `..`
 * - Paths containing `~`
 */
export declare function validatePath(raw: string): string;
/**
 * Test whether `path` matches a glob `pattern`.
 *
 * Supports:
 * - `**` — any number of directory levels
 * - `*` — within a single path segment
 * - `{a,b}` — brace expansion
 *
 * Uses `micromatch` with `dot: true` so dotfiles are matched by default.
 */
export declare function globMatch(path: string, pattern: string): boolean;
/**
 * Evaluate permission rules against an operation + path and return the
 * access decision.
 *
 * First-match-wins; permissive default.
 *
 * @returns `"allow"` if the operation is permitted, `"deny"` otherwise.
 */
export declare function decidePathAccess(
	rules: readonly FilesystemPermission[],
	operation: FilesystemOperation,
	path: string,
): PermissionMode;
