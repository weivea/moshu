import type { ExecutorBashToolDetails, ExecutorBashToolArguments } from "@moshu/contracts";
import { StringDecoder } from "node:string_decoder";
import { OutputAccumulator } from "./output-accumulator.ts";
import {
	getShellConfig,
	sanitizeProcessOutput,
	spawnExecutorProcess,
	waitForProcess,
} from "./process-runner.ts";
import type { BashToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";

const defaultTimeoutSeconds = 30 * 60;
const progressThrottleMs = 100;

export async function executeBashTool(
	params: ExecutorBashToolArguments,
	cwd: string,
	options: {
		signal?: AbortSignal;
		onProgress?: (result: BashToolResult) => void;
	},
): Promise<BashToolResult> {
	throwIfAborted(options.signal);
	const shell = getShellConfig();
	const timeoutSeconds = params.timeout ?? defaultTimeoutSeconds;
	const child = spawnExecutorProcess(
		shell.executable,
		shell.commandViaStdin ? shell.args : [...shell.args, params.command],
		{
			cwd,
			env: process.env,
			...(shell.commandViaStdin ? { input: params.command } : {}),
		},
	);
	const combinedController = new AbortController();
	let progressTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let progressError: Error | undefined;
	let outputError: Error | undefined;
	let outputBackpressure: Promise<void> | undefined;
	let retainOutput = false;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const failOutput = (error: unknown): void => {
		outputError = error instanceof Error ? error : new Error(String(error));
		combinedController.abort(outputError);
	};
	const accumulator = new OutputAccumulator({ onError: failOutput });

	const details = (): ExecutorBashToolDetails => {
		const snapshot = accumulator.snapshot();
		return {
			truncation: snapshot.truncation,
			...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
		};
	};
	const currentResult = (): BashToolResult => {
		const snapshot = accumulator.snapshot();
		let output = snapshot.output;
		if (snapshot.truncation.truncated) {
			const omittedLines = Math.max(
				0,
				snapshot.truncation.totalLines - snapshot.truncation.outputLines,
			);
			output = `[${omittedLines} earlier lines omitted]\n${output}`;
		}
		if (snapshot.fullOutputPath) {
			output += `\n\nFull output: ${snapshot.fullOutputPath}`;
		}
		return { content: [textContent(output)], details: details() };
	};
	const emitProgress = (): void => {
		progressTimer = undefined;
		if (combinedController.signal.aborted) {
			return;
		}
		try {
			options.onProgress?.(currentResult());
		} catch (error) {
			progressError = error instanceof Error ? error : new Error("Failed to deliver bash progress");
			combinedController.abort(progressError);
		}
	};
	const scheduleProgress = (): void => {
		if (!progressTimer && !combinedController.signal.aborted) {
			progressTimer = setTimeout(emitProgress, progressThrottleMs);
		}
	};
	const pauseForBackpressure = (): void => {
		child.stdout.pause();
		child.stderr.pause();
		if (!outputBackpressure) {
			outputBackpressure = accumulator.waitForDrain().then(
				() => {
					outputBackpressure = undefined;
					if (!combinedController.signal.aborted) {
						child.stdout.resume();
						child.stderr.resume();
					}
				},
				(error: unknown) => {
					outputBackpressure = undefined;
					failOutput(error);
				},
			);
		}
	};
	const append = (decoder: StringDecoder, chunk: Buffer): void => {
		try {
			const accepted = accumulator.append(sanitizeProcessOutput(decoder.write(chunk)));
			accumulator.throwIfFailed();
			if (!accepted) {
				pauseForBackpressure();
			}
			scheduleProgress();
		} catch (error) {
			failOutput(error);
		}
	};
	child.stdout.on("data", (chunk: Buffer) => append(stdoutDecoder, chunk));
	child.stderr.on("data", (chunk: Buffer) => append(stderrDecoder, chunk));

	const timeoutController = new AbortController();
	const abortForTimeout = (): void => {
		timedOut = true;
		timeoutController.abort(new Error(`Command timed out after ${timeoutSeconds} seconds`));
	};
	timeoutTimer = setTimeout(abortForTimeout, timeoutSeconds * 1_000);

	const forwardAbort = (signal: AbortSignal): void => {
		combinedController.abort(signal.reason);
	};
	const externalAbort = (): void => {
		if (options.signal) {
			forwardAbort(options.signal);
		}
	};
	const timeoutAbort = (): void => forwardAbort(timeoutController.signal);
	options.signal?.addEventListener("abort", externalAbort, { once: true });
	timeoutController.signal.addEventListener("abort", timeoutAbort, { once: true });
	if (options.signal?.aborted) {
		externalAbort();
	}

	try {
		const processResult = await waitForProcess(child, combinedController.signal).catch(
			(error: unknown) => {
				if (timedOut) {
					return { exitCode: null, signal: null };
				}
				if (progressError) {
					throw progressError;
				}
				if (outputError) {
					throw outputError;
				}
				throw error;
			},
		);
		await outputBackpressure;
		accumulator.append(sanitizeProcessOutput(stdoutDecoder.end()));
		accumulator.append(sanitizeProcessOutput(stderrDecoder.end()));
		await accumulator.close();
		const result = currentResult();
		if (timedOut) {
			retainOutput = true;
			throw new Error(
				`${result.content[0].text ? `${result.content[0].text}\n\n` : ""}Command timed out after ${timeoutSeconds} seconds`,
			);
		}
		if (processResult.exitCode !== 0 && processResult.exitCode !== null) {
			retainOutput = true;
			throw new Error(
				`${result.content[0].text ? `${result.content[0].text}\n\n` : ""}Command exited with code ${processResult.exitCode}`,
			);
		}
		retainOutput = true;
		return result;
	} catch (error) {
		if (outputError) {
			await accumulator.close().catch(() => undefined);
			const result = currentResult();
			retainOutput = !accumulator.hasStorageFailure();
			throw new Error(
				`${result.content[0].text ? `${result.content[0].text}\n\n` : ""}${outputError.message}`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (progressTimer) {
			clearTimeout(progressTimer);
		}
		options.signal?.removeEventListener("abort", externalAbort);
		timeoutController.signal.removeEventListener("abort", timeoutAbort);
		if (retainOutput && !accumulator.hasStorageFailure()) {
			await accumulator.close().catch((error: unknown) => {
				if (outputError === undefined) {
					throw error;
				}
			});
		} else {
			await accumulator.discard().catch((error: unknown) => {
				if (outputError === undefined) {
					throw error;
				}
			});
		}
	}
}
