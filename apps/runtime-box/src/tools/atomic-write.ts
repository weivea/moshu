import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function atomicWriteFile(
	filePath: string,
	data: string | Uint8Array,
	options: {
		mode?: number;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const temporaryPath = join(dirname(filePath), `.moshu-${randomUUID()}.tmp`);
	let committed = false;
	let operationError: unknown;
	try {
		await writeFile(temporaryPath, data, {
			flag: "wx",
			...(options.mode === undefined ? {} : { mode: options.mode & 0o777 }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		if (options.mode !== undefined && process.platform !== "win32") {
			await chmod(temporaryPath, options.mode & 0o777);
		}
		options.signal?.throwIfAborted();
		await rename(temporaryPath, filePath);
		committed = true;
	} catch (error) {
		operationError = error;
	}
	if (!committed) {
		try {
			await unlink(temporaryPath);
		} catch (cleanupError) {
			if (!isMissingPathError(cleanupError)) {
				throw operationError === undefined
					? cleanupError
					: new AggregateError(
							[operationError, cleanupError],
							"Atomic write and temporary-file cleanup both failed",
						);
			}
		}
		throw operationError;
	}
}
