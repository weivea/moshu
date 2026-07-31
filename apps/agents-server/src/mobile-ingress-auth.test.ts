import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimMobilePairingOutputSchema,
	createMobileAuthenticationPayload,
	createMobileServerChallengePayload,
	type MobileChallengeInput,
	type MobileChallengeOutput,
	mobileChallengeOutputSchema,
	mobileDeviceSchema,
	mobilePairingQrPayloadSchema,
	mobilePairingStatusOutputSchema,
} from "@moshu/contracts";
import { type MobilePairingRepository, openAppDatabase } from "@moshu/database";
import { RpcHandlerError } from "@moshu/process-rpc";

import { AgentServerIdentity } from "./agent-server-identity";
import { MobileIngressAuth } from "./mobile-ingress-auth";

const rpcIdentity = {
	role: "agents" as const,
	peerId: "mobile-test-agents",
	instanceId: "mobile-test-agents-1",
	generation: 1,
};
const actionJournalEpoch = "550e8400-e29b-41d4-a716-446655440099";

function createDeviceKey(): { publicKey: string; privateKey: KeyObject } {
	const pair = generateKeyPairSync("ed25519");
	return {
		publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
		privateKey: pair.privateKey,
	};
}

function createAuth(
	directory: string,
	database: ReturnType<typeof openAppDatabase>,
	options: {
		mobileUrl?: string;
		remoteAccessEnabled?: boolean;
		preAuthRequestTimeoutMs?: number;
		maxConcurrentPreAuthRequests?: number;
	} = {},
): { auth: MobileIngressAuth; identity: AgentServerIdentity } {
	const identity = AgentServerIdentity.open(join(directory, "identity.json"));
	const auth = new MobileIngressAuth({
		pairings: database.mobilePairings,
		identity,
		rpcIdentity,
		actionJournalEpoch,
		getMobilePublicUrl: () => options.mobileUrl,
		isRemoteAccessEnabled: () => options.remoteAccessEnabled ?? true,
		...(options.preAuthRequestTimeoutMs === undefined
			? {}
			: { preAuthRequestTimeoutMs: options.preAuthRequestTimeoutMs }),
		...(options.maxConcurrentPreAuthRequests === undefined
			? {}
			: { maxConcurrentPreAuthRequests: options.maxConcurrentPreAuthRequests }),
	});
	return { auth, identity };
}

