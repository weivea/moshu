/**
 * StoreBackend: Adapter for LangGraph's BaseStore (persistent, cross-thread).
 */
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
	BackendOptions,
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
	StateAndStore,
} from "./protocol.js";
/**
 * Context provided to dynamic namespace factory functions.
 */
export interface StoreBackendContext<StateT = unknown> {
	/**
	 * Current graph state, when available.
	 *
	 * In legacy factory mode this is the injected runtime state. In zero-arg mode
	 * this is read from the current LangGraph execution context.
	 */
	state: StateT;
	/**
	 * Runnable config, when available.
	 *
	 * This mirrors the Python implementation's access to config metadata for
	 * namespace resolution.
	 */
	config?: {
		metadata?: Record<string, unknown>;
		configurable?: Record<string, unknown>;
	};
	/**
	 * Legacy assistant identifier, resolved from config metadata first and then
	 * from the injected runtime for backwards compatibility.
	 */
	assistantId?: string;
}
export type StoreBackendNamespaceFactory<StateT = unknown> = (
	context: StoreBackendContext<StateT>,
) => string[];
/**
 * Options for StoreBackend constructor.
 */
export interface StoreBackendOptions<StateT = unknown> extends BackendOptions {
	/**
	 * Explicit store instance to use for persistence.
	 *
	 * This mirrors the Python API and allows constructing a backend directly with
	 * a store instance, e.g. `new StoreBackend({ store })`.
	 *
	 * When omitted, the backend uses the legacy injected runtime store or the
	 * LangGraph execution-context store.
	 */
	store?: BaseStore;
	/**
	 * Custom namespace for store operations.
	 *
	 * Accepts either a static namespace array or a factory that derives the
	 * namespace from the current backend context.
	 *
	 * If not provided, falls back to legacy assistant-id detection from config
	 * metadata, then the injected runtime's `assistantId`, and finally
	 * `["filesystem"]`.
	 *
	 * @example
	 * ```typescript
	 * // Static namespace
	 * new StoreBackend({
	 *   namespace: ["memories", orgId, userId, "filesystem"],
	 * });
	 *
	 * // Dynamic namespace
	 * new StoreBackend({
	 *   namespace: ({ state }) => [
	 *     "memories",
	 *     (state as { userId: string }).userId,
	 *     "filesystem",
	 *   ],
	 * });
	 * ```
	 */
	namespace?: string[] | StoreBackendNamespaceFactory<StateT>;
}
/**
 * Backend that stores files in LangGraph's BaseStore (persistent).
 *
 * Uses LangGraph's Store for persistent, cross-conversation storage.
 * Files are organized via namespaces and persist across all threads.
 *
 * The namespace can be customized via a factory function for flexible
 * isolation patterns (user-scoped, org-scoped, etc.), or falls back
 * to legacy assistant_id-based isolation.
 */
export declare class StoreBackend implements BackendProtocolV2 {
	private stateAndStore;
	private storeOverride;
	private _namespace;
	private fileFormat;
	constructor(options?: StoreBackendOptions);
	/**
	 * @deprecated Pass no `stateAndStore` argument
	 */
	constructor(stateAndStore: StateAndStore, options?: StoreBackendOptions);
	/**
	 * Get the BaseStore instance for persistent storage operations.
	 *
	 * In legacy mode, reads from the injected {@link StateAndStore}.
	 * In zero-arg mode, retrieves the store from the LangGraph execution
	 * context via {@link getLangGraphStore}.
	 *
	 * @returns BaseStore instance
	 * @throws Error if no store is available in either mode
	 */
	private getStore;
	/**
	 * Get the current graph state when available.
	 */
	private getState;
	/**
	 * Get the most relevant runnable config for namespace resolution.
	 */
	private getNamespaceConfig;
	/**
	 * Legacy assistant-id detection compatible with both Python and the
	 * historical TypeScript `assistantId` runtime property.
	 */
	private getLegacyAssistantId;
	/**
	 * Get the namespace for store operations.
	 *
	 * Resolution order:
	 * 1. Explicit namespace from constructor options
	 * 2. Namespace factory resolved from the current backend context
	 * 3. Assistant ID from runtime config / LangGraph config metadata
	 * 4. Legacy `assistantId` from the injected runtime
	 * 5. `["filesystem"]`
	 */
	protected getNamespace(): string[];
	/**
	 * Convert a store Item to FileData format.
	 *
	 * @param storeItem - The store Item containing file data
	 * @returns FileData object
	 * @throws Error if required fields are missing or have incorrect types
	 */
	private convertStoreItemToFileData;
	/**
	 * Convert FileData to a value suitable for store.put().
	 *
	 * @param fileData - The FileData to convert
	 * @returns Object with content, mimeType, created_at, and modified_at fields
	 */
	private convertFileDataToStoreValue;
	/**
	 * Search store with automatic pagination to retrieve all results.
	 *
	 * @param store - The store to search
	 * @param namespace - Hierarchical path prefix to search within
	 * @param options - Optional query, filter, and page_size
	 * @returns List of all items matching the search criteria
	 */
	private searchStorePaginated;
	/**
	 * List files and directories in the specified directory (non-recursive).
	 *
	 * @param path - Absolute path to directory
	 * @returns LsResult with list of FileInfo objects on success or error on failure.
	 *          Directories have a trailing / in their path and is_dir=true.
	 */
	ls(path: string): Promise<LsResult>;
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
	 * Delete a file from the store.
	 *
	 * The file path is used as an exact store key. Wildcards are treated
	 * literally and do not expand to multiple entries.
	 */
	delete(filePath: string): Promise<DeleteResult>;
	/**
	 * Search file contents for a literal text pattern.
	 * Binary files are skipped.
	 */
	grep(pattern: string, path?: string, glob?: string | null): Promise<GrepResult>;
	/**
	 * Structured glob matching returning FileInfo objects.
	 */
	glob(pattern: string, path?: string): Promise<GlobResult>;
	/**
	 * Upload multiple files.
	 *
	 * @param files - List of [path, content] tuples to upload
	 * @returns List of FileUploadResponse objects, one per input file
	 */
	uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
	/**
	 * Download multiple files.
	 *
	 * @param paths - List of file paths to download
	 * @returns List of FileDownloadResponse objects, one per input path
	 */
	downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;
}
