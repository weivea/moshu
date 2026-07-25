/**
 * FilesystemBackend: Read and write files directly from the filesystem.
 *
 * Security and search upgrades:
 * - Secure path resolution with root containment when in virtual_mode (sandboxed to cwd)
 * - Prevent symlink-following on file I/O using O_NOFOLLOW when available
 * - Ripgrep-powered grep with literal (fixed-string) search, plus substring fallback
 *   and optional glob include filtering, while preserving virtual path behavior
 */
import type {
	BackendProtocolV2,
	DeleteResult,
	EditResult,
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
 * Backend that reads and writes files directly from the filesystem.
 *
 * Files are accessed using their actual filesystem paths. Relative paths are
 * resolved relative to the current working directory. Content is read/written
 * as plain text, and metadata (timestamps) are derived from filesystem stats.
 */
export declare class FilesystemBackend implements BackendProtocolV2 {
	protected cwd: string;
	protected virtualMode: boolean;
	private maxFileSizeBytes;
	constructor(options?: {
		rootDir?: string;
		virtualMode?: boolean;
		maxFileSizeMb?: number;
	});
	/**
	 * Resolve a file path with security checks.
	 *
	 * When virtualMode=true, treat incoming paths as virtual absolute paths under
	 * this.cwd, disallow traversal (.., ~) and ensure resolved path stays within root.
	 * When virtualMode=false, preserve legacy behavior: absolute paths are allowed
	 * as-is; relative paths resolve under cwd.
	 *
	 * @param key - File path (absolute, relative, or virtual when virtualMode=true)
	 * @returns Resolved absolute path string
	 * @throws Error if path traversal detected or path outside root
	 */
	private resolvePath;
	/**
	 * Resolve the concrete path to unlink for a virtual delete operation.
	 *
	 * Virtual-mode path containment is lexical in resolvePath(), so deleting via
	 * that path could follow a symlinked parent outside the virtual root. Resolve
	 * and validate the real parent, then unlink through that real parent path so a
	 * replacement of the original lexical parent cannot redirect the unlink.
	 */
	private resolveDeletePath;
	/**
	 * List files and directories in the specified directory (non-recursive).
	 *
	 * @param dirPath - Absolute directory path to list files from
	 * @returns List of FileInfo objects for files and directories directly in the directory.
	 *          Directories have a trailing / in their path and is_dir=true.
	 */
	ls(dirPath: string): Promise<LsResult>;
	/**
	 * Read file content with line numbers.
	 *
	 * @param filePath - Absolute or relative file path
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
	 * Write content to a file, creating it or overwriting it if it already exists.
	 * Returns WriteResult. External storage sets filesUpdate=null.
	 */
	write(filePath: string, content: string): Promise<WriteResult>;
	/**
	 * Edit a file by replacing string occurrences.
	 * Returns EditResult. External storage sets filesUpdate=null.
	 */
	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll?: boolean,
	): Promise<EditResult>;
	/**
	 * Delete a file from the filesystem.
	 */
	delete(filePath: string): Promise<DeleteResult>;
	/**
	 * Search for a literal text pattern in files.
	 *
	 * Uses ripgrep if available, falling back to substring search.
	 *
	 * @param pattern - Literal string to search for (NOT regex).
	 * @param dirPath - Directory or file path to search in. Defaults to current directory.
	 * @param glob - Optional glob pattern to filter which files to search.
	 * @returns List of GrepMatch dicts containing path, line number, and matched text.
	 */
	grep(pattern: string, dirPath?: string, glob?: string | null): Promise<GrepResult>;
	/**
	 * Search using ripgrep with fixed-string (literal) mode.
	 *
	 * @param pattern - Literal string to search for (unescaped).
	 * @param baseFull - Resolved base path to search in.
	 * @param includeGlob - Optional glob pattern to filter files.
	 * @returns Dict mapping file paths to list of (line_number, line_text) tuples.
	 *          Returns null if ripgrep is unavailable or times out.
	 */
	private ripgrepSearch;
	/**
	 * Fallback search using literal substring matching when ripgrep is unavailable.
	 *
	 * Recursively searches files, respecting maxFileSizeBytes limit.
	 *
	 * @param pattern - Literal string to search for.
	 * @param baseFull - Resolved base path to search in.
	 * @param includeGlob - Optional glob pattern to filter files by name.
	 * @returns Dict mapping file paths to list of (line_number, line_text) tuples.
	 */
	private literalSearch;
	/**
	 * Structured glob matching returning FileInfo objects.
	 */
	glob(pattern: string, searchPath?: string): Promise<GlobResult>;
	/**
	 * Upload multiple files to the filesystem.
	 *
	 * @param files - List of [path, content] tuples to upload
	 * @returns List of FileUploadResponse objects, one per input file
	 */
	uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
	/**
	 * Download multiple files from the filesystem.
	 *
	 * @param paths - List of file paths to download
	 * @returns List of FileDownloadResponse objects, one per input path
	 */
	downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;
}
