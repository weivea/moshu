import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
	MobilePairingFingerprintMismatchError,
	MobilePairingSessionNotFoundError,
	MobilePairingSessionStateError,
	openAppDatabase,
	SqliteMobilePairingRepository,
} from "../src";

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret, "ascii").digest("base64url");
}

function fingerprintPublicKey(publicKey: string): string {
	return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}

function generatePublicKey(): string {
	return generateKeyPairSync("ed25519")
		.publicKey.export({ format: "der", type: "spki" })
		.toString("base64url");
}

interface SeedOptions {
	deviceKeyId?: string;
	publicKey?: string;
	expiresAtMs?: number;
}

function seedClaim(
	database: ReturnType<typeof openAppDatabase>,
	options: SeedOptions = {},
): {
	pairingId: string;
	code: string;
	claimToken: string;
	codeHash: string;
	claimTokenHash: string;
	deviceKeyId: string;
	publicKey: string;
	fingerprint: string;
} {
	const code = randomBytes(24).toString("base64url");
	const claimToken = randomBytes(24).toString("base64url");
	const codeHash = hashSecret(code);
	const claimTokenHash = hashSecret(claimToken);
	const deviceKeyId = options.deviceKeyId ?? "device-key-1";
	const publicKey = options.publicKey ?? generatePublicKey();
	const fingerprint = fingerprintPublicKey(publicKey);
	const pairingId = randomUUID();
	database.mobilePairings.create({
		id: pairingId,
		codeHash,
		expiresAtMs: options.expiresAtMs ?? Date.now() + 300_000,
	});
	database.mobilePairings.claim({
		codeHash,
		claimTokenHash,
		deviceKeyId,
		publicKey,
		publicKeyFingerprint: fingerprint,
		displayName: "Jamie's iPhone",
		model: "iPhone16,2",
		platform: "ios",
		appVersion: "1.0.0",
	});
	return {
		pairingId,
		code,
		claimToken,
		codeHash,
		claimTokenHash,
		deviceKeyId,
		publicKey,
		fingerprint,
	};
}

