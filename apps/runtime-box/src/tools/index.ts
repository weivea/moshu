/**
 * Executor-owned implementations adapted from Pi coding-agent v0.82.1.
 * The agent process only receives RPC proxies and never executes these operations.
 */
import {
	runtimeBoxToolInvokeOutputSchema,
	runtimeBoxToolProgressEventSchema,
	getExecutorToolBinaryFilename,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ExecutorToolName,
	type ExecutorToolProgressEvent,
} from "@moshu/contracts";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { executeBashTool } from "./bash.ts";
import { executeEditTool } from "./edit.ts";
import { executeFindTool } from "./find.ts";
import { executeGrepTool } from "./grep.ts";
import { executeLsTool } from "./ls.ts";
import { pruneExecutorToolOutputFiles } from "./output-accumulator.ts";
import { executeReadTool } from "./read.ts";
import { executeWriteTool } from "./write.ts";

export interface ExecutorToolBinaryPaths {
	rg: string;
	fd: string;
}

export interface ExecutorToolExecutionOptions {
	signal?: AbortSignal;
	onProgress?: (event: ExecutorToolProgressEvent) => void;
}

async function requireExecutable(path: string): Promise<void> {
	await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
}

export async function resolveBundledExecutorToolBinaries(
	executableDirectory = dirname(process.execPath),
): Promise<ExecutorToolBinaryPaths> {
	const rg = join(executableDirectory, getExecutorToolBinaryFilename("rg"));
	const fd = join(executableDirectory, getExecutorToolBinaryFilename("fd"));
	try {
		await Promise.all([requireExecutable(rg), requireExecutable(fd)]);
	} catch (error) {
		throw new Error(
			`Executor tool binaries are missing or not executable in ${executableDirectory}`,
			{ cause: error },
		);
	}
	return { rg, fd };
}

export class ExecutorToolRuntime {
	constructor(readonly binaries: ExecutorToolBinaryPaths) {}

	async execute(
		input: ExecutorToolInvokeInput,
		options: ExecutorToolExecutionOptions = {},
	): Promise<ExecutorToolInvokeOutput> {
		const cwdStat = await stat(input.cwd);
		if (!cwdStat.isDirectory()) {
			throw new Error(`Executor tool cwd is not a directory: ${input.cwd}`);
		}
		const resultBase = {
			schemaVersion: 1 as const,
			invocationId: input.invocationId,
		};
		switch (input.call.tool) {
			case "read": {
				const result = await executeReadTool(input.call.arguments, input.cwd, options.signal);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "read",
					...result,
				});
			}
			case "bash": {
				let sequence = 0;
				const result = await executeBashTool(input.call.arguments, input.cwd, {
					...(options.signal ? { signal: options.signal } : {}),
					onProgress: (progress) => {
						const event = runtimeBoxToolProgressEventSchema.parse({
							schemaVersion: 1,
							invocationId: input.invocationId,
							tool: "bash",
							sequence,
							...progress,
						});
						sequence += 1;
						options.onProgress?.(event);
					},
				});
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "bash",
					...result,
				});
			}
			case "edit": {
				const result = await executeEditTool(input.call.arguments, input.cwd, options.signal);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "edit",
					...result,
				});
			}
			case "write": {
				const result = await executeWriteTool(input.call.arguments, input.cwd, options.signal);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "write",
					...result,
				});
			}
			case "grep": {
				const result = await executeGrepTool(
					input.call.arguments,
					input.cwd,
					this.binaries.rg,
					options.signal,
				);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "grep",
					...result,
				});
			}
			case "find": {
				const result = await executeFindTool(
					input.call.arguments,
					input.cwd,
					this.binaries.fd,
					options.signal,
				);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "find",
					...result,
				});
			}
			case "ls": {
				const result = await executeLsTool(input.call.arguments, input.cwd, options.signal);
				return runtimeBoxToolInvokeOutputSchema.parse({
					...resultBase,
					tool: "ls",
					...result,
				});
			}
			default:
				return assertNeverTool(input.call);
		}
	}
}

function assertNeverTool(call: never): never {
	const received = call as { tool?: ExecutorToolName };
	throw new Error(`Unsupported executor tool: ${received.tool ?? "unknown"}`);
}

export async function createExecutorToolRuntime(
	binaries?: ExecutorToolBinaryPaths,
): Promise<ExecutorToolRuntime> {
	await pruneExecutorToolOutputFiles();
	return new ExecutorToolRuntime(binaries ?? (await resolveBundledExecutorToolBinaries()));
}
