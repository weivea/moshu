import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { MobileDeviceNotFoundError, MobileDeviceRevokedError, openAppDatabase } from "../src";

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret, "ascii").digest("base64url");
}

function fingerprintPublicKey(publicKey: string): string {
	return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}

function seedApprovedDevice(
	database: ReturnType<typeof openAppDatabase>,
	deviceKeyId = "device-key-1",
): string {
	const code = randomBytes(24).toString("base64url");
	const publicKey = generateKeyPairSync("ed25519")
		.publicKey.export({ format: "der", type: "spki" })
		.toString("base64url");
	const fingerprint = fingerprintPublicKey(publicKey);
	const pairingId = randomUUID();
	database.mobilePairings.create({
		id: pairingId,
		codeHash: hashSecret(code),
		expiresAtMs: Date.now() + 300_000,
	});
	database.mobilePairings.claim({
		codeHash: hashSecret(code),
		claimTokenHash: hashSecret(randomBytes(24).toString("base64url")),
		deviceKeyId,
		publicKey,
		publicKeyFingerprint: fingerprint,
		displayName: "Jamie's iPhone",
		model: "iPhone16,2",
		platform: "ios",
		appVersion: "1.0.0",
	});
	return database.mobilePairings.approve(pairingId, fingerprint).mobileClientId;
}

describe("SqliteMobileDeviceRepository", () => {
	test("lists and reads approved devices", () => {
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(database);
			expect(database.mobileDevices.list()).toHaveLength(1);
			const device = database.mobileDevices.get(mobileClientId);
			expect(device.mobileClientId).toBe(mobileClientId);
			expect(device.revoked).toBe(false);
			expect(device.lastSeenAt).toBeUndefined();
		} finally {
			database.close();
		}
	});

	test("throws for an unknown device", () => {
		const database = openAppDatabase(":memory:");
		try {
			expect(() => database.mobileDevices.get("missing")).toThrow(MobileDeviceNotFoundError);
		} finally {
			database.close();
		}
	});

	test("enforces the durable generation fence", () => {
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(database);
			expect(database.mobileDevices.acceptGeneration(mobileClientId, "instance-1", 1)).toEqual({
				accepted: true,
			});
			// The same instance re-accepting its own generation is idempotent.
			expect(database.mobileDevices.acceptGeneration(mobileClientId, "instance-1", 1)).toEqual({
				accepted: true,
			});
			// A parallel connection at the same generation but different instance conflicts.
			expect(database.mobileDevices.acceptGeneration(mobileClientId, "instance-2", 1)).toEqual({
				accepted: false,
				code: "GENERATION_CONFLICT",
				currentGeneration: 1,
			});
			// A newer generation advances the high-water mark.
			expect(database.mobileDevices.acceptGeneration(mobileClientId, "instance-2", 2)).toEqual({
				accepted: true,
			});
			// An older generation is stale and cannot preempt.
			expect(database.mobileDevices.acceptGeneration(mobileClientId, "instance-3", 1)).toEqual({
				accepted: false,
				code: "STALE_GENERATION",
				currentGeneration: 2,
			});
		} finally {
			database.close();
		}
	});

	test("accepting a generation stamps last-seen", () => {
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(database);
			database.mobileDevices.acceptGeneration(mobileClientId, "instance-1", 1);
			expect(database.mobileDevices.get(mobileClientId).lastSeenAt).toBeDefined();
		} finally {
			database.close();
		}
	});

	test("revokes a device and blocks further generation acceptance", () => {
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(database);
			database.mobileDevices.acceptGeneration(mobileClientId, "instance-1", 1);
			database.mobileDevices.revokeDevice(mobileClientId);
			const device = database.mobileDevices.get(mobileClientId);
			expect(device.revoked).toBe(true);
			expect(device.deviceKeyIds).toHaveLength(0);
			expect(() =>
				database.mobileDevices.acceptGeneration(mobileClientId, "instance-2", 2),
			).toThrow(MobileDeviceRevokedError);
		} finally {
			database.close();
		}
	});

	test("rejects malformed generation input", () => {
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(database);
			expect(() =>
				database.mobileDevices.acceptGeneration(mobileClientId, "instance-1", -1),
			).toThrow(TypeError);
			expect(() => database.mobileDevices.acceptGeneration(mobileClientId, "", 1)).toThrow(
				TypeError,
			);
		} finally {
			database.close();
		}
	});
});
