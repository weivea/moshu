/**
 * ContextHubBackend: Store files in a LangSmith Hub agent repo (persistent).
 */
import { Client } from "langsmith";
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
 * Backend that stores files in a LangSmith Hub agent repo (persistent).
 */
export declare class ContextHubBackend implements BackendProtocolV2 {
	private identifier;
	private client;
	private cache;
	private linkedEntries;
	private commitHash;
	constructor(
		identifier: string,
		options?: {
			client?: Client;
		},
	);
	private static stripPrefix;
	private static toHubUnavailableError;
	private loadTree;
	private ensureCache;
	private commit;
	/**
	 * Return linked-entry paths mapped to their repo handles.
	 */
	getLinkedEntries(): Promise<Record<string, string>>;
	/**
	 * Return true if the hub repo already exists with at least one commit.
	 */
	hasPriorCommits(): Promise<boolean>;
	ls(path?: string): Promise<LsResult>;
	read(filePath: string, offset?: number, limit?: number): Promise<ReadResult>;
	readRaw(filePath: string): Promise<ReadRawResult>;
	grep(pattern: string, path?: string | null, glob?: string | null): Promise<GrepResult>;
	glob(pattern: string, _path?: string): Promise<GlobResult>;
	write(filePath: string, content: string): Promise<WriteResult>;
	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll?: boolean,
	): Promise<EditResult>;
	delete(filePath: string): Promise<DeleteResult>;
	uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
	downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;
}
