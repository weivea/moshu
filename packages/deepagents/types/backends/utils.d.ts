/**
 * Shared utility functions for memory backend implementations.
 *
 * This module contains both user-facing string formatters and structured
 * helpers used by backends and the composite router. Structured helpers
 * enable composition without fragile string parsing.
 */
import type {
	AnyBackendProtocol,
	AnySandboxProtocol,
	BackendProtocolV2,
	FileData,
	FileDataV1,
	FileDataV2,
	GrepMatch,
	SandboxBackendProtocolV2,
} from "./protocol.js";
export declare const EMPTY_CONTENT_WARNING = "System reminder: File exists but has empty contents";
export declare const MAX_LINE_LENGTH = 5000;
export declare const LINE_NUMBER_WIDTH = 6;
export declare const TOOL_RESULT_TOKEN_LIMIT = 20000;
export declare const TRUNCATION_GUIDANCE =
	"... [results truncated, try being more specific with your parameters]";
/**
 * Sanitize tool_call_id to prevent path traversal and separator issues.
 *
 * Replaces dangerous characters (., /, \) with underscores.
 */
export declare function sanitizeToolCallId(toolCallId: string): string;
/**
 * Format file content with line numbers (cat -n style).
 *
 * Chunks lines longer than MAX_LINE_LENGTH with continuation markers (e.g., 5.1, 5.2).
 *
 * @param content - File content as string or list of lines
 * @param startLine - Starting line number (default: 1)
 * @returns Formatted content with line numbers and continuation markers
 */
export declare function formatContentWithLineNumbers(
	content: string | string[],
	startLine?: number,
): string;
/**
 * Check if content is empty and return warning message.
 *
 * @param content - Content to check
 * @returns Warning message if empty, null otherwise
 */
export declare function checkEmptyContent(content: string): string | null;
/**
 * Convert FileData to plain string content.
 *
 * @param fileData - FileData object with 'content' key
 * @returns Content as string with lines joined by newlines
 */
export declare function fileDataToString(fileData: FileData): string;
/**
 * Type guard to check if FileData contains binary content (Uint8Array).
 *
 * @param data - FileData to check
 * @returns True if the content is a Uint8Array (binary)
 */
export declare function isFileDataBinary(data: FileData): data is FileDataV2 & {
	content: Uint8Array;
};
/**
 * Create a FileData object.
 *
 * Defaults to v2 format (content as single string). Pass `fileFormat: "v1"` for
 * backward compatibility with older readers during a rolling deployment.
 * Binary content (Uint8Array) is only supported with v2.
 *
 * @param content - File content as a string or binary Uint8Array (v2 only)
 * @param createdAt - Optional creation timestamp (ISO format), defaults to now
 * @param fileFormat - Storage format: "v2" (default) or "v1" (legacy line array)
 * @returns FileData in the requested format
 */
export declare function createFileData(
	content: string | Uint8Array,
	createdAt?: string,
	fileFormat?: "v1" | "v2",
	mimeType?: string,
): FileData;
/**
 * Update FileData with new content, preserving creation timestamp.
 *
 * @param fileData - Existing FileData object
 * @param content - New content as string
 * @returns Updated FileData object
 */
export declare function updateFileData(fileData: FileData, content: string): FileData;
export declare function createWriteFileData(
	filePath: string,
	content: string,
	fileFormat?: "v1" | "v2",
	existing?: FileData,
): FileData;
/**
 * Format file data for read response with line numbers.
 *
 * @param fileData - FileData object
 * @param offset - Line offset (0-indexed)
 * @param limit - Maximum number of lines
 * @returns Formatted content or error message
 */
export declare function formatReadResponse(
	fileData: FileData,
	offset: number,
	limit: number,
): string;
/**
 * Perform string replacement with occurrence validation.
 *
 * @param content - Original content
 * @param oldString - String to replace
 * @param newString - Replacement string
 * @param replaceAll - Whether to replace all occurrences
 * @returns Tuple of [new_content, occurrences] on success, or error message string
 *
 * Special case: When both content and oldString are empty, this sets the initial
 * content to newString. This allows editing empty files by treating empty oldString
 * as "set initial content" rather than "replace nothing".
 */
