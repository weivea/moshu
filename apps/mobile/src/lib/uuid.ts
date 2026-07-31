/**
 * RFC 4122 v4 UUID. Prefers the platform `crypto.randomUUID`; falls back to `getRandomValues` for
 * environments (older WebViews, jsdom) that lack it. Used for client-generated idempotency tokens
 * (chat.send requestId, approval idempotencyKey, session createKey) — never for identity/secrets.
 */
export function newUuid(): string {
	const globalCrypto = globalThis.crypto;
	if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
		return globalCrypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	globalCrypto.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < 16; i += 1) {
		hex.push(bytes[i]!.toString(16).padStart(2, "0"));
	}
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
		.slice(6, 8)
		.join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
