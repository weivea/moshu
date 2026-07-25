/**
 * StateBackend: Store files in LangGraph agent state (ephemeral).
 */
import type {
	DeleteResult,
	EditResult,
	FileData,
	FileDownloadResponse,
	FileUploadResponse,
	GlobResult,
	GrepResult,
	LsResult,
	ReadRawResult,
	ReadResult,
	BackendRuntime,
	WriteResult,
	BackendProtocolV2,
	BackendOptions,
} from "./protocol.js";
/**
 * Backend that stores files in agent state (ephemeral).
 *
 * Uses LangGraph's state management and checkpointing. Files persist within
 * a conversation thread but not across threads. State is automatically
 * checkpointed after each agent step.
 *
 * Special handling: Since LangGraph state must be updated via Command objects
 * (not direct mutation), operations return filesUpdate in WriteResult/EditResult
 * for the middleware to apply via Command.
 */
export declare class StateBackend implements BackendProtocolV2 {
	private runtime;
	private fileFormat;
	constructor(options?: BackendOptions);
	/**
	 * @deprecated Pass no `runtime` argument
	 */
	constructor(runtime: BackendRuntime, options?: BackendOptions);
	/**
	 * Whether this instance was constructed with the legacy factory pattern.
	 *
	 * When true, state is read from the injected `runtime` and `filesUpdate`
	 * is returned to the caller. When false, state is read from LangGraph's
	 * execution context and updates are sent via `__pregel_send`.
	 */
	private get isLegacy();
	/**
	 * Get files from current state.
	 *
	 * In legacy mode, reads from the injected {@link BackendRuntime}.
	 * In zero-arg mode, reads via {@link PREGEL_READ_KEY} with fresh=true,
	 * which applies any pending task writes through the reducer before returning.
	 */
	private get files();
	/**
	 * Push a files state update through LangGraph's internal send channel.
	 *
	 * In zero-arg mode, sends the update via the `__pregel_send` function
	 * from {@link getConfig}, mirroring Python's `CONFIG_KEY_SEND`.
	 * In legacy mode, this is a no-op — the caller uses `filesUpdate`
	 * from the return value instead.
	 *
	 * @param update - Map of file paths to their updated {@link FileData},
	 *   or null deletion markers.
	 */
	private sendFilesUpdate;
	/**
	 * List files and directories in the specified directory (non-recursive).
	 *
	 * @param path - Absolute path to directory
	 * @returns LsResult with list of FileInfo objects on success or error on failure.
	 *          Directories have a trailing / in their path and is_dir=true.
	 */
	ls(path: string): LsResult;
	/**
	 * Read file content.
	 *
	 * Text files are paginated by line offset/limit.
	 * Binary files return full Uint8Array content (offset/limit ignored).
	 *
	 * @param filePath - Absolute file path
	 * @param offset - Line offset to start reading from (0-indexed)
	 * @param limit - Maximum number of lines to read
	 * @returns ReadResult with content on success or error on failure
	 */
	read(filePath: string, offset?: number, limit?: number): ReadResult;
	/**
	 * Read file content as raw FileData.
	 *
	 * @param filePath - Absolute file path
	 * @returns ReadRawResult with raw file data on success or error on failure
	 */
	readRaw(filePath: string): ReadRawResult;
	/**
	 * Write content to a file, creating it or overwriting it if it already exists.
	 * Returns WriteResult with filesUpdate to update LangGraph state.
	 */
	write(filePath: string, content: string): WriteResult;
	/**
	 * Edit a file by replacing string occurrences.
	 * Returns EditResult with filesUpdate and occurrences.
	 */
	edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): EditResult;
	/**
	 * Delete a file from state by sending a null deletion marker through Pregel.
	 */
	delete(filePath: string): DeleteResult;
	/**
	 * Search file contents for a literal text pattern.
	 * Binary files are skipped.
	 */
	grep(pattern: string, path?: string, glob?: string | null): GrepResult;
	/**
	 * Structured glob matching returning FileInfo objects.
	 */
	glob(pattern: string, path?: string): GlobResult;
	/**
	 * Upload multiple files.
	 *
	 * Note: Since LangGraph state must be updated via Command objects,
	 * the caller must apply filesUpdate via Command after calling this method.
	 *
	 * @param files - List of [path, content] tuples to upload
	 * @returns List of FileUploadResponse objects, one per input file
	 */
	uploadFiles(files: Array<[string, Uint8Array]>): FileUploadResponse[] & {
		filesUpdate?: Record<string, FileData>;
	};
	/**
	 * Download multiple files.
	 *
	 * @param paths - List of file paths to download
	 * @returns List of FileDownloadResponse objects, one per input path
	 */
	downloadFiles(paths: string[]): FileDownloadResponse[];
}
