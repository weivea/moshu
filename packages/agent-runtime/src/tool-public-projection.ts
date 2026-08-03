import {
	type ChatToolIdentity,
	type ToolPublicPayload,
	toolPublicPayloadSchema,
} from "@moshu/contracts";
import { isAbsolute, relative } from "node:path";

const sensitiveKeyPattern =
	/(?:^|[_-])(api[_-]?key|auth|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i;
const highSignalSecretPatterns = [
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
] as const;

export const maxToolPublicInputBytes = 64 * 1024;
export const maxToolPublicProgressBytes = 32 * 1024;
export const maxToolPublicOutputBytes = 256 * 1024;

interface RedactionState {
	count: number;
	rootDirectory?: string;
	secretValues: readonly string[];
}

export interface ToolPublicProjectionOptions {
	rootDirectory?: string;
	secretValues?: readonly string[];
}

export function projectToolInput(
	tool: ChatToolIdentity,
	value: unknown,
	options: ToolPublicProjectionOptions = {},
): ToolPublicPayload {
	return projectToolPayload(
		tool,
		normalizeToolInput(tool, value),
		maxToolPublicInputBytes,
		options,
	);
}

export function projectToolProgress(
	tool: ChatToolIdentity,
	value: unknown,
	options: ToolPublicProjectionOptions = {},
): ToolPublicPayload {
	return projectToolPayload(
		tool,
		normalizeToolProgress(tool, value),
		maxToolPublicProgressBytes,
		options,
	);
}

export function projectToolOutput(
	tool: ChatToolIdentity,
	value: unknown,
	options: ToolPublicProjectionOptions = {},
): ToolPublicPayload {
	return projectToolPayload(
		tool,
		normalizeToolOutput(tool, value),
		maxToolPublicOutputBytes,
		options,
	);
}

export function summarizeToolCall(tool: ChatToolIdentity, input: ToolPublicPayload): string {
	if (tool.kind === "mcp") {
		return tool.name;
	}
	const value = input.value;
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	switch (tool.name) {
		case "read":
			return `Read ${readSummaryValue(record?.path)}`;
		case "grep":
		case "find":
			return `Search ${readSummaryValue(record?.pattern)}`;
		case "ls":
			return `List ${readSummaryValue(record?.path)}`;
		case "edit":
			return `Edit ${readSummaryValue(record?.path)}`;
		case "write":
			return `Write ${readSummaryValue(record?.path)}`;
		case "bash":
			return `Run ${readSummaryValue(record?.command)}`;
	}
}

function projectToolPayload(
	_tool: ChatToolIdentity,
	value: unknown,
	maxBytes: number,
	options: ToolPublicProjectionOptions,
): ToolPublicPayload {
	try {
		const state: RedactionState = {
			count: 0,
			secretValues: normalizeSecretValues(options.secretValues),
			...(options.rootDirectory === undefined ? {} : { rootDirectory: options.rootDirectory }),
		};
		const sanitized = sanitizeJson(value, state, undefined);
		const serialized = JSON.stringify(sanitized);
		const originalBytes = new TextEncoder().encode(serialized).byteLength;
		if (originalBytes <= maxBytes) {
			return toolPublicPayloadSchema.parse({
				format: typeof sanitized === "string" ? "text" : "json",
				value: sanitized,
				truncated: false,
				redactionCount: state.count,
			});
		}
		return toolPublicPayloadSchema.parse({
			format: "text",
			value: truncateUtf8(serialized, maxBytes),
			truncated: true,
			originalBytes,
			redactionCount: state.count,
		});
	} catch {
		return toolPublicPayloadSchema.parse({
			format: "text",
			value: "[redaction failed]",
			truncated: false,
			redactionCount: 1,
		});
	}
}

function normalizeToolInput(tool: ChatToolIdentity, value: unknown): unknown {
	if (tool.kind !== "builtin" || (tool.name !== "edit" && tool.name !== "write")) {
		return value;
	}
	const input =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const path = typeof input?.path === "string" ? input.path : undefined;
	switch (tool.name) {
		case "edit":
			return {
				...(path === undefined ? {} : { path }),
				edits: { count: Array.isArray(input?.edits) ? input.edits.length : 0 },
			};
		case "write":
			return {
				...(path === undefined ? {} : { path }),
				content: {
					bytes:
						typeof input?.content === "string"
							? new TextEncoder().encode(input.content).byteLength
							: 0,
				},
			};
	}
}

function sanitizeJson(value: unknown, state: RedactionState, key: string | undefined): unknown {
	if (key !== undefined && sensitiveKeyPattern.test(normalizeKey(key))) {
		state.count += 1;
		return "[redacted]";
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		return sanitizeString(value, state, key);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeJson(entry, state, undefined));
	}
	if (typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			const sanitizedKey = sanitizeString(entryKey, state, undefined);
			sanitized[sanitizedKey] = sanitizeJson(entryValue, state, entryKey);
		}
		return sanitized;
	}
	return String(value);
}