export declare function performStringReplacement(
	content: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): [string, number] | string;
/**
 * Truncate list or string result if it exceeds token limit (rough estimate: 4 chars/token).
 */
export declare function truncateIfTooLong(result: string[] | string): string[] | string;
/**
 * Validate and normalize a directory path.
 *
 * Ensures paths are safe to use by preventing directory traversal attacks
 * and enforcing consistent formatting. All paths are normalized to use
 * forward slashes and start with a leading slash.
 *
 * This function is designed for virtual filesystem paths and rejects
 * Windows absolute paths (e.g., C:/..., F:/...) to maintain consistency
 * and prevent path format ambiguity.
 *
 * @param path - Path to validate
 * @returns Normalized path starting with / and ending with /
 * @throws Error if path is invalid
 *
 * @example
 * ```typescript
 * validatePath("foo/bar")  // Returns: "/foo/bar/"
 * validatePath("/./foo//bar")  // Returns: "/foo/bar/"
 * validatePath("../etc/passwd")  // Throws: Path traversal not allowed
 * validatePath("C:\\Users\\file")  // Throws: Windows absolute paths not supported
 * ```
 */
export declare function validatePath(path: string | null | undefined): string;
/**
 * Validate and normalize a file path for security.
 *
 * Ensures paths are safe to use by preventing directory traversal attacks
 * and enforcing consistent formatting. All paths are normalized to use
 * forward slashes and start with a leading slash.
 *
 * This function is designed for virtual filesystem paths and rejects
 * Windows absolute paths (e.g., C:/..., F:/...) to maintain consistency
 * and prevent path format ambiguity.
 *
 * @param path - The path to validate and normalize.
 * @param allowedPrefixes - Optional list of allowed path prefixes. If provided,
 *                          the normalized path must start with one of these prefixes.
 * @returns Normalized canonical path starting with `/` and using forward slashes.
 * @throws Error if path contains traversal sequences (`..` or `~`), is a Windows
 *         absolute path (e.g., C:/...), or does not start with an allowed prefix
 *         when `allowedPrefixes` is specified.
 *
 * @example
 * ```typescript
 * validateFilePath("foo/bar")  // Returns: "/foo/bar"
 * validateFilePath("/./foo//bar")  // Returns: "/foo/bar"
 * validateFilePath("../etc/passwd")  // Throws: Path traversal not allowed
 * validateFilePath("C:\\Users\\file.txt")  // Throws: Windows absolute paths not supported
 * validateFilePath("/data/file.txt", ["/data/"])  // Returns: "/data/file.txt"
 * validateFilePath("/etc/file.txt", ["/data/"])  // Throws: Path must start with...
 * ```
 */
export declare function validateFilePath(path: string, allowedPrefixes?: string[]): string;
/**
 * Search files dict for paths matching glob pattern.
 *
 * @param files - Dictionary of file paths to FileData
 * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
 * @param path - Base path to search from
 * @returns Newline-separated file paths, sorted by modification time (most recent first).
 *          Returns "No files found" if no matches.
 *
 * @example
 * ```typescript
 * const files = {"/src/main.py": FileData(...), "/test.py": FileData(...)};
 * globSearchFiles(files, "*.py", "/");
 * // Returns: "/test.py\n/src/main.py" (sorted by modified_at)
 * ```
 */
export declare function globSearchFiles(
	files: Record<string, FileData>,
	pattern: string,
	path?: string,
): string;
/**
 * Format grep search results based on output mode.
 *
 * @param results - Dictionary mapping file paths to list of [line_num, line_content] tuples
 * @param outputMode - Output format - "files_with_matches", "content", or "count"
 * @returns Formatted string output
 */
export declare function formatGrepResults(
	results: Record<string, Array<[number, string]>>,
	outputMode: "files_with_matches" | "content" | "count",
): string;
/**
 * Search file contents for literal text pattern.
 *
 * Performs literal text search.
 *
 * @param files - Dictionary of file paths to FileData
 * @param pattern - Literal text to search for
 * @param path - Base path to search from
 * @param glob - Optional glob pattern to filter files (e.g., "*.py")
 * @param outputMode - Output format - "files_with_matches", "content", or "count"
 * @returns Formatted search results. Returns "No matches found" if no results.
 *
 * @example
 * ```typescript
 * const files = {"/file.py": FileData({content: ["import os", "print('hi')"], ...})};
 * grepSearchFiles(files, "import", "/");
 * // Returns: "/file.py" (with output_mode="files_with_matches")
 * ```
 */
