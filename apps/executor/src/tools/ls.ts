import type { ExecutorLsToolArguments, ExecutorLsToolDetails } from "@moshu/contracts";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveToCwd } from "./path-utils.ts";
import type { LsToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

export async function executeLsTool(
	params: ExecutorLsToolArguments,
	cwd: string,
	signal?: AbortSignal,
): Promise<LsToolResult> {
	throwIfAborted(signal);
	const directoryPath = resolveToCwd(params.path ?? ".", cwd);
	const directoryStat = await stat(directoryPath);
	if (!directoryStat.isDirectory()) {
		throw new Error(`Not a directory: ${directoryPath}`);
	}
	const effectiveLimit = params.limit ?? 500;
	const entries = await readdir(directoryPath);
	entries.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
	const selectedEntries = entries.slice(0, effectiveLimit);
	const results: string[] = [];
	for (const entry of selectedEntries) {
		throwIfAborted(signal);
		const entryStat = await stat(join(directoryPath, entry));
		results.push(entryStat.isDirectory() ? `${entry}/` : entry);
	}
	if (results.length === 0) {
		return { content: [textContent("(empty directory)")] };
	}

	const truncation = truncateHead(results.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: ExecutorLsToolDetails = {};
	const notices: string[] = [];
	if (entries.length > effectiveLimit) {
		details.entryLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} entries limit reached. Increase limit for more`);
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	const output =
		notices.length === 0 ? truncation.content : `${truncation.content}\n\n[${notices.join(". ")}]`;
	return Object.keys(details).length === 0
		? { content: [textContent(output)] }
		: { content: [textContent(output)], details };
}
