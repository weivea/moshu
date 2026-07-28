import type { ExecutorReadToolArguments, ExecutorToolTruncation } from "@moshu/contracts";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { detectImageMime, MAX_IMAGE_INPUT_BYTES, processImage } from "./image.ts";
import { resolveReadPath } from "./path-utils.ts";
import type { ReadToolResult } from "./tool-result.ts";
import { textContent, throwIfAborted } from "./tool-result.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";

interface StreamedTextRange {
	content: string;
	reachedEndOfFile: boolean;
	totalFileLines: number;
	firstSelectedLineBytes: number;
	truncation: ExecutorToolTruncation;
}

async function readTextRange(
	filePath: string,
	offset: number,
	limit: number,
	signal?: AbortSignal,
): Promise<StreamedTextRange> {
	const outputLines: Buffer[] = [];
	let currentLineChunks: Buffer[] = [];
	let currentLineBytes = 0;
	let currentLineNumber = 1;
	let selectedLines = 0;
	let selectedBytes = 0;
	let outputBytes = 0;
	let firstSelectedLineBytes = 0;
	let truncatedBy: "lines" | "bytes" | null = null;
	let firstLineExceedsLimit = false;
	let stopReading = false;

	const currentLineIsSelected = (): boolean => currentLineNumber >= offset && selectedLines < limit;
	const retainCurrentLine = (): boolean =>
		currentLineIsSelected() &&
		truncatedBy === null &&
		outputLines.length < DEFAULT_MAX_LINES &&
		currentLineBytes <= DEFAULT_MAX_BYTES - outputBytes - (outputLines.length === 0 ? 0 : 1);
	const appendSegment = (segment: Buffer): void => {
		if (segment.length === 0) {
			return;
		}
		currentLineBytes += segment.length;
		if (retainCurrentLine()) {
			currentLineChunks.push(segment);
		} else {
			currentLineChunks = [];
		}
	};
	const finishLine = (terminatedByNewline: boolean): void => {
		if (currentLineIsSelected()) {
			const separatorBytes = selectedLines === 0 ? 0 : 1;
			selectedBytes += separatorBytes + currentLineBytes;
			if (selectedLines === 0) {
				firstSelectedLineBytes = currentLineBytes;
			}
			selectedLines += 1;
			if (truncatedBy === null) {
				if (outputLines.length >= DEFAULT_MAX_LINES) {
					truncatedBy = "lines";
					currentLineChunks = [];
				} else {
					const outputSeparatorBytes = outputLines.length === 0 ? 0 : 1;
					if (currentLineChunks.length === 0 && currentLineBytes > 0) {
						truncatedBy = "bytes";
						firstLineExceedsLimit = outputLines.length === 0;
					} else if (outputBytes + outputSeparatorBytes + currentLineBytes > DEFAULT_MAX_BYTES) {
						truncatedBy = "bytes";
						firstLineExceedsLimit = outputLines.length === 0;
					} else {
						outputLines.push(Buffer.concat(currentLineChunks, currentLineBytes));
						outputBytes += outputSeparatorBytes + currentLineBytes;
					}
				}
			}
		}
		currentLineChunks = [];
		currentLineBytes = 0;
		currentLineNumber += 1;
		stopReading = truncatedBy !== null || (selectedLines >= limit && terminatedByNewline);
	};

	const stream = createReadStream(filePath);
	readChunks: for await (const rawChunk of stream) {
		throwIfAborted(signal);
		const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
		let start = 0;
		for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
			appendSegment(chunk.subarray(start, index));
			finishLine(true);
			start = index + 1;
			if (stopReading) {
				break readChunks;
			}
		}
		appendSegment(chunk.subarray(start));
	}
	if (!stopReading) {
		finishLine(false);
	}
	throwIfAborted(signal);

	const content = outputLines.map((line) => line.toString("utf8")).join("\n");
	return {
		content,
		reachedEndOfFile: !stopReading,
		totalFileLines: currentLineNumber - 1,
		firstSelectedLineBytes,
		truncation: {
			content,
			truncated: truncatedBy !== null,
			truncatedBy,
			totalLines: selectedLines,
			totalBytes: selectedBytes,
			outputLines: outputLines.length,
			outputBytes,
			lastLinePartial: false,
			firstLineExceedsLimit,
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		},
	};
}

export async function executeReadTool(
	params: ExecutorReadToolArguments,
	cwd: string,
	signal?: AbortSignal,
): Promise<ReadToolResult> {
	throwIfAborted(signal);
	const filePath = await resolveReadPath(params.path, cwd);
	const fileStat = await stat(filePath);
	if (!fileStat.isFile()) {
		throw new Error(`Path is not a file: ${params.path}`);
	}
	const header = Buffer.alloc(16);
	const file = await open(filePath, "r");
	let headerBytes = 0;
	try {
		const read = await file.read(header, 0, header.length, 0);
		headerBytes = read.bytesRead;
	} finally {
		await file.close();
	}
	const mimeType = detectImageMime(header.subarray(0, headerBytes));
	if (mimeType) {
		if (fileStat.size > MAX_IMAGE_INPUT_BYTES) {
			throw new Error(
				`Image is ${formatSize(fileStat.size)}, which exceeds the ${formatSize(MAX_IMAGE_INPUT_BYTES)} input limit.`,
			);
		}
		const bytes = await readFile(filePath);
		throwIfAborted(signal);
		const image = await processImage(bytes, mimeType);
		throwIfAborted(signal);
		const note = image.wasResized
			? `Read image ${params.path} (${image.originalWidth}x${image.originalHeight}, resized to ${image.width}x${image.height}).`
			: `Read image ${params.path} (${image.width}x${image.height}).`;
		return {
			content: [
				textContent(note),
				{
					type: "image",
					data: image.data,
					mimeType: image.mimeType,
				},
			],
		};
	}

	const offset = params.offset ?? 1;
	const range = await readTextRange(
		filePath,
		offset,
		params.limit ?? Number.MAX_SAFE_INTEGER,
		signal,
	);
	if (offset > range.totalFileLines) {
		throw new Error(
			`Offset ${offset} is beyond the end of the file (${range.totalFileLines} lines)`,
		);
	}
	const truncation = range.truncation;
	if (truncation.firstLineExceedsLimit) {
		throw new Error(
			`Line ${offset} is ${formatSize(range.firstSelectedLineBytes)}, which exceeds the ${formatSize(DEFAULT_MAX_BYTES)} read limit. Use bash with sed/cut to inspect portions of this line.`,
		);
	}

	let output = truncation.content;
	if (truncation.truncated) {
		const nextOffset = offset + truncation.outputLines;
		output += `\n\n[Showing lines ${offset}-${nextOffset - 1}. Use offset=${nextOffset} to continue.]`;
	} else if (offset > 1 || params.limit !== undefined) {
		const lastLine = Math.min(offset + truncation.outputLines - 1, range.totalFileLines);
		output += range.reachedEndOfFile
			? `\n\n[Showing lines ${offset}-${lastLine} of ${range.totalFileLines}.]`
			: `\n\n[More lines remain. Use offset=${lastLine + 1} to continue.]`;
	}
	return {
		content: [textContent(output)],
		details: {
			truncation,
		},
	};
}