export declare function grepSearchFiles(
	files: Record<string, FileData>,
	pattern: string,
	path?: string | null,
	glob?: string | null,
	outputMode?: "files_with_matches" | "content" | "count",
): string;
/**
 * Return structured grep matches from an in-memory files mapping.
 *
 * Performs literal text search (not regex). Binary files are skipped.
 * Returns an empty array when no matches are found or on invalid input.
 */
export declare function grepMatchesFromFiles(
	files: Record<string, FileData>,
	pattern: string,
	path?: string | null,
	glob?: string | null,
): GrepMatch[];
/**
 * Group structured matches into the legacy dict form used by formatters.
 */
export declare function buildGrepResultsDict(
	matches: GrepMatch[],
): Record<string, Array<[number, string]>>;
/**
 * Format structured grep matches using existing formatting logic.
 */
export declare function formatGrepMatches(
	matches: GrepMatch[],
	outputMode: "files_with_matches" | "content" | "count",
): string;
/**
 * Determine MIME type from a file path's extension.
 *
 * Defaults to "text/plain" for unknown extensions. Only the known non-text
 * formats above (images, audio, video, PDF/PPT) are treated as binary by
 * {@link isTextMimeType}; everything else reads as text, including source files
 * with uncommon extensions (.properties, .scss, .tf) and extension-less files
 * (Dockerfile, mvnw). This avoids base64-encoding text into document blocks,
 * which the model can't read and which the Anthropic provider rejects with a
 * 400.
 *
 * @param filePath - File path to inspect
 * @returns MIME type string (e.g., "image/png", "text/plain")
 */
export declare function getMimeType(filePath: string): string;
/**
 * Check whether a MIME type represents text content.
 *
 * @param mimeType - MIME type string to check
 * @returns True if the MIME type is text-based
 */
export declare function isTextMimeType(mimeType: string): boolean;
/**
 * Type guard to check if FileData is v1 format (content as line array).
 *
 * @param data - FileData to check
 * @returns True if data is FileDataV1
 */
export declare function isFileDataV1(data: FileData): data is FileDataV1;
/**
 * Convert FileData to v2 format, joining v1 line arrays into a single string.
 *
 * If the data is already v2, returns it unchanged.
 *
 * @param data - FileData in either format
 * @returns FileDataV2 with content as string (text) or Uint8Array (binary)
 */
export declare function migrateToFileDataV2(
	data: FileDataV1 | FileDataV2,
	filePath: string,
): FileDataV2;
/**
 * Adapt a v1 {@link BackendProtocol} to {@link BackendProtocolV2}.
 *
 * If the backend already implements v2, it is returned as-is.
 * For v1 backends, wraps returns in Result types:
 * - `read()` string returns wrapped in {@link ReadResult}
 * - `readRaw()` FileData returns wrapped in {@link ReadRawResult}
 * - `grep()` returns wrapped in {@link GrepResult}
 * - `ls()` FileInfo[] returns wrapped in {@link LsResult}
 * - `glob()` FileInfo[] returns wrapped in {@link GlobResult}
 *
 * Note: For sandbox instances, use {@link adaptSandboxProtocol} instead.
 *
 * @param backend - Backend instance (v1 or v2)
 * @returns BackendProtocolV2-compatible backend
 */
export declare function adaptBackendProtocol(backend: AnyBackendProtocol): BackendProtocolV2;
/**
 * Adapt a sandbox backend from v1 to v2 interface.
 *
 * This extends {@link adaptBackendProtocol} to also preserve sandbox-specific
 * properties from {@link SandboxBackendProtocol}: `execute` and `id`.
 *
 * @param sandbox - Sandbox backend (v1 or v2)
 * @returns SandboxBackendProtocolV2-compatible sandbox
 */
export declare function adaptSandboxProtocol(sandbox: AnySandboxProtocol): SandboxBackendProtocolV2;
