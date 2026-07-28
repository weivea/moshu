import type { ExecutorFindToolArguments, ExecutorFindToolDetails } from "@moshu/contracts";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { spawnExecutorProcess, waitForProcess } from "./process-runner.ts";
import type { FindToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

async function isInsideGitRepository(path: string): Promise<boolean> {
	for (let current = path; ; current = dirname(current)) {
		if (await pathExists(join(current, ".git"))) {
			return true;
		}
		const parent = dirname(current);
		if (parent === current) {
			return false;
		}
	}
}

export async function executeFindTool(
	params: ExecutorFindToolArguments,
	cwd: string,
	fdPath: string,
	signal?: AbortSignal,
): Promise<FindToolResult> {
	throwIfAborted(signal);
	const searchPath = resolveToCwd(params.path ?? ".", cwd);
	if (!(await pathExists(searchPath))) {
		throw new Error(`Path not found: ${searchPath}`);
	}
	const effectiveLimit = params.limit ?? 1_000;
	const args = ["--glob", "--color=never", "--hidden"];
	if (!(await isInsideGitRepository(searchPath))) {
		args.push("--no-require-git");
	}
	args.push("--max-results", String(effectiveLimit));
	let pattern = params.pattern;
	if (pattern.includes("/")) {
		args.push("--full-path");
		if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			pattern = `**/${pattern}`;
		}
	}
	args.push("--", pattern, searchPath);

	const child = spawnExecutorProcess(fdPath, args, { cwd });
	const lineReader = createInterface({ input: child.stdout });
	const retainedLines: string[] = [];
	let retainedBytes = 0;
	let totalBytes = 0;
	let resultCount = 0;
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-64 * 1024);
	});
	lineReader.on("line", (line) => {
		const trimmed = line.replace(/\r$/, "").trim();
		if (!trimmed) {
			return;
		}
		resultCount += 1;
		const hadTrailingSlash = trimmed.endsWith("/") || trimmed.endsWith("\\");
		let relativePath = trimmed.startsWith(searchPath)
			? trimmed.slice(searchPath.length + 1)
			: relative(searchPath, trimmed);
		if (hadTrailingSlash && !relativePath.endsWith("/")) {
			relativePath += "/";
		}
		const normalized = relativePath.split(sep).join("/");
		totalBytes += Buffer.byteLength(normalized, "utf8") + (resultCount > 1 ? 1 : 0);
		if (retainedBytes > DEFAULT_MAX_BYTES * 2) {
			return;
		}
		retainedLines.push(normalized);
		retainedBytes += Buffer.byteLength(normalized, "utf8") + (retainedLines.length > 1 ? 1 : 0);
	});
	try {
		const processResult = await waitForProcess(child, signal);
		if (processResult.exitCode !== 0) {
			throw new Error(stderr.trim() || `fd exited with code ${processResult.exitCode}`);
		}
	} finally {
		lineReader.close();
	}

	if (resultCount === 0) {
		return { content: [textContent("No files found matching pattern")] };
	}
	const truncation = truncateHead(retainedLines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: ExecutorFindToolDetails = {};
	const notices: string[] = [];
	if (resultCount >= effectiveLimit) {
		details.resultLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} results limit reached. Increase limit or refine the pattern`);
	}
	if (truncation.truncated || resultCount > retainedLines.length) {
		details.truncation = {
			...truncation,
			truncated: true,
			truncatedBy: "bytes",
			totalLines: resultCount,
			totalBytes,
		};
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const output =
		notices.length === 0 ? truncation.content : `${truncation.content}\n\n[${notices.join(". ")}]`;
	return Object.keys(details).length === 0
		? { content: [textContent(output)] }
		: { content: [textContent(output)], details };
}