describe("SqliteMobilePairingRepository", () => {
	test("stores only hashes and exposes a pending claim without leaking the code", () => {
		const database = openAppDatabase(":memory:");
		try {
			const seed = seedClaim(database);
			const claims = database.mobilePairings.listPendingClaims();
			expect(claims).toHaveLength(1);
			const claim = claims[0];
			expect(claim?.pairingId).toBe(seed.pairingId);
			expect(claim?.deviceKeyId).toBe(seed.deviceKeyId);
			expect(claim?.publicKeyFingerprint).toBe(seed.fingerprint);
			// The pending claim projection never exposes the one-time code, claim token, or raw key.
			expect(JSON.stringify(claim)).not.toContain(seed.code);
			expect(JSON.stringify(claim)).not.toContain(seed.claimToken);
			expect(JSON.stringify(claim)).not.toContain(seed.publicKey);
		} finally {
			database.close();
		}
	});

	test("rejects a future-dated requirement and an unknown code", () => {
		const database = openAppDatabase(":memory:");
		try {
			expect(() =>
				database.mobilePairings.create({
					id: randomUUID(),
					codeHash: hashSecret("x"),
					expiresAtMs: Date.now() - 1,
				}),
			).toThrow(TypeError);
			expect(() =>
				database.mobilePairings.claim({
					codeHash: hashSecret("does-not-exist"),
					claimTokenHash: hashSecret("token"),
					deviceKeyId: "device-key-1",
					publicKey: generatePublicKey(),
					publicKeyFingerprint: "abc",
					displayName: "X",
					model: "iPhone",
					platform: "ios",
					appVersion: "1.0.0",
				}),
			).toThrow(MobilePairingSessionNotFoundError);
		} finally {
			database.close();
		}
	});

	test("makes a pairing code single-use", () => {
		const database = openAppDatabase(":memory:");
		try {
			const seed = seedClaim(database);
			expect(() =>
				database.mobilePairings.claim({
					codeHash: seed.codeHash,
					claimTokenHash: hashSecret("second-token"),
					deviceKeyId: "device-key-2",
					publicKey: generatePublicKey(),
					publicKeyFingerprint: "abc",
					displayName: "X",
					model: "iPhone",
					platform: "ios",
					appVersion: "1.0.0",
				}),
			).toThrow(MobilePairingSessionStateError);
		} finally {
			database.close();
		}
	});

	test("treats an expired session as unusable", () => {
		let now = 1_700_000_000_000;
		const database = openAppDatabase(":memory:");
		try {
			const pairings = new SqliteMobilePairingRepository(database.orm, { now: () => now });
			const code = randomBytes(24).toString("base64url");
			const claimToken = randomBytes(24).toString("base64url");
			const publicKey = generatePublicKey();
			const fingerprint = fingerprintPublicKey(publicKey);
			const pairingId = randomUUID();
			pairings.create({ id: pairingId, codeHash: hashSecret(code), expiresAtMs: now + 1_000 });
			pairings.claim({
				codeHash: hashSecret(code),
				claimTokenHash: hashSecret(claimToken),
				deviceKeyId: "device-key-1",
				publicKey,
				publicKeyFingerprint: fingerprint,
				displayName: "X",
				model: "iPhone",
				platform: "ios",
				appVersion: "1.0.0",
			});
			now += 2_000;
			const status = pairings.getStatus(pairingId, hashSecret(claimToken));
			expect(status.status).toBe("expired");
			expect(() => pairings.approve(pairingId, fingerprint)).toThrow(
				MobilePairingSessionStateError,
			);
		} finally {
			database.close();
		}
	});

	test("refuses to approve against a mismatched fingerprint", () => {
		const database = openAppDatabase(":memory:");
		try {
			const seed = seedClaim(database);
			expect(() => database.mobilePairings.approve(seed.pairingId, "not-the-fingerprint")).toThrow(
				MobilePairingFingerprintMismatchError,
			);
			// The session is still pending after the mismatched attempt.
			expect(database.mobilePairings.getStatus(seed.pairingId, seed.claimTokenHash).status).toBe(
				"pending_approval",
			);
		} finally {
			database.close();
		}
	});

	test("approves a claim, materializes a device key, and honors revocation", () => {
		const database = openAppDatabase(":memory:");
		try {
			const seed = seedClaim(database);
			const device = database.mobilePairings.approve(seed.pairingId, seed.fingerprint);
			expect(device.revoked).toBe(false);
			expect(device.deviceKeyIds).toEqual([seed.deviceKeyId]);

			const status = database.mobilePairings.getStatus(seed.pairingId, seed.claimTokenHash);
			expect(status).toEqual({ status: "approved", mobileClientId: device.mobileClientId });

			// A wrong claim token cannot read another device's status.
			expect(() =>
				database.mobilePairings.getStatus(seed.pairingId, hashSecret("wrong-token")),
			).toThrow(MobilePairingSessionNotFoundError);

			const key = database.mobilePairings.getActiveDeviceKey(
				device.mobileClientId,
				seed.deviceKeyId,
			);
			expect(key.publicKey).toBe(seed.publicKey);

			database.mobilePairings.revokeDeviceKey(device.mobileClientId, seed.deviceKeyId);
			expect(() =>
				database.mobilePairings.getActiveDeviceKey(device.mobileClientId, seed.deviceKeyId),
			).toThrow(MobilePairingSessionNotFoundError);
			expect(database.mobilePairings.listActiveDeviceKeys(device.mobileClientId)).toHaveLength(0);
		} finally {
			database.close();
		}
	});

	test("records a rejection decision", () => {
		const database = openAppDatabase(":memory:");
		try {
			const seed = seedClaim(database);
			database.mobilePairings.reject(seed.pairingId);
			expect(database.mobilePairings.getStatus(seed.pairingId, seed.claimTokenHash).status).toBe(
				"rejected",
			);
			expect(database.mobilePairings.listPendingClaims()).toHaveLength(0);
		} finally {
			database.close();
		}
	});
});
