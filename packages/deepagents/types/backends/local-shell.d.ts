/**
 * LocalShellBackend: Node.js implementation of the filesystem backend with unrestricted local shell execution.
 *
 * This backend extends FilesystemBackend to add shell command execution on the local
 * host system. It provides NO sandboxing or isolation - all operations run directly
 * on the host machine with full system access.
 *
 * @module
 */
import { FilesystemBackend } from "./filesystem.js";
import type {
	EditResult,
	ExecuteResponse,
	GlobResult,
	LsResult,
	ReadResult,
	SandboxBackendProtocolV2,
} from "./protocol.js";
/**
 * Options for creating a LocalShellBackend instance.
 */
export interface LocalShellBackendOptions {
	/**
	 * Working directory for both filesystem operations and shell commands.
	 * When set with `virtualMode: false` (default), absolute paths and `..` can
	 * bypass rootDir for filesystem operations.
	 * @defaultValue `process.cwd()`
	 */
	rootDir?: string;
	/**
	 * Enable virtual path mode for filesystem operations.
	 * When true, treats rootDir as a virtual root filesystem.
	 * When false (default), preserves legacy path behavior.
	 * Does NOT restrict shell commands.
	 * @defaultValue `false`
	 */
	virtualMode?: boolean;
	/**
	 * Maximum time in seconds to wait for shell command execution.
	 * Commands exceeding this timeout will be terminated.
	 * @defaultValue `120`
	 */
	timeout?: number;
	/**
	 * Maximum number of bytes to capture from command output.
	 * Output exceeding this limit will be truncated.
	 * @defaultValue `100_000`
	 */
	maxOutputBytes?: number;
	/**
	 * Environment variables for shell commands. If undefined, starts with an empty
	 * environment (unless inheritEnv is true).
	 * @defaultValue `undefined`
	 */
	env?: Record<string, string>;
	/**
	 * Whether to inherit the parent process's environment variables.
	 * When false, only variables in env dict are available.
	 * When true, inherits all process.env variables and applies env overrides.
	 * @defaultValue `false`
	 */
	inheritEnv?: boolean;
	/**
	 * Files to create on disk during `create()`.
	 * Keys are file paths (resolved via the backend's path handling),
	 * values are string content.
	 * @defaultValue `undefined`
	 */
	initialFiles?: Record<string, string>;
}
/**
 * Filesystem backend with unrestricted local shell command execution.
 *
 * This backend extends FilesystemBackend to add shell command execution
 * capabilities. Commands are executed directly on the host system without any
 * sandboxing, process isolation, or security restrictions.
 *
 * **Security Warning:**
 * This backend grants agents BOTH direct filesystem access AND unrestricted
 * shell execution on your local machine. Use with extreme caution and only in
 * appropriate environments.
 *
 * **Appropriate use cases:**
 * - Local development CLIs (coding assistants, development tools)
 * - Personal development environments where you trust the agent's code
 * - CI/CD pipelines with proper secret management
 *
 * **Inappropriate use cases:**
 * - Production environments (e.g., web servers, APIs, multi-tenant systems)
 * - Processing untrusted user input or executing untrusted code
 *
 * Use StateBackend, StoreBackend, or extend BaseSandbox for production.
 *
 * @example
 * ```typescript
 * import { LocalShellBackend } from "@langchain/deepagents";
 *
 * // Create backend with explicit environment
 * const backend = new LocalShellBackend({
 *   rootDir: "/home/user/project",
 *   virtualMode: true,
 *   env: { PATH: "/usr/bin:/bin" },
 * });
 *
 * // Execute shell commands (runs directly on host)
 * const result = await backend.execute("ls -la");
 * console.log(result.output);
 * console.log(result.exitCode);
 *
 * // Use filesystem operations (inherited from FilesystemBackend)
 * const content = await backend.read("/README.md");
 * await backend.write("/output.txt", "Hello world");
 *
 * // Inherit all environment variables
 * const backend2 = new LocalShellBackend({
 *   rootDir: "/home/user/project",
 *   virtualMode: true,
 *   inheritEnv: true,
 * });
 * ```
 */
export declare class LocalShellBackend
	extends FilesystemBackend
	implements SandboxBackendProtocolV2
{
	#private;
	constructor(options?: LocalShellBackendOptions);
	/** Unique identifier for this backend instance (format: "local-{random_hex}"). */
	get id(): string;
	/** Whether the backend has been initialized and is ready to use. */
	get isInitialized(): boolean;
	/** Alias for `isInitialized`, matching the standard sandbox interface. */
	get isRunning(): boolean;
	/**
	 * Initialize the backend by ensuring the rootDir exists.
	 *
	 * Creates the rootDir (and any parent directories) if it does not already
	 * exist. Safe to call on an existing directory. Must be called before
	 * `execute()`, or use the static `LocalShellBackend.create()` factory.
	 *
	 * @throws {SandboxError} If already initialized (`ALREADY_INITIALIZED`)
	 */
	initialize(): Promise<void>;
	/**
	 * Mark the backend as no longer running.
	 *
	 * For local shell backends there is no remote resource to tear down,
	 * so this simply flips the `isRunning` / `isInitialized` flag.
	 */
	close(): Promise<void>;
	/**
	 * Read a file, adapting error messages to the standard sandbox format.
	 */
	read(filePath: string, offset?: number, limit?: number): Promise<ReadResult>;
	/**
	 * Edit a file, adapting error messages to the standard sandbox format.
	 */
	edit(
		filePath: string,
		oldString: string,
		newString: string,
		replaceAll?: boolean,
	): Promise<EditResult>;
	/**
	 * List directory contents, returning paths relative to rootDir.
	 */
	ls(dirPath: string): Promise<LsResult>;
	/**
	 * Glob matching that returns relative paths and includes directories.
	 */
	glob(pattern: string, searchPath?: string): Promise<GlobResult>;
	/**
	 * Execute a shell command directly on the host system.
	 *
	 * Commands are executed directly on your host system using `spawn()`
	 * with `shell: true`. There is NO sandboxing, isolation, or security
	 * restrictions. The command runs with your user's full permissions.
	 *
	 * The command is executed using the system shell with the working directory
	 * set to the backend's rootDir. Stdout and stderr are combined into a single
	 * output stream, with stderr lines prefixed with `[stderr]`.
	 *
	 * @param command - Shell command string to execute
	 * @returns ExecuteResponse containing output, exit code, and truncation flag
	 */
	execute(command: string): Promise<ExecuteResponse>;
	/**
	 * Create and initialize a new LocalShellBackend in one step.
	 *
	 * This is the recommended way to create a backend when the rootDir may
	 * not exist yet. It combines construction and initialization (ensuring
	 * rootDir exists) into a single async operation.
	 *
	 * @param options - Configuration options for the backend
	 * @returns An initialized and ready-to-use backend
	 */
	static create(options?: LocalShellBackendOptions): Promise<LocalShellBackend>;
}
