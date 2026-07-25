export const BOOTSTRAP_CHANNEL = "moshu-companion-bootstrap";
export const BOOTSTRAP_CONTROL_VERSION = 0;
export const MAX_CONTROL_RECORD_BYTES = 4096;

export interface AgentsServerBootstrapRecord {
	channel: typeof BOOTSTRAP_CHANNEL;
	controlVersion: typeof BOOTSTRAP_CONTROL_VERSION;
	type: "START";
	role: "agents-server";
	nonce: string;
}

export interface AgentsServerReadyRecord {
	channel: typeof BOOTSTRAP_CHANNEL;
	controlVersion: typeof BOOTSTRAP_CONTROL_VERSION;
	type: "READY";
	role: "agents-server";
	pid: number;
	processVersion: string;
	nonce: string;
	endpoint: {
		host: "127.0.0.1";
		port: number;
	};
}

export interface BootstrapControlChannel {
	input: string;
	parentClosed: Promise<void>;
}

export async function openBootstrapControlChannel(
	stream: ReadableStream<Uint8Array>,
): Promise<BootstrapControlChannel> {
	const reader = stream.getReader();
	const bytes: number[] = [];

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				throw new Error("Parent control channel closed before the bootstrap record.");
			}

			for (let index = 0; index < result.value.byteLength; index += 1) {
				const byte = result.value[index];
				if (byte === undefined) {
					continue;
				}
				bytes.push(byte);
				if (bytes.length > MAX_CONTROL_RECORD_BYTES) {
					throw new Error("Bootstrap control record exceeds the byte limit.");
				}
				if (byte === 0x0a) {
					if (index !== result.value.byteLength - 1) {
						throw new Error("Parent sent data after the bootstrap control record.");
					}
					return {
						input: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
						parentClosed: (async () => {
							try {
								while (true) {
									const next = await reader.read();
									if (next.done) {
										return;
									}
									if (next.value.byteLength > 0) {
										throw new Error("Parent sent unexpected data after bootstrap.");
									}
								}
							} finally {
								reader.releaseLock();
							}
						})(),
					};
				}
			}
		}
	} catch (error) {
		reader.releaseLock();
		throw error;
	}
}

export function parseAgentsServerBootstrapRecord(input: string): AgentsServerBootstrapRecord {
	const parsed = parseControlRecord(input);
	if (
		parsed.channel !== BOOTSTRAP_CHANNEL ||
		parsed.controlVersion !== BOOTSTRAP_CONTROL_VERSION ||
		parsed.type !== "START" ||
		parsed.role !== "agents-server" ||
		!isNonce(parsed.nonce)
	) {
		throw new Error("Invalid agents-server bootstrap control record.");
	}

	return {
		channel: BOOTSTRAP_CHANNEL,
		controlVersion: BOOTSTRAP_CONTROL_VERSION,
		type: "START",
		role: "agents-server",
		nonce: parsed.nonce,
	};
}

export function serializeReadyRecord(record: AgentsServerReadyRecord): string {
	const serialized = `${JSON.stringify(record)}\n`;
	if (new TextEncoder().encode(serialized).byteLength > MAX_CONTROL_RECORD_BYTES) {
		throw new Error("READY control record exceeds the byte limit.");
	}
	return serialized;
}

function parseControlRecord(input: string): Record<string, unknown> {
	if (new TextEncoder().encode(input).byteLength > MAX_CONTROL_RECORD_BYTES) {
		throw new Error("Bootstrap control record exceeds the byte limit.");
	}

	const withoutLineFeed = input.endsWith("\n") ? input.slice(0, -1) : input;
	const record = withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
	if (record.length === 0 || record.includes("\n") || record.includes("\r")) {
		throw new Error("Expected exactly one bootstrap control record.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(record);
	} catch {
		throw new Error("Bootstrap control record is not valid JSON.");
	}

	if (!isObject(parsed)) {
		throw new Error("Bootstrap control record must be an object.");
	}
	return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonce(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 128 &&
		/^[A-Za-z0-9._-]+$/.test(value)
	);
}
