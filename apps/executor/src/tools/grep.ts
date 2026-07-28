import type { ExecutorGrepToolArguments, ExecutorGrepToolDetails } from "@moshu/contracts";
import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline";
import { resolveToCwd } from "./path-utils.ts";
import { killProcessTree, spawnExecutorProcess, waitForProcess } from "./process-runner.ts";
import type { GrepToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

interface RipgrepOutputLine {
	filePath: string;
	lineNumber: number;
	lineText: string;
	isMatch: boolean;
}

function parseRipgrepOutputLine(line: string): RipgrepOutputLine | undefined {
	const nullIndex = line.indexOf("\0");
	if (nullIndex === -1) {
		return undefined;
	}
	const location = /^(\d+)([:-])(.*)$/.exec(line.slice(nullIndex + 1));
	if (!location?.[1] || !location[2]) {
		throw new Error("ripgrep returned malformed line-oriented output");
	}
	return {
		filePath: line.slice(0, nullIndex),
		lineNumber: Number.parseInt(location[1], 10),
		lineText: location[3] ?? "",
		isMatch: location[2] === ":",
	};
}

export async function executeGrepTool(
	params: ExecutorGrepToolArguments,
	cwd: string,
	ripgrepPath: string,
	signal?: AbortSignal,
): Promise<GrepToolResult> {
	throwIfAborted(signal);
	const searchPath = resolveToCwd(params.path ?? ".", cwd);
	const searchStat = await stat(searchPath);
	const searchIsDirectory = searchStat.isDirectory();
	const effectiveLimit = params.limit ?? 100;
	const contextLines = params.context ?? 0;
	const args = [
		"--line-number",
		"--with-filename",
		"--null",
		"--color=never",
		"--hidden",
		"--max-columns",
		String(GREP_MAX_LINE_LENGTH),
		"--max-columns-preview",
	];
	if (params.ignoreCase) {
		args.push("--ignore-case");
	}
	if (params.literal) {
		args.push("--fixed-strings");
	}
	if (params.glob) {
		args.push("--glob", params.glob);
	}
	if (contextLines > 0) {
		args.push("--context", String(contextLines));
	}
	args.push("--", params.pattern, searchPath);

	const child = spawnExecutorProcess(ripgrepPath, args, { cwd });
	const lineReader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
	const outputLines: string[] = [];
	const retainedOutputLimit = DEFAULT_MAX_BYTES * 2;
	let retainedBytes = 0;
	let observedLines = 0;
	let observedBytes = 0;
	let matchCount = 0;
	let stderr = "";
	let parseError: Error | undefined;
	let stoppedAtLimit = false;
	let stoppedAtOutputLimit = false;
	let linesTruncated = false;
	let pendingContext: RipgrepOutputLine[] = [];
	let pendingContextBytes = 0;
	let pendingContextTruncated = false;
	let stopAfterContext: { filePath: string; lineNumber: number } | undefined;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-64 * 1024);
	});
	const displayPath = (filePath: string): string => {
		if (searchIsDirectory) {
			const relativePath = relative(searchPath, filePath);
			if (relativePath && !relativePath.startsWith("..")) {
				return relativePath.replace(/\\/g, "/");
			}
		}
		return basename(filePath);
	};
	const stopSearch = (): void => {
		if (child.pid !== undefined) {
			void killProcessTree(child.pid);
		}
	};
	const formatOutputLine = (
		parsed: RipgrepOutputLine,
	): { value: string; valueBytes: number; lineWasTruncated: boolean } => {
		const truncated = truncateLine(parsed.lineText);
		const separator = parsed.isMatch ? ":" : "-";
		const value = `${displayPath(parsed.filePath)}${separator}${parsed.lineNumber}${separator} ${truncated.text}`;
		return {
			value,
			valueBytes: Buffer.byteLength(value, "utf8") + 1,
			lineWasTruncated: truncated.wasTruncated,
		};
	};
	const appendOutput = (parsed: RipgrepOutputLine): boolean => {
		const formatted = formatOutputLine(parsed);
		const valueBytes = formatted.valueBytes - (outputLines.length === 0 ? 1 : 0);
		if (retainedBytes + valueBytes > retainedOutputLimit) {
			return false;
		}
		linesTruncated ||= formatted.lineWasTruncated;
		outputLines.push(formatted.value);
		retainedBytes += valueBytes;
		observedLines += 1;
		observedBytes += valueBytes;
		return true;
	};
	const appendPendingContext = (): void => {
		for (const contextLine of pendingContext) {
			if (!appendOutput(contextLine)) {
				stoppedAtOutputLimit = true;
				break;
			}
		}
	};
	lineReader.on("line", (line) => {
		if (stoppedAtOutputLimit || parseError || line.trim().length === 0) {
			return;
		}
		try {
			const parsed = parseRipgrepOutputLine(line);
			if (!parsed) {
				return;
			}
			if (!parsed.isMatch && matchCount === 0) {
				pendingContext.push(parsed);
				pendingContextBytes += formatOutputLine(parsed).valueBytes;
				while (
					pendingContext.length > contextLines ||
					pendingContextBytes > Math.floor(DEFAULT_MAX_BYTES / 2)
				) {
					const removed = pendingContext.shift();
					if (!removed) {
						break;
					}
					pendingContextBytes -= formatOutputLine(removed).valueBytes;
					pendingContextTruncated = true;
				}
				return;
			}
			if (
				stopAfterContext &&
				(parsed.filePath !== stopAfterContext.filePath ||
					(parsed.isMatch && matchCount >= effectiveLimit))
			) {
				stopSearch();
				return;
			}
			if (parsed.isMatch) {
				matchCount += 1;
				appendPendingContext();
				pendingContext = [];
				pendingContextBytes = 0;
				if (!appendOutput(parsed)) {
					stoppedAtOutputLimit = true;
					stopSearch();
					return;
				}
				if (pendingContextTruncated) {
					stoppedAtOutputLimit = true;
					stopSearch();
				}
			} else {
				if (!appendOutput(parsed)) {
					stoppedAtOutputLimit = true;
					stopSearch();
					return;
				}
			}
			if (parsed.isMatch && matchCount >= effectiveLimit) {
				stoppedAtLimit = true;
				if (contextLines === 0) {
					stopSearch();
				} else {
					stopAfterContext = {
						filePath: parsed.filePath,
						lineNumber: parsed.lineNumber + contextLines,
					};
				}
			} else if (
				stopAfterContext &&
				parsed.filePath === stopAfterContext.filePath &&
				parsed.lineNumber >= stopAfterContext.lineNumber
			) {
				stopSearch();
			}
		} catch (error) {
			parseError = error instanceof Error ? error : new Error("Unable to parse ripgrep output");
			stopSearch();
		}
	});

	try {
		const processResult = await waitForProcess(child, signal);
		if (parseError) {
			throw parseError;
		}
		if (
			!stoppedAtLimit &&
			!stoppedAtOutputLimit &&
			processResult.exitCode !== 0 &&
			processResult.exitCode !== 1
		) {
			throw new Error(stderr.trim() || `ripgrep exited with code ${processResult.exitCode}`);
		}
	} finally {
		lineReader.close();
	}

	if (matchCount === 0) {
		return { content: [textContent("No matches found")] };
	}
	throwIfAborted(signal);
	const truncation = truncateHead(outputLines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const notices: string[] = [];
	const details: ExecutorGrepToolDetails = {};
	if (stoppedAtLimit) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached. Increase limit or refine the pattern`);
	}
	if (truncation.truncated || stoppedAtOutputLimit) {
		details.truncation = stoppedAtOutputLimit
			? {
					...truncation,
					truncated: true,
					truncatedBy: "bytes",
					totalLines: observedLines,
					totalBytes: observedBytes,
				}
			: truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push(
			`Some lines truncated to ${GREP_MAX_LINE_LENGTH} characters. Use read for full lines`,
		);
	}
	const output =
		notices.length === 0 ? truncation.content : `${truncation.content}\n\n[${notices.join(". ")}]`;
	return Object.keys(details).length === 0
		? { content: [textContent(output)] }
		: { content: [textContent(output)], details };
}
