/**
 * LangSmith Sandbox backend for deepagents.
 *
 * @example
 * ```typescript
 * import { LangSmithSandbox, createDeepAgent } from "@moshu/deepagents";
 *
 * const sandbox = await LangSmithSandbox.create({ snapshotId: "your-snapshot-id" });
 *
 * const agent = createDeepAgent({ model, backend: sandbox });
 *
 * try {
 *   await agent.invoke({ messages: [...] });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 *
 * @module
 */
import {
	type Sandbox,
	type Snapshot,
	type CreateSandboxOptions,
	type CaptureSnapshotOptions,
	type StartSandboxOptions,
} from "langsmith/experimental/sandbox";
import { BaseSandbox } from "./sandbox.js";
import type { ExecuteResponse, FileDownloadResponse, FileUploadResponse } from "./protocol.js";
/** Options for constructing a LangSmithSandbox from an existing Sandbox instance. */
export interface LangSmithSandboxOptions {
	/** An already-created LangSmith Sandbox instance to wrap. */
	sandbox: Sandbox;
	/**
	 * Default command timeout in seconds.
	 * @default 1800 (30 minutes)
	 */
	defaultTimeout?: number;
}
/** Options for the `LangSmithSandbox.create()` static factory. */
export interface LangSmithSandboxCreateOptions
	extends Omit<CreateSandboxOptions, "name" | "timeout" | "waitForReady" | "snapshotName"> {
	/**
	 * Snapshot ID to boot from.
	 * Mutually exclusive with `templateName`.
	 */
	snapshotId?: string;
	/**
	 * Name of the LangSmith sandbox template to use.
	 * Mutually exclusive with `snapshotId`.
	 * @deprecated Use `snapshotId` instead. Template-based creation will be
	 * removed in a future release.
	 */
	templateName?: string;
	/**
	 * LangSmith API key. Defaults to the `LANGSMITH_API_KEY` environment variable.
	 */
	apiKey?: string;
	/**
	 * Default command timeout in seconds.
	 * @default 1800 (30 minutes)
	 */
	defaultTimeout?: number;
}
/**
 * LangSmith Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution and file operations
 * via the LangSmith Sandbox API.
 *
 * Use the static `LangSmithSandbox.create()` factory for the simplest setup,
 * or construct directly with an existing `Sandbox` instance.
 *
 * @experimental This feature is experimental, and breaking changes are expected.
 */
export declare class LangSmithSandbox extends BaseSandbox {
	#private;
	constructor(options: LangSmithSandboxOptions);
	/** Whether the sandbox is currently active. */
	get isRunning(): boolean;
	/** Return the LangSmith sandbox name as the unique identifier. */
	get id(): string;
	/**
	 * Execute a shell command in the LangSmith sandbox.
	 *
	 * @param command - Shell command string to execute
	 * @param options.timeout - Override timeout in seconds; 0 disables timeout
	 */
	execute(
		command: string,
		options?: {
			timeout?: number;
		},
	): Promise<ExecuteResponse>;
	/**
	 * Download files from the sandbox using LangSmith's native file read API.
	 * @param paths - List of file paths to download
	 * @returns List of FileDownloadResponse objects, one per input path
	 */
	downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;
	/**
	 * Upload files to the sandbox using LangSmith's native file write API.
	 * @param files - List of [path, content] tuples to upload
	 * @returns List of FileUploadResponse objects, one per input file
	 */
	uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
	/**
	 * Delete this sandbox and mark it as no longer running.
	 *
	 * After calling this, `isRunning` will be `false` and the sandbox
	 * cannot be used again.
	 */
	close(): Promise<void>;
	/**
	 * Start a stopped sandbox and wait until it is ready.
	 *
	 * After calling this, `isRunning` will be `true` and the sandbox
	 * can be used for command execution and file operations again.
	 *
	 * @param options - Start options (timeout, signal).
	 */
	start(options?: StartSandboxOptions): Promise<void>;
	/**
	 * Stop the sandbox without deleting it.
	 *
	 * Sandbox files are preserved and the sandbox can be restarted later
	 * with `start()`. After calling this, `isRunning` will be `false`.
	 */
	stop(): Promise<void>;
	/**
	 * Capture a snapshot from this running sandbox.
	 *
	 * Snapshots can be used to create new sandboxes via
	 * `LangSmithSandbox.create({ snapshotId })`.
	 *
	 * @param name - Name for the snapshot.
	 * @param options - Capture options (checkpoint, timeout).
	 * @returns The created Snapshot in "ready" status.
	 */
	captureSnapshot(name: string, options?: CaptureSnapshotOptions): Promise<Snapshot>;
	/**
	 * Create and return a new LangSmithSandbox in one step.
	 *
	 * This is the recommended way to create a sandbox — no need to import
	 * anything from `langsmith/experimental/sandbox` directly.
	 *
	 * @example
	 * ```typescript
	 * const sandbox = await LangSmithSandbox.create({
	 *   snapshotId: "abc-123",
	 * });
	 *
	 * try {
	 *   const agent = createDeepAgent({ model, backend: sandbox });
	 *   await agent.invoke({ messages: [...] });
	 * } finally {
	 *   await sandbox.close();
	 * }
	 * ```
	 */
	static create(options: LangSmithSandboxCreateOptions): Promise<LangSmithSandbox>;
}
