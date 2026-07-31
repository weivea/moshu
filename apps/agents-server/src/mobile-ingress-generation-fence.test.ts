import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "@moshu/database";

import { AgentServerIdentity } from "./agent-server-identity";
import { MobileIngressAuth } from "./mobile-ingress-auth";
import { MobileIngressGenerationFence } from "./mobile-ingress-generation-fence";

const rpcIdentity = {
	role: "agents" as const,
	peerId: "mobile-fence-agents",
	instanceId: "mobile-fence-agents-1",
	generation: 1,
};

function seedApprovedDevice(
	directory: string,
	database: ReturnType<typeof openAppDatabase>,
): string {
	const auth = new MobileIngressAuth({
		pairings: database.mobilePairings,
		identity: AgentServerIdentity.open(join(directory, "identity.json")),
		rpcIdentity,
		actionJournalEpoch: "550e8400-e29b-41d4-a716-446655440099",
		getMobilePublicUrl: () => undefined,
	});
	const publicKey = generateKeyPairSync("ed25519")
		.publicKey.export({ format: "der", type: "spki" })
		.toString("base64url");
	const pairing = auth.createPairing();
	database.mobilePairings.claim({
		codeHash: hashCode(pairing.code),
		claimTokenHash: hashCode("claim-token-seed-1234567890"),
		deviceKeyId: "device-key-1",
		publicKey,
		publicKeyFingerprint: fingerprint(publicKey),
		displayName: "Seed",
		model: "iPhone16,2",
		platform: "ios",
		appVersion: "1.0.0",
	});
	const [pending] = auth.listPendingClaims().items;
	if (pending === undefined) {
		throw new Error("Expected a pending claim.");
	}
	return auth.approve({
		pairingId: pairing.pairingId,
		expectedPublicKeyFingerprint: pending.publicKeyFingerprint,
	}).device.mobileClientId;
}

describe("MobileIngressGenerationFence", () => {
	test("persists the high-water mark, fences a replaced live peer, and rejects downgrades", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-fence-"));
		const database = openAppDatabase(":memory:");
		try {
			const mobileClientId = seedApprovedDevice(directory, database);
			const fence = new MobileIngressGenerationFence(database.mobileDevices);
			const replacements: number[] = [];
			const first = fence.acquire(
				{
					role: "mobile-client",
					peerId: mobileClientId,
					instanceId: "instance-1",
					generation: 1,
				},
				(replacement) => replacements.push(replacement.generation),
			);
			expect(first.accepted).toBe(true);

			// A reconnect at a higher generation fences the previous live peer.
			const second = fence.acquire(
				{
					role: "mobile-client",
					peerId: mobileClientId,
					instanceId: "instance-2",
					generation: 2,
				},
				() => undefined,
			);
			expect(second.accepted).toBe(true);
			expect(replacements).toEqual([2]);

			// An old generation can neither preempt nor resurrect the newer one.
			expect(
				fence.acquire(
					{
						role: "mobile-client",
						peerId: mobileClientId,
						instanceId: "stale",
						generation: 1,
					},
					() => undefined,
				),
			).toEqual({ accepted: false, code: "STALE_GENERATION", currentGeneration: 2 });

			// A parallel connection at the same generation but a different instance conflicts.
			expect(
				fence.acquire(
					{
						role: "mobile-client",
						peerId: mobileClientId,
						instanceId: "parallel",
						generation: 2,
					},
					() => undefined,
				),
			).toEqual({ accepted: false, code: "GENERATION_CONFLICT", currentGeneration: 2 });
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("does not affect other roles", () => {
		const database = openAppDatabase(":memory:");
		try {
			const fence = new MobileIngressGenerationFence(database.mobileDevices);
			const result = fence.acquire(
				{
					role: "client",
					peerId: "desktop-1",
					instanceId: "desktop-instance-1",
					generation: 1,
				},
				() => undefined,
			);
			expect(result.accepted).toBe(true);
		} finally {
			database.close();
		}
	});
});

function hashCode(secret: string): string {
	return createHash("sha256").update(secret, "ascii").digest("base64url");
}

function fingerprint(publicKey: string): string {
	return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}
