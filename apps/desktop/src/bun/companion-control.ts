export const COMPANION_BOOTSTRAP_CHANNEL = "moshu-companion-bootstrap";
export const COMPANION_CONTROL_VERSION = 0;
export const MAX_COMPANION_CONTROL_RECORD_BYTES = 4096;

export type CompanionRole = "agents-server" | "executor";

export interface AgentsServerReadyRecord {
	channel: typeof COMPANION_BOOTSTRAP_CHANNEL;
	controlVersion: typeof COMPANION_CONTROL_VERSION;
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

export interface ExecutorReadyRecord {
	channel: typeof COMPANION_BOOTSTRAP_CHANNEL;
	controlVersion: typeof COMPANION_CONTROL_VERSION;
	type: "READY";
	role: "executor";
	pid: number;
	processVersion: string;
	nonce: string;
	agentsServer: {
		host: "127.0.0.1";
		port: number;
		nonce: string;
	};
}

export type CompanionReadyRecord = AgentsServerReadyRecord | ExecutorReadyRecord;

export type ReadyRecordExpectation =
	| {
			role: "agents-server";
			pid: number;
			nonce: string;
	  }
	| {
			role: "executor";
			pid: number;
			nonce: string;
			agentsServer: AgentsServerReadyRecord;
	  };

export async function readCompanionReadyRecord(
	stream: ReadableStream<Uint8Array>,
	expectation: ReadyRecordExpectation,
): Promise<CompanionReadyRecord> {
	const reader = stream.getReader();
	const bytes: number[] = [];

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				throw new Error("Companion stdout closed before a READY control record.");
			}

			for (let index = 0; index < result.value.byteLength; index += 1) {
				const byte = result.value[index];
				if (byte === undefined) {
					continue;
				}
				bytes.push(byte);
				if (bytes.length > MAX_COMPANION_CONTROL_RECORD_BYTES) {
					throw new Error("READY control record exceeds the byte limit.");
				}

				if (byte === 0x0a) {
					if (index !== result.value.byteLength - 1) {
						throw new Error("Companion emitted data after its READY control record.");
					}
					const input = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
					return parseCompanionReadyRecord(input, expectation);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function parseCompanionReadyRecord(
	input: string,
	expectation: ReadyRecordExpectation,
): CompanionReadyRecord {
	const parsed = parseControlObject(input);
	const channel = parsed.channel;
	const controlVersion = parsed.controlVersion;
	const type = parsed.type;
	const role = parsed.role;
	const pid = parsed.pid;
	const processVersion = parsed.processVersion;
	const nonce = parsed.nonce;

	if (
		channel !== COMPANION_BOOTSTRAP_CHANNEL ||
		controlVersion !== COMPANION_CONTROL_VERSION ||
		type !== "READY" ||
		role !== expectation.role ||
		pid !== expectation.pid ||
		!isPid(pid) ||
		!isProcessVersion(processVersion) ||
		nonce !== expectation.nonce ||
		!isNonce(nonce)
	) {
		throw new Error(`Invalid ${expectation.role} READY control record.`);
	}

	if (expectation.role === "agents-server") {
		const endpoint = parsed.endpoint;
		if (!isObject(endpoint) || endpoint.host !== "127.0.0.1" || !isPort(endpoint.port)) {
			throw new Error("Invalid agents-server READY control record.");
		}

		return {
			channel: COMPANION_BOOTSTRAP_CHANNEL,
			controlVersion: COMPANION_CONTROL_VERSION,
			type: "READY",
			role: "agents-server",
			pid,
			processVersion,
			nonce,
			endpoint: {
				host: "127.0.0.1",
				port: endpoint.port,
			},
		};
	}

	const agentsServer = parsed.agentsServer;
	if (
		!isObject(agentsServer) ||
		agentsServer.host !== expectation.agentsServer.endpoint.host ||
		agentsServer.port !== expectation.agentsServer.endpoint.port ||
		agentsServer.nonce !== expectation.agentsServer.nonce
	) {
		throw new Error("Invalid executor READY control record.");
	}

	return {
		channel: COMPANION_BOOTSTRAP_CHANNEL,
		controlVersion: COMPANION_CONTROL_VERSION,
		type: "READY",
		role: "executor",
		pid,
		processVersion,
		nonce,
		agentsServer: {
			host: expectation.agentsServer.endpoint.host,
			port: expectation.agentsServer.endpoint.port,
			nonce: expectation.agentsServer.nonce,
		},
	};
}

export function serializeAgentsServerBootstrap(nonce: string): Uint8Array {
	return serializeControlRecord({
		channel: COMPANION_BOOTSTRAP_CHANNEL,
		controlVersion: COMPANION_CONTROL_VERSION,
		type: "START",
		role: "agents-server",
		nonce,
	});
}

export function serializeExecutorBootstrap(
	nonce: string,
	agentsServer: AgentsServerReadyRecord,
): Uint8Array {
	return serializeControlRecord({
		channel: COMPANION_BOOTSTRAP_CHANNEL,
		controlVersion: COMPANION_CONTROL_VERSION,
		type: "START",
		role: "executor",
		nonce,
		agentsServer,
	});
}

function serializeControlRecord(record: object): Uint8Array {
	const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
	if (bytes.byteLength > MAX_COMPANION_CONTROL_RECORD_BYTES) {
		throw new Error("Bootstrap control record exceeds the byte limit.");
	}
	return bytes;
}

function parseControlObject(input: string): Record<string, unknown> {
	if (new TextEncoder().encode(input).byteLength > MAX_COMPANION_CONTROL_RECORD_BYTES) {
		throw new Error("READY control record exceeds the byte limit.");
	}

	const withoutLineFeed = input.endsWith("\n") ? input.slice(0, -1) : input;
	const record = withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
	if (record.length === 0 || record.includes("\n") || record.includes("\r")) {
		throw new Error("Expected exactly one READY control record.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(record);
	} catch {
		throw new Error("READY control record is not valid JSON.");
	}
	if (!isObject(parsed)) {
		throw new Error("READY control record must be an object.");
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

function isPid(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isPort(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isProcessVersion(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 64;
}