function sanitizeString(value: string, state: RedactionState, key: string | undefined): string {
	let sanitized = value;
	if (key === "path" && state.rootDirectory !== undefined && isAbsolute(sanitized)) {
		const child = relative(state.rootDirectory, sanitized);
		if (child !== "" && !child.startsWith("..") && !isAbsolute(child)) {
			sanitized = child;
		}
	}
	if (key === "command") {
		sanitized = sanitized.replace(
			/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|AUTH)[A-Za-z0-9_]*)=([^\s]+)/gi,
			(_match, name: string) => {
				state.count += 1;
				return `${name}=[redacted]`;
			},
		);
	}
	for (const secret of state.secretValues) {
		const occurrences = sanitized.split(secret).length - 1;
		if (occurrences > 0) {
			state.count += occurrences;
			sanitized = sanitized.split(secret).join("[redacted]");
		}
	}
	for (const pattern of highSignalSecretPatterns) {
		sanitized = sanitized.replace(pattern, () => {
			state.count += 1;
			return "[redacted]";
		});
	}
	return sanitized;
}

function normalizeKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeSecretValues(values: readonly string[] | undefined): readonly string[] {
	if (values === undefined) {
		return [];
	}
	return [...new Set(values.filter((value) => value.length > 0))].sort(
		(left, right) => right.length - left.length,
	);
}

function normalizeToolOutput(tool: ChatToolIdentity, value: unknown): unknown {
	if (tool.kind !== "builtin" || (tool.name !== "edit" && tool.name !== "write")) {
		return value;
	}
	const encodedBytes = new TextEncoder().encode(safeSerialize(value)).byteLength;
	if (tool.name === "write") {
		return {
			summary: "File write completed.",
			resultBytes: encodedBytes,
		};
	}
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const details =
		typeof record?.details === "object" && record.details !== null && !Array.isArray(record.details)
			? (record.details as Record<string, unknown>)
			: undefined;
	const diff = typeof details?.diff === "string" ? details.diff : undefined;
	const firstChangedLine =
		typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;
	return {
		summary: "File edit completed.",
		resultBytes: encodedBytes,
		...(diff === undefined ? {} : { changedLineCount: countChangedDiffLines(diff) }),
		...(firstChangedLine === undefined ? {} : { firstChangedLine }),
	};
}

function normalizeToolProgress(tool: ChatToolIdentity, value: unknown): unknown {
	if (tool.kind !== "builtin" || (tool.name !== "edit" && tool.name !== "write")) {
		return value;
	}
	return {
		summary: tool.name === "edit" ? "File edit in progress." : "File write in progress.",
		progressBytes: new TextEncoder().encode(safeSerialize(value)).byteLength,
	};
}

function countChangedDiffLines(diff: string): number {
	return diff
		.split(/\r?\n/)
		.filter(
			(line) =>
				(line.startsWith("+") && !line.startsWith("+++")) ||
				(line.startsWith("-") && !line.startsWith("---")),
		).length;
}

function safeSerialize(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function truncateUtf8(value: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= maxBytes) {
		return value;
	}
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes - 3) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return `${value.slice(0, low)}...`;
}

function readSummaryValue(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		return "tool";
	}
	return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}
