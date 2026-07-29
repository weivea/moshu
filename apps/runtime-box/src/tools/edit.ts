import {
	executorEditToolDetailsSchema,
	executorToolTextContentSchema,
	maxExecutorToolEditDetailBytes,
	maxExecutorToolTextContentBytes,
	type ExecutorEditToolArguments,
} from "@moshu/contracts";
import { readFile, stat } from "node:fs/promises";
import { atomicWriteFile } from "./atomic-write.ts";
import {
	applyEditOperations,
	createEditDiff,
	detectLineEnding,
	normalizeToLineFeed,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveReadPath } from "./path-utils.ts";
import type { EditToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";
import { truncateUtf8FromStart } from "./truncate.ts";

export const MAX_EDIT_FILE_BYTES = 16 * 1024 * 1024;

export async function executeEditTool(
	params: ExecutorEditToolArguments,
	cwd: string,
	signal?: AbortSignal,
): Promise<EditToolResult> {
	const filePath = await resolveReadPath(params.path, cwd);
	return withFileMutationQueue(filePath, async (canonicalPath) => {
		throwIfAborted(signal);
		const originalMetadata = await stat(canonicalPath);
		if (originalMetadata.size > MAX_EDIT_FILE_BYTES) {
			throw new Error(
				`Cannot edit ${params.path}: file size ${originalMetadata.size} bytes exceeds the ${MAX_EDIT_FILE_BYTES}-byte edit limit.`,
			);
		}
		const originalBuffer = await readFile(canonicalPath);
		const hasByteOrderMark =
			originalBuffer.length >= 3 &&
			originalBuffer[0] === 0xef &&
			originalBuffer[1] === 0xbb &&
			originalBuffer[2] === 0xbf;
		const rawContent = originalBuffer.subarray(hasByteOrderMark ? 3 : 0).toString("utf8");
		const lineEnding = detectLineEnding(rawContent);
		const normalizedContent = normalizeToLineFeed(rawContent);
		const applied = applyEditOperations(normalizedContent, params.edits, params.path);
		const newContent = restoreLineEndings(applied.content, lineEnding);
		const prefix = hasByteOrderMark ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
		const diff = createEditDiff(params.path, normalizedContent, applied.content);
		const strategyNote = applied.usedFuzzyMatch
			? "\nApplied fuzzy Unicode and whitespace normalization."
			: "";
		const messagePrefix = `Successfully applied ${params.edits.length} edit${params.edits.length === 1 ? "" : "s"} to ${params.path}.${strategyNote}\n\n`;
		const displayDiff = truncateUtf8FromStart(
			diff.displayDiff,
			maxExecutorToolTextContentBytes - Buffer.byteLength(messagePrefix, "utf8"),
			"\n... [edit diff truncated]",
		);
		const result: EditToolResult = {
			content: [textContent(`${messagePrefix}${displayDiff}`)],
			details: {
				diff: truncateUtf8FromStart(
					diff.displayDiff,
					maxExecutorToolEditDetailBytes,
					"\n... [edit diff truncated]",
				),
				patch: truncateUtf8FromStart(
					diff.unifiedPatch,
					maxExecutorToolEditDetailBytes,
					"\n... [edit patch truncated]",
				),
			},
		};
		executorToolTextContentSchema.parse(result.content[0]);
		executorEditToolDetailsSchema.parse(result.details);
		throwIfAborted(signal);
		await atomicWriteFile(canonicalPath, Buffer.concat([prefix, Buffer.from(newContent, "utf8")]), {
			mode: originalMetadata.mode,
			...(signal === undefined ? {} : { signal }),
		});
		return result;
	});
}
