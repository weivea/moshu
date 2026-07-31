/**
 * Generates the shared canonical signing test vectors consumed by BOTH the TypeScript (Vitest) and
 * the Swift (XCTest) test suites. The whole point is byte-for-byte parity: the payload strings are
 * produced HERE from the real `@moshu/contracts` builders, then both languages re-derive them and
 * assert equality. The committed signatures are node/OpenSSL Ed25519 (deterministic, RFC 8032); the
 * Swift suite verifies them to prove cross-implementation interop. Note that Apple CryptoKit produces
 * randomized (still RFC 8032-valid) signatures, so Swift asserts *verification*, not byte-equality, of
 * signatures — only the PAYLOAD bytes are asserted equal across languages.
 *
 * Run with: `bun run apps/mobile/scripts/gen-canonical-vectors.ts`
 *
 * The seed is a fixed, human-readable 32-byte ASCII string — it is a TEST key only and never used
 * by the app; the real device key is generated on-device and never leaves the Keychain.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMobileAuthenticationPayload,
	createMobileServerChallengePayload,
	type MobileChallengeInput,
	type MobileChallengeOutput,
} from "@moshu/contracts";

type ChallengeMinusSignature = Omit<MobileChallengeOutput, "signature">;

const SEED_TEXT = "Moshu mobile test vector seed 01";
const seed = Buffer.from(SEED_TEXT, "utf8");
if (seed.length !== 32) {
	throw new Error(`Seed must be exactly 32 bytes, got ${seed.length}`);
}

// Wrap the raw 32-byte Ed25519 seed in the fixed PKCS#8 prefix so node:crypto can import it.
const pkcs8 = Buffer.concat([
	Buffer.from("302e020100300506032b657004220420", "hex"),
	seed,
]);
const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);
const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
const rawPublicKey = spkiDer.subarray(spkiDer.length - 32);

function base64url(bytes: Buffer): string {
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signPayload(payload: string): string {
	// Ed25519 in node uses a null digest algorithm and produces a deterministic 64-byte signature.
	return base64url(sign(null, Buffer.from(payload, "utf8"), privateKey));
}

interface VectorInput {
	readonly name: string;
	readonly input: MobileChallengeInput;
	readonly challenge: ChallengeMinusSignature;
}

const vectorInputs: VectorInput[] = [
	{
		name: "generation-zero",
		input: {
			mobileClientId: "mobile-client-01",
			deviceKeyId: "device-key-01",
			instanceId: "instance-aaaaaaaa-0000-4000-8000-000000000001",
			generation: 0,
			protocolVersion: 1,
		},
		challenge: {
			challengeId: "11111111-1111-4111-8111-111111111111",
			nonce: "Zm9vYmFyZm9vYmFyZm9vYmFy",
			expiresAt: "2025-01-01T00:00:30.000Z",
			agentServerId: "22222222-2222-4222-8222-222222222222",
			rpcIdentity: {
				role: "agents",
				peerId: "agents-peer-01",
				instanceId: "agents-instance-01",
				generation: 7,
			},
			actionJournalEpoch: "33333333-3333-4333-8333-333333333333",
			negotiatedProtocolVersion: 1,
			transportSecurity: "relay-tls",
			supportedTransportSecurity: ["relay-tls", "noise-xx"],
		},
	},
	{
		name: "generation-nonzero",
		input: {
			mobileClientId: "mobile-client-02",
			deviceKeyId: "device-key-02",
			instanceId: "instance-bbbbbbbb-0000-4000-8000-000000000002",
			generation: 42,
			protocolVersion: 1,
		},
		challenge: {
			challengeId: "44444444-4444-4444-8444-444444444444",
			nonce: "YmF6cXV4YmF6cXV4YmF6cXV4",
			expiresAt: "2025-06-15T12:34:56.000Z",
			agentServerId: "55555555-5555-4555-8555-555555555555",
			rpcIdentity: {
				role: "agents",
				peerId: "agents-peer-02",
				instanceId: "agents-instance-02",
				generation: 9,
			},
			actionJournalEpoch: "66666666-6666-4666-8666-666666666666",
			negotiatedProtocolVersion: 1,
			transportSecurity: "relay-tls",
			supportedTransportSecurity: ["relay-tls"],
		},
	},
];

const vectors = vectorInputs.map((vector) => {
	const serverChallengePayload = createMobileServerChallengePayload(vector.input, vector.challenge);
	const authenticationPayload = createMobileAuthenticationPayload(vector.input, vector.challenge);
	return {
		name: vector.name,
		input: vector.input,
		challenge: vector.challenge,
		serverChallengePayload,
		authenticationPayload,
		serverChallengePayloadSignature: signPayload(serverChallengePayload),
		authenticationPayloadSignature: signPayload(authenticationPayload),
	};
});

const fixture = {
	description:
		"Canonical Mobile signing test vectors. Generated from @moshu/contracts by " +
		"apps/mobile/scripts/gen-canonical-vectors.ts. Payload strings are asserted byte-for-byte " +
		"identical in both Vitest and Swift XCTest; signatures are node/OpenSSL Ed25519 that Swift " +
		"verifies (CryptoKit signatures are randomized, so only payloads are byte-compared).",
	serverChallengeTag: "moshu-mobile-server-challenge-v1",
	authenticationTag: "moshu-mobile-authentication-v1",
	deviceKey: {
		note: "TEST-ONLY Ed25519 key. The real device key is generated on-device and never leaves the Keychain.",
		seedUtf8: SEED_TEXT,
		seedHex: seed.toString("hex"),
		rawPublicKeyHex: rawPublicKey.toString("hex"),
		spkiDerHex: spkiDer.toString("hex"),
		spkiDerBase64Url: base64url(spkiDer),
	},
	vectors,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(
	here,
	"../native/MoshuMobile/Tests/MoshuMobileCoreTests/Fixtures/mobile-canonical-vectors.json",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, "\t")}\n`, "utf8");
console.log(`Wrote ${vectors.length} vectors to ${outPath}`);
