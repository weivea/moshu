import {
	chmodSync,
	createWriteStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	type WriteStream,
} from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.ts";

const outputDirectory = join(
	tmpdir(),
	`moshu-executor-tool-output-${process.getuid?.() ?? "user"}`,
);
const retainedOutputAgeMs = 24 * 60 * 60 * 1_000;
export const MAX_RETAINED_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_RETAINED_OUTPUT_BYTES = 256 * 1024 * 1024;

function ensurePrivateOutputDirectory(): void {
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(outputDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Executor output path is not a regular directory: ${outputDirectory}`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && metadata.uid !== currentUid) {
		throw new Error(`Executor output directory is owned by another user: ${outputDirectory}`);
	}
	if (process.platform !== "win32") {
		chmodSync(outputDirectory, 0o700);
	}
}

ensurePrivateOutputDirectory();
let totalRetainedOutputBytes = readdirSync(outputDirectory, { withFileTypes: true }).reduce(
	(total, entry) =>
		entry.isFile() ? total + lstatSync(join(outputDirectory, entry.name)).size : total,
	0,
);

function reserveRetainedOutput(bytes: number): void {
	if (totalRetainedOutputBytes + bytes > MAX_TOTAL_RETAINED_OUTPUT_BYTES) {
		throw new Error(
			`Executor retained-output directory would exceed its ${MAX_TOTAL_RETAINED_OUTPUT_BYTES}-byte quota`,
		);
	}
	totalRetainedOutputBytes += bytes;
}

function releaseRetainedOutput(bytes: number): void {
	totalRetainedOutputBytes = Math.max(0, totalRetainedOutputBytes - bytes);
}

export async function pruneExecutorToolOutputFiles(): Promise<void> {
	ensurePrivateOutputDirectory();
	const cutoff = Date.now() - retainedOutputAgeMs;
	const entries = await readdir(outputDirectory, { withFileTypes: true });
	await Promise.all(
		entries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const path = join(outputDirectory, entry.name);
				const fileStat = await stat(path);
				if (fileStat.mtimeMs < cutoff) {
					await unlink(path);
					releaseRetainedOutput(fileStat.size);
				}
			}),
	);
}

export class OutputAccumulator {
	private tail = "";
	private totalBytes = 0;
	private totalLines = 0;
	private stream: WriteStream | undefined;
	private outputPath: string | undefined;
	private retainedFileBytes = 0;
	private closed = false;
	private drainPromise: Promise<void> | undefined;
	private streamError: Error | undefined;
	private hasOutput = false;
	private endsWithNewline = false;

	constructor(
		private readonly options: {
			maxRetainedBytes?: number;
			onError?: (error: Error) => void;
		} = {},
	) {}

	private recordStreamError(error: unknown): Error {
		const normalized = error instanceof Error ? error : new Error(String(error));
		if (this.streamError === undefined) {
			this.streamError = normalized;
			this.options.onError?.(normalized);
		}
		return normalized;
	}

	append(chunk: string): boolean {
		if (chunk.length === 0) {
			return true;
		}
		if (this.closed) {
			throw new Error("Cannot append to a closed output accumulator");
		}
		if (this.streamError) {
			throw this.streamError;
		}
		const chunkBytes = Buffer.byteLength(chunk, "utf8");
		const maxRetainedBytes = this.options.maxRetainedBytes ?? MAX_RETAINED_OUTPUT_BYTES;
		if (this.totalBytes + chunkBytes > maxRetainedBytes) {
			throw new Error(`Command output exceeded the ${maxRetainedBytes}-byte retained-output limit`);
		}
		const nextTotalBytes = this.totalBytes + chunkBytes;
		const nextTotalLines = this.totalLines + (chunk.match(/\n/g) ?? []).length;
		const nextEndsWithNewline = chunk.endsWith("\n");
		const logicalLines = nextTotalLines + (nextEndsWithNewline ? 0 : 1);
		const startsRetention =
			!this.stream && (nextTotalBytes > DEFAULT_MAX_BYTES || logicalLines > DEFAULT_MAX_LINES);
		const reservationBytes =
			(this.stream ? chunkBytes : 0) +
			(startsRetention ? Buffer.byteLength(this.tail, "utf8") + chunkBytes : 0);
		if (reservationBytes > 0) {
			reserveRetainedOutput(reservationBytes);
			this.retainedFileBytes += reservationBytes;
		}
		this.totalBytes = nextTotalBytes;
		this.totalLines = nextTotalLines;
		this.hasOutput = true;
		this.endsWithNewline = nextEndsWithNewline;
		if (startsRetention) {
			this.outputPath = join(outputDirectory, `bash-${Date.now()}-${randomUUID()}.log`);
			try {
				this.stream = createWriteStream(this.outputPath, {
					encoding: "utf8",
					flags: "wx",
					mode: 0o600,
				});
				this.stream.on("error", (error) => {
					this.recordStreamError(error);
				});
				if (!this.stream.write(this.tail)) {
					this.ensureDrainPromise();
				}
			} catch (error) {
				if (this.stream === undefined) {
					releaseRetainedOutput(reservationBytes);
					this.retainedFileBytes -= reservationBytes;
					this.outputPath = undefined;
					throw error;
				}
				throw this.recordStreamError(error);
			}
		}
		let accepted: boolean;
		try {
			accepted = this.stream?.write(chunk) ?? true;
		} catch (error) {
			throw this.recordStreamError(error);
		}
		if (!accepted) {
			this.ensureDrainPromise();
		}
		this.tail = truncateTail(this.tail + chunk).content;
		return accepted && this.drainPromise === undefined;
	}

	private ensureDrainPromise(): void {
		if (!this.stream || this.drainPromise) {
			return;
		}
		const stream = this.stream;
		this.drainPromise = new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				stream.removeListener("drain", handleDrain);
				stream.removeListener("error", handleError);
				this.drainPromise = undefined;
			};
			const handleDrain = (): void => {
				cleanup();
				resolve();
			};
			const handleError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			stream.once("drain", handleDrain);
			stream.once("error", handleError);
		});
	}

	waitForDrain(): Promise<void> {
		if (this.streamError) {
			return Promise.reject(this.streamError);
		}
		return this.drainPromise ?? Promise.resolve();
	}

	throwIfFailed(): void {
		if (this.streamError) {
			throw this.streamError;
		}
	}

	hasStorageFailure(): boolean {
		return this.streamError !== undefined;
	}

	snapshot(): {
		output: string;
		truncation: ReturnType<typeof truncateTail>;
		fullOutputPath?: string;
	} {
		const tailTruncation = truncateTail(this.tail);
		const totalLines = this.totalLines + (this.hasOutput && !this.endsWithNewline ? 1 : 0);
		const truncatedBy =
			this.totalBytes > DEFAULT_MAX_BYTES
				? "bytes"
				: totalLines > DEFAULT_MAX_LINES
					? "lines"
					: tailTruncation.truncatedBy;
		const truncation = {
			...tailTruncation,
			totalLines,
			totalBytes: this.totalBytes,
			truncated: truncatedBy !== null,
			truncatedBy,
		};
		const result = {
			output: truncation.content,
			truncation,
		};
		return this.outputPath === undefined || this.streamError !== undefined
			? result
			: { ...result, fullOutputPath: this.outputPath };
	}

	async close(): Promise<void> {
		if (this.closed) {
			await this.waitForDrain();
			this.throwIfFailed();
			return;
		}
		this.closed = true;
		if (!this.stream) {
			return;
		}
		await this.waitForDrain();
		this.throwIfFailed();
		await new Promise<void>((resolve, reject) => {
			const stream = this.stream;
			if (!stream) {
				resolve();
				return;
			}
			stream.once("error", reject);
			stream.end(resolve);
		});
		this.throwIfFailed();
	}

	async discard(): Promise<void> {
		let closeError: unknown;
		try {
			await this.close();
		} catch (error) {
			closeError = error;
		}
		if (closeError !== undefined && this.stream && !this.stream.closed) {
			await new Promise<void>((resolve) => {
				this.stream?.once("close", resolve);
				this.stream?.destroy();
			});
		}
		const path = this.outputPath;
		if (path !== undefined) {
			try {
				await unlink(path);
			} catch (error) {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					error.code !== "ENOENT"
				) {
					throw closeError === undefined
						? error
						: new AggregateError(
								[closeError, error],
								"Closing and deleting retained command output both failed",
							);
				}
			}
			releaseRetainedOutput(this.retainedFileBytes);
			this.retainedFileBytes = 0;
			this.outputPath = undefined;
		}
		if (closeError !== undefined) {
			throw closeError;
		}
	}
}
