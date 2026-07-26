import {
	type AgentsServerBootstrapRecord,
	type AgentsServerReadyRecord,
	agentsServerBootstrapRecordSchema,
	agentsServerReadyRecordSchema,
	companionBootstrapChannel,
	companionControlVersion,
	maxCompanionControlRecordBytes,
	parseCompanionControlRecord,
	serializeCompanionControlRecord,
} from "@moshu/contracts";

export const BOOTSTRAP_CHANNEL = companionBootstrapChannel;
export const BOOTSTRAP_CONTROL_VERSION = companionControlVersion;
export const MAX_CONTROL_RECORD_BYTES = maxCompanionControlRecordBytes;
export type { AgentsServerBootstrapRecord, AgentsServerReadyRecord };

export interface BootstrapControlChannel {
	input: string;
	parentClosed: Promise<void>;
}

interface ByteStreamReader {
	read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
	releaseLock(): void;
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
						parentClosed: monitorParentClosure(reader),
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
	return parseCompanionControlRecord(input, agentsServerBootstrapRecordSchema, "bootstrap");
}

export function serializeReadyRecord(record: AgentsServerReadyRecord): string {
	return new TextDecoder().decode(
		serializeCompanionControlRecord(record, agentsServerReadyRecordSchema),
	);
}

async function monitorParentClosure(reader: ByteStreamReader): Promise<void> {
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				return;
			}
			if ((next.value?.byteLength ?? 0) > 0) {
				throw new Error("Parent sent unexpected data after bootstrap.");
			}
		}
	} finally {
		reader.releaseLock();
	}
}
