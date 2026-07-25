/**
 * CompositeBackend: Route operations to different backends based on path prefix.
 */
import type {
	AnyBackendProtocol,
	BackendProtocolV2,
	DeleteResult,
	EditResult,
	ExecuteResponse,
	FileDownloadResponse,
	FileUploadResponse,
	GlobResult,
	GrepResult,
	LsResult,
	ReadRawResult,
	ReadResult,
	WriteResult,
} from "./protocol.js";
/**
 * Backend that routes file operations to different backends based on path prefix.
 *
 * This enables hybrid storage strategies like:
 * - `/memories/` → StoreBackend (persistent, cross-thread)
 * - Everything else → StateBackend (ephemeral, per-thread)
 *
 * The CompositeBackend handles path prefix stripping/re-adding transparently.
 */
export declare class CompositeBackend implements BackendProtocolV2 {
	private default;
	private routes;
	private sortedRoutes;
	constructor(defaultBackend: AnyBackendProtocol, routes: Record<string, AnyBackendProtocol>);
	/** Delegates to default backend's id if it is a sandbox, otherwise empty string. */
	get id(): string;
	/** Route prefixes registered on this backend (e.g. `["/workspace"]`). */
	get routePrefixes(): string[];
	/**
	 * Type guard — returns true if `backend` is a {@link CompositeBackend}.
	 *
	 * Uses duck-typing on `routePrefixes` so it works across module boundaries
	 * where `instanceof` may fail.
	 */
	static isInstance(backend: unknown): backend is CompositeBackend;
	/**
	 * Determine which backend handles this key and strip prefix.
	 *
	 * @param key - Original file path
	 * @returns Tuple of [backend, stripped_key] where stripped_key has the route
	 *          prefix removed (but keeps leading slash).
	 */
	private getBackendAndKey;
	/**
	 * Returns true when `path` points at `routePrefix` or its descendants.
	 */
	private isPathWithinRoute;
	/**
	 * Returns true when `routePrefix` is inside `path` (or equal to it).
	 *
	 * Examples:
	 * - path `/` includes all routes
	 * - path `/workspace` includes route `/workspace/memories/`
	 * - path `/workspace` excludes route `/skills/`
	 */
	private isRouteUnderPath;
	/**
	 * List files and directories in the specified directory (non-recursive).
	 *
	 * @param path - Absolute path to directory
	 * @returns LsResult with list of FileInfo objects (with route prefixes added) on success or error on failure.
	 *          Directories have a trailing / in their path and is_dir=true.
	 */
	ls(path: string): Promise<LsResult>;
	/**
	 * Read file content, routing to appropriate backend.
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
	 * @param filePath - Absolute file path
	 * @returns ReadRawResult with raw file data on success or error on failure
	 */
	readRaw(filePath: string): Promise<ReadRawResult>;
	/**
	 * Structured search results or error string for invalid input.
	 */
	grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult>;
	/**
	 * Structured glob matching returning FileInfo objects.
	 */
	glob(pattern: string, path?: string): Promise<GlobResult>;
	/**
	 * Write content to a file, routing to appropriate backend.
	 *
	 * @param filePath - Absolute file path
	 * @param content - File content as string
	 * @returns WriteResult with path or error
	 */
	write(filePath: string, content: string): Promise<WriteResult>;
	/**
	 * Edit a file, routing to appropriate backend.
	 *
	 * @param filePath - Absolute file path
	 * @param oldString - String to find and replace
	 * @param newString - Replacement string
	 * @param replaceAll - If true, replace all occurrences
	 * @returns EditResult with path, occurrences, or error
	 */
	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll?: boolean,
	): Promise<EditResult>;
	/**
	 * Delete a file, routing to the appropriate backend.
	 */
	delete(filePath: string): Promise<DeleteResult>;
	/**
	 * Execute a command via the default backend.
	 * Execution is not path-specific, so it always delegates to the default backend.
	 *
	 * @param command - Full shell command string to execute
	 * @returns ExecuteResponse with combined output, exit code, and truncation flag
	 * @throws Error if the default backend doesn't support command execution
	 */
	execute(command: string): Promise<ExecuteResponse>;
	/**
	 * Upload multiple files, batching by backend for efficiency.
	 *
	 * @param files - List of [path, content] tuples to upload
	 * @returns List of FileUploadResponse objects, one per input file
	 */
	uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
	/**
	 * Download multiple files, batching by backend for efficiency.
	 *
	 * @param paths - List of file paths to download
	 * @returns List of FileDownloadResponse objects, one per input path
	 */
	downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;
}
