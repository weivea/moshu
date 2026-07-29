import type { ExecutorToolTruncation } from "@moshu/contracts";

export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1_024) {
		return `${bytes}B`;
	}
	if (bytes < 1_024 * 1_024) {
		return `${(bytes / 1_024).toFixed(1)}KB`;
	}
	return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

export function truncateHead(
	content: string,
	options: TruncationOptions = {},
): ExecutorToolTruncation {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let index = 0; index < lines.length && index < maxLines; index += 1) {
		const line = lines[index] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		outputLines.push(line);
		outputBytes += lineBytes;
	}
	if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
		truncatedBy = "lines";
	}
	const output = outputLines.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function truncateTail(
	content: string,
	options: TruncationOptions = {},
): ExecutorToolTruncation {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const outputLines: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let index = lines.length - 1; index >= 0 && outputLines.length < maxLines; index -= 1) {
		const line = lines[index] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + (outputLines.length > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (outputLines.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLines.unshift(truncatedLine);
				outputBytes = Buffer.byteLength(truncatedLine, "utf8");
				lastLinePartial = true;
			}
			break;
		}
		outputLines.unshift(line);
		outputBytes += lineBytes;
	}
	if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
		truncatedBy = "lines";
	}
	const output = outputLines.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

function truncateStringToBytesFromEnd(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) {
		return value;
	}
	let start = buffer.length - maxBytes;
	while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
		start += 1;
	}
	return buffer.subarray(start).toString("utf8");
}

export function truncateLine(
	line: string,
	maxCharacters = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxCharacters) {
		return { text: line, wasTruncated: false };
	}
	return {
		text: `${line.slice(0, maxCharacters)}... [truncated]`,
		wasTruncated: true,
	};
}

export function truncateUtf8FromStart(
	value: string,
	maxBytes: number,
	notice = "\n... [truncated]",
): string {
	const valueBuffer = Buffer.from(value, "utf8");
	if (valueBuffer.length <= maxBytes) {
		return value;
	}
	const noticeBuffer = Buffer.from(notice, "utf8");
	if (noticeBuffer.length > maxBytes) {
		throw new RangeError("The truncation notice exceeds the byte limit");
	}
	let end = maxBytes - noticeBuffer.length;
	while (end > 0 && ((valueBuffer[end] ?? 0) & 0xc0) === 0x80) {
		end -= 1;
	}
	return valueBuffer.subarray(0, end).toString("utf8") + notice;
}

export function truncateUtf8FromEnd(
	value: string,
	maxBytes: number,
	notice = "[earlier content truncated]\n",
): string {
	const valueBuffer = Buffer.from(value, "utf8");
	if (valueBuffer.length <= maxBytes) {
		return value;
	}
	const noticeBuffer = Buffer.from(notice, "utf8");
	if (noticeBuffer.length > maxBytes) {
		throw new RangeError("The truncation notice exceeds the byte limit");
	}
	let start = valueBuffer.length - (maxBytes - noticeBuffer.length);
	while (start < valueBuffer.length && ((valueBuffer[start] ?? 0) & 0xc0) === 0x80) {
		start += 1;
	}
	return notice + valueBuffer.subarray(start).toString("utf8");
}
