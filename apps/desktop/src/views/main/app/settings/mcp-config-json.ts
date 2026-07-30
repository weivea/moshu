import {
	mcpSecretInputSchema,
	mcpTransportConfigSchema,
	type McpSecretInput,
	type McpTransportConfig,
} from "@moshu/contracts";

const maxJsonBytes = 2 * 1024 * 1024;
const maxImportedServers = 64;

export type McpConfigJsonErrorCode =
	| "empty"
	| "invalid-json"
	| "invalid-root"
	| "invalid-server"
	| "too-large"
	| "too-many";

export class McpConfigJsonError extends Error {
	constructor(readonly code: McpConfigJsonErrorCode) {
		super(`MCP JSON import failed: ${code}`);
		this.name = "McpConfigJsonError";
	}
}

export interface ImportedMcpServer {
	displayName: string;
	enabled: boolean;
	transport: McpTransportConfig;
	secret?: McpSecretInput;
}

export function getImportedMcpServerKey(server: ImportedMcpServer): string {
	return canonicalJson(server);
}

export function parseMcpConfigJson(input: string): ImportedMcpServer[] {
	if (input.trim().length === 0) {
		throw new McpConfigJsonError("empty");
	}
	if (new TextEncoder().encode(input).byteLength > maxJsonBytes) {
		throw new McpConfigJsonError("too-large");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		throw new McpConfigJsonError("invalid-json");
	}
	const root = asRecord(parsed, "invalid-root");
	const entries = readServerEntries(root);
	if (entries.length === 0) {
		throw new McpConfigJsonError("empty");
	}
	if (entries.length > maxImportedServers) {
		throw new McpConfigJsonError("too-many");
	}
	try {
		return entries.map(([entryName, value]) => parseServer(entryName, value));
	} catch (error) {
		if (error instanceof McpConfigJsonError) {
			throw error;
		}
		throw new McpConfigJsonError("invalid-server");
	}
}

function readServerEntries(root: Record<string, unknown>): Array<[string, unknown]> {
	for (const key of ["mcpServers", "servers"] as const) {
		if (root[key] !== undefined) {
			return Object.entries(asRecord(root[key], "invalid-root"));
		}
	}
	if (looksLikeServer(root)) {
		const displayName = readOptionalString(root.displayName) ?? readOptionalString(root.name);
		return [[displayName ?? "Imported MCP", root]];
	}
	throw new McpConfigJsonError("invalid-root");
}

function parseServer(entryName: string, value: unknown): ImportedMcpServer {
	const config = asRecord(value, "invalid-server");
	const transportSource =
		config.transport === undefined ? config : asRecord(config.transport, "invalid-server");
	const displayName = (
		readOptionalString(config.displayName) ??
		readOptionalString(config.name) ??
		entryName
	).trim();
	if (displayName.length === 0 || displayName.length > 128) {
		throw new McpConfigJsonError("invalid-server");
	}
	const secretSource =
		config.secret === undefined ? undefined : asRecord(config.secret, "invalid-server");
	const environment = readOptionalStringMap(
		readFirstPresent([config, "env"], [config, "environment"], [secretSource, "environment"]),
	);
	const headers = readOptionalStringMap(
		readFirstPresent([config, "headers"], [transportSource, "headers"], [secretSource, "headers"]),
	);
	const secret =
		environment === undefined && headers === undefined
			? undefined
			: mcpSecretInputSchema.parse({
					...(environment === undefined ? {} : { environment }),
					...(headers === undefined ? {} : { headers }),
				});
	const command = readOptionalString(
		readFirstPresent([transportSource, "command"], [config, "command"]),
	);
	const url = readOptionalString(readFirstPresent([transportSource, "url"], [config, "url"]));
	const rawType = readOptionalString(
		readFirstPresent([transportSource, "type"], [config, "type"]),
	)?.toLowerCase();
	if (
		rawType !== undefined &&
		rawType !== "stdio" &&
		rawType !== "streamable-http" &&
		rawType !== "http" &&
		rawType !== "sse"
	) {
		throw new McpConfigJsonError("invalid-server");
	}
	if (command !== undefined && url !== undefined) {
		throw new McpConfigJsonError("invalid-server");
	}
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		throw new McpConfigJsonError("invalid-server");
	}
	if (config.disabled !== undefined && typeof config.disabled !== "boolean") {
		throw new McpConfigJsonError("invalid-server");
	}
	if (
		typeof config.enabled === "boolean" &&
		typeof config.disabled === "boolean" &&
		config.enabled === config.disabled
	) {
		throw new McpConfigJsonError("invalid-server");
	}
	let transport: McpTransportConfig;
	if (command !== undefined || rawType === "stdio") {
		if (command === undefined || (rawType !== undefined && rawType !== "stdio")) {
			throw new McpConfigJsonError("invalid-server");
		}
		transport = mcpTransportConfigSchema.parse({
			type: "stdio",
			command,
			args: readStringArray(readFirstPresent([transportSource, "args"], [config, "args"])),
			...(readOptionalString(readFirstPresent([transportSource, "cwd"], [config, "cwd"])) ===
			undefined
				? {}
				: {
						cwd: readOptionalString(readFirstPresent([transportSource, "cwd"], [config, "cwd"])),
					}),
			startupTimeoutMs: readTimeout(
				readFirstPresent([transportSource, "startupTimeoutMs"], [config, "startupTimeoutMs"]),
				30_000,
			),
		});
	} else {
		if (url === undefined) {
			throw new McpConfigJsonError("invalid-server");
		}
		const type = rawType === "sse" ? "sse" : "streamable-http";
		transport = mcpTransportConfigSchema.parse({
			type,
			url,
			timeoutMs: readTimeout(
				readFirstPresent([transportSource, "timeoutMs"], [config, "timeoutMs"]),
				30_000,
			),
		});
	}
	return {
		displayName,
		enabled:
			typeof config.enabled === "boolean"
				? config.enabled
				: typeof config.disabled === "boolean"
					? !config.disabled
					: true,
		transport,
		...(secret === undefined ? {} : { secret }),
	};
}

function looksLikeServer(value: Record<string, unknown>): boolean {
	if (typeof value.command === "string" || typeof value.url === "string") {
		return true;
	}
	return (
		isRecord(value.transport) &&
		(typeof value.transport.command === "string" || typeof value.transport.url === "string")
	);
}

function asRecord(
	value: unknown,
	code: Extract<McpConfigJsonErrorCode, "invalid-root" | "invalid-server">,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new McpConfigJsonError(code);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new McpConfigJsonError("invalid-server");
	}
	return value;
}

function readStringArray(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new McpConfigJsonError("invalid-server");
	}
	return value;
}

function readOptionalStringMap(value: unknown): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	const record = asRecord(value, "invalid-server");
	if (Object.values(record).some((item) => typeof item !== "string")) {
		throw new McpConfigJsonError("invalid-server");
	}
	return record as Record<string, string>;
}

function readTimeout(value: unknown, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new McpConfigJsonError("invalid-server");
	}
	return value;
}

function readFirstPresent(
	...candidates: Array<[Record<string, unknown> | undefined, string]>
): unknown {
	for (const [record, key] of candidates) {
		if (record !== undefined && Object.hasOwn(record, key)) {
			return record[key];
		}
	}
	return undefined;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