describe("MobileIngressAuth", () => {
	test("pairs, mutually authenticates, rejects replay, and honors revocation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-auth-"));
		const database = openAppDatabase(":memory:");
		try {
			const { auth, identity } = createAuth(directory, database, {
				mobileUrl: "https://mobile.example.devtunnels.ms",
			});
			const device = createDeviceKey();
			const pairing = auth.createPairing();

			// The published QR carries only ephemeral pairing material plus the pinned server identity —
			// never a server secret or a long-term token.
			const qr = mobilePairingQrPayloadSchema.parse(pairing.qr);
			expect(qr.pairingId).toBe(pairing.pairingId);
			expect(qr.code).toBe(pairing.code);
			expect(qr.agentServerId).toBe(identity.agentServerId);
			expect(qr.agentServerPublicKey).toBe(identity.publicKey);
			expect(JSON.stringify(qr)).not.toContain("private");

			const claim = claimMobilePairingOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(
						jsonRequest("/mobile-pair/claim", {
							code: pairing.code,
							deviceKeyId: "device-key-1",
							publicKey: device.publicKey,
							displayName: "Jane's iPhone",
							model: "iPhone16,2",
							platform: "ios",
							appVersion: "1.0.0",
						}),
					),
				).json(),
			);

			// The one-time code cannot be replayed to open a second claim.
			await expect(
				auth.handleHttpRequest(
					jsonRequest("/mobile-pair/claim", {
						code: pairing.code,
						deviceKeyId: "device-key-replay",
						publicKey: device.publicKey,
						displayName: "Replay",
						model: "iPhone16,2",
						platform: "ios",
						appVersion: "1.0.0",
					}),
				),
			).resolves.toMatchObject({ status: 400 });

			const [pending] = auth.listPendingClaims().items;
			if (pending === undefined) {
				throw new Error("Expected a pending Mobile pairing claim.");
			}

			// Approving with a mismatched fingerprint is rejected (CAS guard against approving the wrong
			// claim).
			expect(() =>
				auth.approve({
					pairingId: claim.pairingId,
					expectedPublicKeyFingerprint: "sha256-not-the-real-fingerprint",
				}),
			).toThrow();

			const approved = auth.approve({
				pairingId: claim.pairingId,
				expectedPublicKeyFingerprint: pending.publicKeyFingerprint,
			});
			const device1 = mobileDeviceSchema.parse(approved.device);
			expect(device1.deviceKeyIds).toEqual(["device-key-1"]);

			const status = mobilePairingStatusOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(
						jsonRequest("/mobile-pair/status", {
							pairingId: claim.pairingId,
							claimToken: claim.claimToken,
						}),
					),
				).json(),
			);
			if (status.status !== "approved") {
				throw new Error("Expected approved Mobile pairing status.");
			}
			expect(status.mobileClientId).toBe(device1.mobileClientId);
			expect(status.agentServerId).toBe(identity.agentServerId);

			const challengeInput: MobileChallengeInput = {
				mobileClientId: device1.mobileClientId,
				deviceKeyId: "device-key-1",
				instanceId: "mobile-instance-1",
				generation: 1,
				protocolVersion: 1,
			};
			const challenge = mobileChallengeOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(jsonRequest("/mobile-auth/challenge", challengeInput)),
				).json(),
			);
			// The challenge is signed by the Agent Server identity over the canonical payload.
			expect(challenge.transportSecurity).toBe("relay-tls");
			expect(challenge.rpcIdentity.role).toBe("agents");

			const upgradeRequest = signedUpgradeRequest(challengeInput, challenge, device.privateKey);
			expect(await auth.authenticate(upgradeRequest, { remoteAddress: "203.0.113.10" })).toEqual({
				role: "mobile-client",
				peerId: device1.mobileClientId,
				instanceId: "mobile-instance-1",
				generation: 1,
				deviceKeyId: "device-key-1",
			});

			// A challenge is single-use: re-presenting the same signature is rejected.
			expect(
				await auth.authenticate(
					signedUpgradeRequest(challengeInput, challenge, device.privateKey),
					{ remoteAddress: "203.0.113.10" },
				),
			).toBeNull();

			// A wrong signature (signed by an unrelated key) is rejected.
			const impostor = createDeviceKey();
			const secondChallenge = mobileChallengeOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(
						jsonRequest("/mobile-auth/challenge", {
							...challengeInput,
							instanceId: "mobile-instance-2",
							generation: 2,
						}),
					),
				).json(),
			);
			expect(
				await auth.authenticate(
					signedUpgradeRequest(
						{ ...challengeInput, instanceId: "mobile-instance-2", generation: 2 },
						secondChallenge,
						impostor.privateKey,
					),
					{ remoteAddress: "203.0.113.10" },
				),
			).toBeNull();
			// Revoking the device closes the door: even a freshly signed, valid challenge no longer
			// authenticates.
			const revokeChallenge = mobileChallengeOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(
						jsonRequest("/mobile-auth/challenge", {
							...challengeInput,
							instanceId: "mobile-instance-3",
							generation: 3,
						}),
					),
				).json(),
			);
			expect(
				auth.revokeDevice({
					mobileClientId: device1.mobileClientId,
					deviceKeyId: "device-key-1",
				}),
			).toEqual({ revoked: true });
			expect(
				await auth.authenticate(
					signedUpgradeRequest(
						{ ...challengeInput, instanceId: "mobile-instance-3", generation: 3 },
						revokeChallenge,
						device.privateKey,
					),
					{ remoteAddress: "203.0.113.10" },
				),
			).toBeNull();
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("fails closed without creating a pairing until the Mobile ingress has a public URL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-noqr-"));
		const database = openAppDatabase(":memory:");
		try {
			// Count create() calls so we can prove a not-ready pairing consumes no durable state.
			let createCalls = 0;
			const realPairings = database.mobilePairings;
			const countingPairings: MobilePairingRepository = {
				create: (input) => {
					createCalls += 1;
					return realPairings.create(input);
				},
				claim: (input) => realPairings.claim(input),
				listPendingClaims: () => realPairings.listPendingClaims(),
				approve: (pairingId, fingerprint) => realPairings.approve(pairingId, fingerprint),
				reject: (pairingId) => realPairings.reject(pairingId),
				getStatus: (pairingId, hash) => realPairings.getStatus(pairingId, hash),
				listActiveDeviceKeys: (mobileClientId) => realPairings.listActiveDeviceKeys(mobileClientId),
				getActiveDeviceKey: (mobileClientId, keyId) =>
					realPairings.getActiveDeviceKey(mobileClientId, keyId),
				revokeDeviceKey: (mobileClientId, keyId) =>
					realPairings.revokeDeviceKey(mobileClientId, keyId),
			};
			let mobileUrl: string | undefined;
			const identity = AgentServerIdentity.open(join(directory, "identity.json"));
			const auth = new MobileIngressAuth({
				pairings: countingPairings,
				identity,
				rpcIdentity,
				actionJournalEpoch,
				getMobilePublicUrl: () => mobileUrl,
				isRemoteAccessEnabled: () => true,
			});

			// Not ready: refuses with a stable code and never touches the pairing store.
			let thrown: unknown;
			try {
				auth.createPairing();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(RpcHandlerError);
			expect((thrown as RpcHandlerError).code).toBe("MOBILE_INGRESS_NOT_READY");
			expect(createCalls).toBe(0);
			expect(auth.listPendingClaims().items).toHaveLength(0);

			// Once the ingress is exposed, the very next create succeeds and publishes a full QR.
			mobileUrl = "https://mobile.example.devtunnels.ms";
			const pairing = auth.createPairing();
			expect(createCalls).toBe(1);
			expect(pairing.mobileUrl).toBe(mobileUrl);
			const qr = mobilePairingQrPayloadSchema.parse(pairing.qr);
			expect(qr.mobileUrl).toBe(mobileUrl);
			expect(qr.code).toBe(pairing.code);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses to create a pairing while Remote Access is disabling even if the URL is still live", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-disable-"));
		const database = openAppDatabase(":memory:");
		try {
			// Count create() calls so we can prove the disable-transition window consumes no durable state.
			let createCalls = 0;
			const realPairings = database.mobilePairings;
			const countingPairings: MobilePairingRepository = {
				create: (input) => {
					createCalls += 1;
					return realPairings.create(input);
				},
				claim: (input) => realPairings.claim(input),
				listPendingClaims: () => realPairings.listPendingClaims(),
				approve: (pairingId, fingerprint) => realPairings.approve(pairingId, fingerprint),
				reject: (pairingId) => realPairings.reject(pairingId),
				getStatus: (pairingId, hash) => realPairings.getStatus(pairingId, hash),
				listActiveDeviceKeys: (mobileClientId) => realPairings.listActiveDeviceKeys(mobileClientId),
				getActiveDeviceKey: (mobileClientId, keyId) =>
					realPairings.getActiveDeviceKey(mobileClientId, keyId),
				revokeDeviceKey: (mobileClientId, keyId) =>
					realPairings.revokeDeviceKey(mobileClientId, keyId),
			};
			// Mirror the create-agents-server providers over a DevTunnel-like state: getMobilePublicUrl
			// reflects ingress readiness/URL, isRemoteAccessEnabled reflects the persisted enabled flag.
			const tunnel = {
				enabled: true,
				ready: true,
				publicUrl: "https://mobile.example.devtunnels.ms" as string | undefined,
			};
			const identity = AgentServerIdentity.open(join(directory, "identity.json"));
			const auth = new MobileIngressAuth({
				pairings: countingPairings,
				identity,
				rpcIdentity,
				actionJournalEpoch,
				getMobilePublicUrl: () => (tunnel.ready ? tunnel.publicUrl : undefined),
				isRemoteAccessEnabled: () => tunnel.enabled,
			});

			const expectRefused = () => {
				let thrown: unknown;
				try {
					auth.createPairing();
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(RpcHandlerError);
				expect((thrown as RpcHandlerError).code).toBe("MOBILE_INGRESS_NOT_READY");
			};

			// Online: a pairing can be created and its QR embeds the live URL.
			const firstPairing = auth.createPairing();
			expect(createCalls).toBe(1);
			expect(firstPairing.mobileUrl).toBe(tunnel.publicUrl);

			// disable() persists enabled=false first, but the async stop has not cleared readiness/URL yet.
			tunnel.enabled = false;
			expectRefused();
			expect(createCalls).toBe(1);
			expect(auth.listPendingClaims().items).toHaveLength(0);

			// Stop completes: readiness and URL fall away — still refused, still no durable state.
			tunnel.ready = false;
			tunnel.publicUrl = undefined;
			expectRefused();
			expect(createCalls).toBe(1);
			expect(auth.listPendingClaims().items).toHaveLength(0);

			// Re-enable and re-expose: creation works again and mints exactly one new pairing.
			tunnel.enabled = true;
			tunnel.ready = true;
			tunnel.publicUrl = "https://mobile-2.example.devtunnels.ms";
			const secondPairing = auth.createPairing();
			expect(createCalls).toBe(2);
			expect(secondPairing.mobileUrl).toBe(tunnel.publicUrl);
			const qr = mobilePairingQrPayloadSchema.parse(secondPairing.qr);
			expect(qr.mobileUrl).toBe(tunnel.publicUrl);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects incompatible protocol versions with a stateless upgrade signal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-upgrade-"));
		const database = openAppDatabase(":memory:");
		try {
			const { auth } = createAuth(directory, database);
			const response = requireResponse(
				await auth.handleHttpRequest(
					jsonRequest("/mobile-auth/challenge", {
						mobileClientId: "some-device",
						deviceKeyId: "device-key-1",
						instanceId: "mobile-instance-1",
						generation: 1,
						protocolVersion: 999,
					}),
				),
			);
			expect(response.status).toBe(426);
			expect(await response.json()).toMatchObject({ error: "MOBILE_UPGRADE_REQUIRED" });
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("returns uniform errors and applies per-endpoint rate limits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-rate-"));
		const database = openAppDatabase(":memory:");
		try {
			const { auth } = createAuth(directory, database);
			for (let index = 0; index < 60; index += 1) {
				expect(
					(
						await auth.handleHttpRequest(jsonRequest("/mobile-pair/claim", { invalid: index }), {
							remoteAddress: "203.0.113.10",
						})
					)?.status,
				).toBe(400);
			}
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/mobile-pair/claim", {}), {
						remoteAddress: "203.0.113.10",
					})
				)?.status,
			).toBe(429);
			// A different source is still served — the limit is per-source, not global-only.
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/mobile-pair/claim", {}), {
						remoteAddress: "203.0.113.11",
					})
				)?.status,
			).toBe(400);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("caps concurrent pre-auth requests and times out slow bodies", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-ingress-timeout-"));
		const database = openAppDatabase(":memory:");
		try {
			const { auth } = createAuth(directory, database, {
				preAuthRequestTimeoutMs: 5,
				maxConcurrentPreAuthRequests: 1,
			});
			const slow = new Request("http://127.0.0.1/mobile-pair/claim", {
				method: "POST",
				body: new ReadableStream<Uint8Array>({}),
			});
			const first = auth.handleHttpRequest(slow, { remoteAddress: "203.0.113.10" });
			await Bun.sleep(0);
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/mobile-pair/claim", {}), {
						remoteAddress: "203.0.113.11",
					})
				)?.status,
			).toBe(429);
			expect((await first)?.status).toBe(400);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function jsonRequest(pathname: string, body: unknown): Request {
	return new Request(`http://127.0.0.1${pathname}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function signedUpgradeRequest(
	input: MobileChallengeInput,
	challenge: MobileChallengeOutput,
	privateKey: KeyObject,
): Request {
	const { signature: _signature, ...unsigned } = challenge;
	const payload = createMobileAuthenticationPayload(input, unsigned);
	const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
	// Sanity-check the canonical server-challenge payload is distinct from the client-auth payload.
	expect(createMobileServerChallengePayload(input, unsigned)).not.toBe(payload);
	return new Request("http://127.0.0.1/mobile", {
		headers: {
			"x-moshu-mobile-client-id": input.mobileClientId,
			"x-moshu-device-key-id": input.deviceKeyId,
			"x-moshu-instance-id": input.instanceId,
			"x-moshu-generation": String(input.generation),
			"x-moshu-protocol-version": String(input.protocolVersion),
			"x-moshu-challenge-id": challenge.challengeId,
			"x-moshu-signature": signature,
		},
	});
}

function requireResponse(response: Response | undefined): Response {
	if (response === undefined) {
		throw new Error("Mobile ingress did not handle the request.");
	}
	return response;
}
