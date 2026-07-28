import type { ExecutorWriteToolArguments } from "@moshu/contracts";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import type { WriteToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";

export async function executeWriteTool(
	params: ExecutorWriteToolArguments,
	cwd: string,
	signal?: AbortSignal,
): Promise<WriteToolResult> {
	const filePath = resolveToCwd(params.path, cwd);
	await withFileMutationQueue(filePath, async (canonicalPath) => {
		throwIfAborted(signal);
		await mkdir(dirname(canonicalPath), { recursive: true });
		const existingMode = await stat(canonicalPath).then(
			(metadata) => metadata.mode,
			(error: unknown) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
				) {
					return undefined;
				}
				throw error;
			},
		);
		await atomicWriteFile(canonicalPath, params.content, {
			...(existingMode === undefined ? {} : { mode: existingMode }),
			...(signal === undefined ? {} : { signal }),
		});
	});
	return {
		content: [
			textContent(
				`Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}`,
			),
		],
	};
}
