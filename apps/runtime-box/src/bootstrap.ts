import {
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

export const BOOTSTRAP_CHANNEL = companionBootstrapChannel;
export const BOOTSTRAP_CONTROL_VERSION = companionControlVersion;
export const MAX_CONTROL_RECORD_BYTES = maxCompanionControlRecordBytes;
export type { RuntimeBoxBootstrapRecord, RuntimeBoxReadyRecord };

export interface BootstrapControlChannel {
	input: string;
	parentClosed: Promise<void>;
	cancelParentMonitor(): Promise<void>;
}

interface ByteStreamReader {
	cancel(reason?: unknown): Promise<void>;
	read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
	releaseLock(): void;
}

export async function openBootstrapControlChannel(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): Promise<BootstrapControlChannel> {
	const reader = stream.getReader();
	const bytes: number[] = [];
	const onAbort = (): void => {
		void reader.cancel("Runtime Box bootstrap was cancelled.").catch(() => undefined);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (isSignalAborted(signal)) {
			await reader.cancel("Runtime Box bootstrap was cancelled.").catch(() => undefined);
			throw getBootstrapAbortError(signal?.reason);
		}
		while (true) {
			const result = await reader.read();
			if (isSignalAborted(signal)) {
				throw getBootstrapAbortError(signal?.reason);
			}
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
					if (isSignalAborted(signal)) {
						throw getBootstrapAbortError(signal?.reason);
					}
					signal?.removeEventListener("abort", onAbort);
					const monitor = createParentClosureMonitor(reader);
					return {
						input: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
						parentClosed: monitor.closed,
						cancelParentMonitor: monitor.cancel,
					};
				}
			}
		}
	} catch (error) {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
		throw error;
	}
}

function getBootstrapAbortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("Runtime Box bootstrap was cancelled.");
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export function parseRuntimeBoxBootstrapRecord(input: string): RuntimeBoxBootstrapRecord {
	return parseCompanionControlRecord(input, runtimeBoxBootstrapRecordSchema, "bootstrap");
}

export function serializeReadyRecord(record: RuntimeBoxReadyRecord): string {
	return new TextDecoder().decode(
		serializeCompanionControlRecord(record, runtimeBoxReadyRecordSchema),
	);
}

function createParentClosureMonitor(reader: ByteStreamReader): {
	closed: Promise<void>;
	cancel(): Promise<void>;
} {
	let cancelled = false;
	let cancelPromise: Promise<void> | undefined;
	const closed = (async () => {
		try {
			while (true) {
				const next = await reader.read();
				if (next.done || cancelled) {
					return;
				}
				if ((next.value?.byteLength ?? 0) > 0) {
					throw new Error("Parent sent unexpected data after bootstrap.");
				}
			}
		} catch (error) {
			if (!cancelled) {
				throw error;
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		closed,
		cancel() {
			if (cancelPromise !== undefined) {
				return cancelPromise;
			}
			cancelled = true;
			cancelPromise = reader
				.cancel("RuntimeBox bootstrap monitor cancelled.")
				.catch(() => undefined)
				.then(() => closed);
			return cancelPromise;
		},
	};
}
