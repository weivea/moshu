import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { assignProcessToWindowsJob, type WindowsProcessJob } from "./windows-job";

const windowsProcessJobs = new WeakMap<ChildProcessWithoutNullStreams, WindowsProcessJob>();

export interface ShellConfig {
	executable: string;
	args: string[];
	commandViaStdin: boolean;
}

function bashConfig(executable: string): ShellConfig {
	const normalized = executable.replace(/\//g, "\\").toLowerCase();
	const isLegacyWsl = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
	return {
		executable,
		args: isLegacyWsl ? ["-s"] : ["-c"],
		commandViaStdin: isLegacyWsl,
	};
}

function findBashOnPath(): string | undefined {
	const command = process.platform === "win32" ? "where" : "which";
	const target = process.platform === "win32" ? "bash.exe" : "bash";
	const result = spawnSync(command, [target], {
		encoding: "utf8",
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		return undefined;
	}
	const firstMatch = result.stdout.trim().split(/\r?\n/, 1)[0];
	return firstMatch && (process.platform !== "win32" || existsSync(firstMatch))
		? firstMatch
		: undefined;
}

export function getShellConfig(): ShellConfig {
	if (process.platform === "win32") {
		const candidates = [
			process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : undefined,
			process.env["ProgramFiles(x86)"]
				? `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`
				: undefined,
			findBashOnPath(),
		];
		const executable = candidates.find((candidate): candidate is string =>
			Boolean(candidate && existsSync(candidate)),
		);
		if (!executable) {
			throw new Error("No bash shell found. Install Git for Windows or add bash.exe to PATH.");
		}
		return bashConfig(executable);
	}
	if (existsSync("/bin/bash")) {
		return bashConfig("/bin/bash");
	}
	const executable = findBashOnPath();
	return executable
		? bashConfig(executable)
		: { executable: "sh", args: ["-c"], commandViaStdin: false };
}

export function spawnExecutorProcess(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		input?: string;
		keepStdinOpen?: boolean;
	},
): ChildProcessWithoutNullStreams {
	const child = spawn(executable, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stdin.on("error", (error) => {
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
			child.emit("error", error);
		}
	});
	if (process.platform === "win32" && child.pid !== undefined) {
		try {
			windowsProcessJobs.set(child, assignProcessToWindowsJob(child.pid));
		} catch (error) {
			spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
			throw new Error("Unable to assign executor process to a Windows Job Object", {
				cause: error,
			});
		}
	}
	if (options.input !== undefined) {
		child.stdin.end(options.input);
	} else if (options.keepStdinOpen !== true) {
		child.stdin.end();
	}
	return child;
}

export function sanitizeProcessOutput(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) {
				return false;
			}
			if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
				return true;
			}
			return codePoint > 0x1f && !(codePoint >= 0xfff9 && codePoint <= 0xfffb);
		})
		.join("");
}

async function runTaskKill(pid: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const taskKill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			windowsHide: true,
		});
		taskKill.once("error", () => resolve());
		taskKill.once("exit", () => resolve());
	});
}

function sendUnixSignal(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			try {
				process.kill(pid, signal);
				return true;
			} catch (fallbackError) {
				if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") {
					return false;
				}
			}
		}
		return false;
	}
}

export async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await runTaskKill(pid);
		return;
	}
	if (!sendUnixSignal(pid, "SIGTERM")) {
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
	sendUnixSignal(pid, "SIGKILL");
}

export async function terminateExecutorProcess(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	const windowsJob = windowsProcessJobs.get(child);
	if (windowsJob) {
		windowsProcessJobs.delete(child);
		let terminationError: unknown;
		try {
			windowsJob.terminate();
		} catch (error) {
			terminationError = error;
		}
		try {
			windowsJob.close();
		} catch (error) {
			throw terminationError === undefined
				? error
				: new AggregateError(
						[terminationError, error],
						"Terminating and closing the Windows Job Object both failed",
					);
		}
		if (terminationError !== undefined) {
			throw terminationError;
		}
		return;
	}
	if (child.pid !== undefined) {
		await killProcessTree(child.pid);
	}
}

function unixProcessGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			return true;
		}
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			throw error;
		}
		return false;
	}
}

export async function waitForProcess(
	child: ChildProcessWithoutNullStreams,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		let aborting = false;
		let settled = false;
		let cleanupPromise: Promise<void> | undefined;
		const cleanupProcessTree = (afterRootExit = false): Promise<void> => {
			if (cleanupPromise || child.pid === undefined) {
				return cleanupPromise ?? Promise.resolve();
			}
			const pid = child.pid;
			cleanupPromise = (async () => {
				if (afterRootExit && process.platform !== "win32") {
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
				}
				if (process.platform !== "win32" && !unixProcessGroupExists(pid)) {
					return;
				}
				await terminateExecutorProcess(child);
			})();
			return cleanupPromise;
		};
		const handleAbort = (): void => {
			aborting = true;
			void cleanupProcessTree();
		};
		signal?.addEventListener("abort", handleAbort, { once: true });
		if (signal?.aborted) {
			handleAbort();
		}
		child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", handleAbort);
			reject(error);
		});
		child.once("exit", () => {
			void cleanupProcessTree(true);
		});
		child.once("close", (exitCode, exitSignal) => {
			void (async () => {
				if (settled) {
					return;
				}
				settled = true;
				signal?.removeEventListener("abort", handleAbort);
				try {
					await cleanupProcessTree();
					if (aborting || signal?.aborted) {
						reject(
							signal?.reason instanceof Error
								? signal.reason
								: new Error("Process execution aborted"),
						);
						return;
					}
					resolve({ exitCode, signal: exitSignal });
				} catch (error) {
					reject(error);
				}
			})();
		});
	});
}

export async function collectProcessOutput(
	child: ChildProcessWithoutNullStreams,
	options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	let stdout = "";
	let stderr = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let bytes = 0;
	let outputError: Error | undefined;
	const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
		if (outputError) {
			return;
		}
		bytes += chunk.length;
		if (bytes > maxBytes) {
			outputError = new Error(`Process output exceeded ${maxBytes} bytes`);
			if (child.pid !== undefined) {
				void killProcessTree(child.pid);
			}
			return;
		}
		if (target === "stdout") {
			stdout += stdoutDecoder.write(chunk);
		} else {
			stderr += stderrDecoder.write(chunk);
		}
	};
	child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
	const result = await waitForProcess(child, options.signal);
	stdout += stdoutDecoder.end();
	stderr += stderrDecoder.end();
	if (outputError) {
		throw outputError;
	}
	return { stdout, stderr, exitCode: result.exitCode };
}
