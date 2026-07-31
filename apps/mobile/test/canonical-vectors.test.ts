import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
	createMobileAuthenticationPayload,
	createMobileServerChallengePayload,
	type MobileChallengeInput,
	type MobileChallengeOutput,
} from "@moshu/contracts";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
	here,
	"../native/MoshuMobile/Tests/MoshuMobileCoreTests/Fixtures/mobile-canonical-vectors.json",
);

interface Vector {
	name: string;
	input: MobileChallengeInput;
	challenge: Omit<MobileChallengeOutput, "signature">;
	serverChallengePayload: string;
	authenticationPayload: string;
}

interface Fixture {
	serverChallengeTag: string;
	authenticationTag: string;
	deviceKey: {
		seedUtf8: string;
		seedHex: string;
		rawPublicKeyHex: string;
		spkiDerHex: string;
		spkiDerBase64Url: string;
	};
	vectors: Vector[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("shared canonical vectors", () => {
	it("re-derives every payload byte-for-byte from the contracts", () => {
		expect(fixture.vectors.length).toBeGreaterThan(0);
		for (const vector of fixture.vectors) {
			expect(createMobileServerChallengePayload(vector.input, vector.challenge)).toBe(
				vector.serverChallengePayload,
			);
			expect(createMobileAuthenticationPayload(vector.input, vector.challenge)).toBe(
				vector.authenticationPayload,
			);
		}
	});

	it("embeds the canonical tags at the head of each payload", () => {
		for (const vector of fixture.vectors) {
			expect(vector.serverChallengePayload.startsWith(`["${fixture.serverChallengeTag}"`)).toBe(true);
			expect(vector.authenticationPayload.startsWith(`["${fixture.authenticationTag}"`)).toBe(true);
		}
	});

	it("uses a canonical SPKI-DER Ed25519 public key encoding", () => {
		// 302a300506032b6570 032100 = SPKI header for a 32-byte Ed25519 key.
		expect(fixture.deviceKey.spkiDerHex.startsWith("302a300506032b657003210")).toBe(true);
		expect(fixture.deviceKey.spkiDerHex.endsWith(fixture.deviceKey.rawPublicKeyHex)).toBe(true);
		// base64url: no +, /, or = padding.
		expect(fixture.deviceKey.spkiDerBase64Url).not.toMatch(/[+/=]/);
		const decoded = Buffer.from(
			fixture.deviceKey.spkiDerBase64Url.replace(/-/g, "+").replace(/_/g, "/"),
			"base64",
		);
		expect(decoded.toString("hex")).toBe(fixture.deviceKey.spkiDerHex);
	});

	it("keeps the numeric fields unquoted in the canonical JSON", () => {
		const vector = fixture.vectors[0]!;
		// generation / protocolVersion / negotiatedProtocolVersion are numbers, not strings.
		expect(vector.authenticationPayload).toContain(`,${vector.input.generation},`);
		expect(vector.authenticationPayload).not.toContain(`"${vector.input.generation}"`);
		expect(vector.authenticationPayload).toContain('["relay-tls","noise-xx"]');
	});
});
