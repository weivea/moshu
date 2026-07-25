/**
 * BaseSandbox: Abstract base class for sandbox backends with command execution.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods. Concrete implementations only need to implement execute(),
 * uploadFiles(), and downloadFiles().
 *
 * Runtime requirements on the sandbox host:
 * - read, grep: Pure POSIX shell (awk, grep) — works on any Linux including Alpine
 * - write, edit, readRaw: No runtime needed — uses uploadFiles/downloadFiles directly
 * - ls, glob: Pure POSIX shell (find, stat) — works on any Linux including Alpine
 *
 * No Python, Node.js, or other runtime required.
 */
import type {
	DeleteResult,
	EditResult,
	ExecuteResponse,
	FileDownloadResponse,
	FileUploadResponse,
	GlobResult,
	GrepResult,
	LsResult,
	MaybePromise,
	ReadRawResult,
	ReadResult,
	SandboxBackendProtocolV2,
	WriteResult,
} from "./protocol.js";
/**
 * Base sandbox implementation with execute() as the only abstract method.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods using shell commands executed via execute(). Concrete implementations
 * only need to implement execute(), uploadFiles(), and downloadFiles().
 *
 * All shell commands use pure POSIX utilities (awk, grep, find, stat) that are
 * available on any Linux including Alpine/busybox. No Python, Node.js, or
 * other runtime is required on the sandbox host.
 */
export declare abstract class BaseSandbox implements SandboxBackendProtocolV2 {
	/** Unique identifier for the sandbox backend */
	abstract readonly id: string;
	/**
	 * Execute a command in the sandbox.
	 * This is the only method concrete implementations must provide.
	 */
	abstract execute(command: string): MaybePromise<ExecuteResponse>;
	/**
	 * Upload multiple files to the sandbox.
	 * Implementations must support partial success.
	 */
	abstract uploadFiles(files: Array<[string, Uint8Array]>): MaybePromise<FileUploadResponse[]>;
	/**
	 * Download multiple files from the sandbox.
	 * Implementations must support partial success.
	 */
	abstract downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
	/**
	 * List files and directories in the specified directory (non-recursive).
	 *
	 * Uses pure POSIX shell (find + stat) via execute() — works on any Linux
	 * including Alpine. No Python or Node.js needed.
	 *
	 * @param path - Absolute path to directory
	 * @returns LsResult with list of FileInfo objects on success or error on failure.
	 */
	ls(path: string): Promise<LsResult>;
	/**
	 * Read file content with line numbers.
	 *
	 * Uses pure POSIX shell (awk) via execute() — only the requested slice
	 * is returned over the wire, making this efficient for large files.
	 * Works on any Linux including Alpine (no Python or Node.js needed).
	 *
	 * @param filePath - Absolute file path
	 * @param offset - Line offset to start reading from (0-indexed)
	 * @param limit - Maximum number of lines to read
	 * @returns Formatted file content with line numbers, or error message
	 */
	read(filePath: string, offset?: number, limit?: number): Promise<ReadResult>;
	/**
	 * Read file content as raw FileData.
	 *
	 * Uses downloadFiles() directly — no runtime needed on the sandbox host.
	 *
	 * @param filePath - Absolute file path
	 * @returns ReadRawResult with raw file data on success or error on failure
	 */
	readRaw(filePath: string): Promise<ReadRawResult>;
	/**
	 * Search for a literal text pattern in files using grep.
	 *
	 * @param pattern - Literal string to search for (NOT regex).
	 * @param path - Directory or file path to search in.
	 * @param glob - Optional glob pattern to filter which files to search.
	 * @returns List of GrepMatch dicts containing path, line number, and matched text.
	 */
	grep(pattern: string, path?: string, glob?: string | null): Promise<GrepResult>;
	/**
	 * Structured glob matching returning FileInfo objects.
	 *
	 * Uses pure POSIX shell (find + stat) via execute() to list all files,
	 * then applies glob-to-regex matching in TypeScript. No Python or Node.js
	 * needed on the sandbox host.
	 *
	 * Glob patterns are matched against paths relative to the search base:
	 * - `*`  matches any characters except `/`
	 * - `**` matches any characters including `/` (recursive)
	 * - `?`  matches a single character except `/`
	 * - `[...]` character classes
	 */
	glob(pattern: string, path?: string): Promise<GlobResult>;
	/**
	 * Write content to a file, creating it or overwriting it if it already exists.
	 *
	 * Uses uploadFiles() to write. No runtime needed on the sandbox host.
	 */
	write(filePath: string, content: string): Promise<WriteResult>;
	/**
	 * Edit a file by replacing string occurrences.
	 *
	 * Uses downloadFiles() to read, performs string replacement in TypeScript,
	 * then uploadFiles() to write back. No runtime needed on the sandbox host.
	 *
	 * Memory-conscious: releases intermediate references early so the GC can
	 * reclaim buffers before the next large allocation is made.
	 */
	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll?: boolean,
	): Promise<EditResult>;
	/**
	 * Delete a file from the sandbox via a server-side rm.
	 *
	 * Uses rm -f, so deleting a path that does not exist succeeds silently.
	 */
	delete(filePath: string): Promise<DeleteResult>;
}
