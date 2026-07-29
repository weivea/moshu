import {
	type AgentsServerBootstrapRecord,
	type AgentsServerReadyRecord,
	agentsServerBootstrapRecordSchema,
	agentsServerReadyRecordSchema,
	type CompanionReadyRecord,
	companionBootstrapChannel,
	companionControlVersion,
	type RuntimeBoxBootstrapRecord,
	type RuntimeBoxReadyRecord,
	runtimeBoxBootstrapRecordSchema,
	runtimeBoxReadyRecordSchema,
	maxCompanionControlRecordBytes,
	parseCompanionControlRecord,
	serializeCompanionControlRecord,
} from "@moshu/contracts";

export const COMPANION_BOOTSTRAP_CHANNEL = companionBootstrapChannel;
export const COMPANION_CONTROL_VERSION = companionControlVersion;
export const MAX_COMPANION_CONTROL_RECORD_BYTES = maxCompanionControlRecordBytes;
export type CompanionRole = "agents-server" | "runtime-box";
export type {
	AgentsServerBootstrapRecord,
	AgentsServerReadyRecord,
	CompanionReadyRecord,
	RuntimeBoxBootstrapRecord,
	RuntimeBoxReadyRecord,
};

export type ReadyRecordExpectation =
	| {
			role: "agents-server";
			pid: number;
			nonce: string;
			serverIdentity: AgentsServerReadyRecord["serverIdentity"];
	  }
	| {
			role: "runtime-box";
			pid: number;
			nonce: string;
			identity: RuntimeBoxReadyRecord["identity"];
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
	if (expectation.role === "agents-server") {
		const ready = parseCompanionControlRecord(input, agentsServerReadyRecordSchema, "READY");
		if (
			ready.pid !== expectation.pid ||
			ready.nonce !== expectation.nonce ||
			!sameIdentity(ready.serverIdentity, expectation.serverIdentity)
		) {
			throw new Error("Invalid agents-server READY control record.");
		}
		return ready;
	}
	const ready = parseCompanionControlRecord(input, runtimeBoxReadyRecordSchema, "READY");
	if (
		ready.pid !== expectation.pid ||
		ready.nonce !== expectation.nonce ||
		!sameIdentity(ready.identity, expectation.identity) ||
		!sameIdentity(ready.agentsServer.identity, expectation.agentsServer.serverIdentity) ||
		ready.agentsServer.endpoint.host !== expectation.agentsServer.runtimeEndpoint.host ||
		ready.agentsServer.endpoint.port !== expectation.agentsServer.runtimeEndpoint.port ||
		ready.agentsServer.endpoint.path !== expectation.agentsServer.runtimeEndpoint.path
	) {
		throw new Error("Invalid Runtime Box READY control record.");
	}
	return ready;
}

export function serializeAgentsServerBootstrap(record: AgentsServerBootstrapRecord): Uint8Array {
	return serializeCompanionControlRecord(record, agentsServerBootstrapRecordSchema);
}

export function serializeRuntimeBoxBootstrap(record: RuntimeBoxBootstrapRecord): Uint8Array {
	return serializeCompanionControlRecord(record, runtimeBoxBootstrapRecordSchema);
}

function sameIdentity(
	left: AgentsServerReadyRecord["serverIdentity"],
	right: AgentsServerReadyRecord["serverIdentity"],
): boolean {
	return (
		left.role === right.role &&
		left.peerId === right.peerId &&
		left.instanceId === right.instanceId &&
		left.generation === right.generation
	);
}
