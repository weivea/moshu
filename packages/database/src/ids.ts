let lastTimestampMs = 0;
let lastSequence = 0;

function nextSequence(timestampMs: number): { timestampMs: number; sequence: number } {
	if (timestampMs < lastTimestampMs) {
		timestampMs = lastTimestampMs;
	}

	if (timestampMs === lastTimestampMs) {
		lastSequence += 1;
		if (lastSequence > 0x0fff) {
			timestampMs = lastTimestampMs + 1;
			lastSequence = (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) & 0x0fff;
		}
	} else {
		lastTimestampMs = timestampMs;
		lastSequence = (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) & 0x0fff;
	}

	lastTimestampMs = timestampMs;

	return { timestampMs, sequence: lastSequence };
}

function formatUuid(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7(nowMs = Date.now()): string {
	const { timestampMs, sequence } = nextSequence(nowMs);
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const timestamp = BigInt(timestampMs);

	bytes[0] = Number((timestamp >> 40n) & 0xffn);
	bytes[1] = Number((timestamp >> 32n) & 0xffn);
	bytes[2] = Number((timestamp >> 24n) & 0xffn);
	bytes[3] = Number((timestamp >> 16n) & 0xffn);
	bytes[4] = Number((timestamp >> 8n) & 0xffn);
	bytes[5] = Number(timestamp & 0xffn);
	bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f);
	bytes[7] = sequence & 0xff;
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

	return formatUuid(bytes);
}
