import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimMobilePairingOutputSchema,
	createMobileAuthenticationPayload,
	type MobileChallengeInput,
	type MobileChallengeOutput,
	mobileChallengeOutputSchema,
	mobileClientProductEventMethods,
	mobileClientProductRequestMethods,
	mobileDeviceSchema,
	productRpcMethods,
} from "@moshu/contracts";
import { openAppDatabase } from "@moshu/database";
import {
	connectRpcClient,
	createRpcServer,
	type RpcMethodAllowlist,
	type RpcServer,
} from "@moshu/process-rpc";

import { AgentServerIdentity } from "./agent-server-identity";
import { MobileIngressAuth } from "./mobile-ingress-auth";
import { MobileIngressGenerationFence } from "./mobile-ingress-generation-fence";

const rpcIdentity = {
	role: "agents" as const,
	peerId: "mobile-smoke-agents",
	instanceId: "mobile-smoke-agents-1",
	generation: 1,
};
const actionJournalEpoch = "550e8400-e29b-41d4-a716-446655440099";

// The Mobile ingress shares the process handler map, but a Mobile peer must only ever reach the
// strict MVP allowlist — never the full product surface. This mirror is reconstructed from the
// contract allowlist arrays so the smoke test stays free of the agent-runtime handler wiring.
const mobileAllowlist: RpcMethodAllowlist = {
	"mobile-client": {
		requests: [...mobileClientProductRequestMethods],
		events: [...mobileClientProductEventMethods],
	},
};

function createDeviceKey(): { publicKey: string; privateKey: KeyObject } {
	const pair = generateKeyPairSync("ed25519");
	return {
		publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
		privateKey: pair.privateKey,
	};
}

function signedHandshakeHeaders(
	input: MobileChallengeInput,
	challenge: MobileChallengeOutput,
	privateKey: KeyObject,
): Record<string, string> {
	const { signature: _signature, ...unsigned } = challenge;
	const payload = createMobileAuthenticationPayload(input, unsigned);
	const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
	return {
		"x-moshu-mobile-client-id": input.mobileClientId,
		"x-moshu-device-key-id": input.deviceKeyId,
		"x-moshu-instance-id": input.instanceId,
		"x-moshu-generation": String(input.generation),
		"x-moshu-protocol-version": String(input.protocolVersion),
		"x-moshu-challenge-id": challenge.challengeId,
		"x-moshu-signature": signature,
	};
}

async function requestChallenge(
	server: RpcServer,
	input: MobileChallengeInput,
): Promise<MobileChallengeOutput> {
	const response = await fetch(`http://127.0.0.1:${server.port}/mobile-auth/challenge`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return mobileChallengeOutputSchema.parse(await response.json());
}

describe("Mobile ingress transport smoke", () => {
	test("pairs, connects, enforces the allowlist, fences reconnects, and honors revocation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mobile-smoke-"));
		const database = openAppDatabase(":memory:");
		let server: RpcServer | undefined;
		try {
			const identity = AgentServerIdentity.open(join(directory, "identity.json"));
			const auth = new MobileIngressAuth({
				pairings: database.mobilePairings,
				identity,
				rpcIdentity,
				actionJournalEpoch,
				getMobilePublicUrl: () => "https://mobile.example.devtunnels.ms",
			});
			const fence = new MobileIngressGenerationFence(database.mobileDevices);
			const runtimeGetCalls: string[] = [];
			server = createRpcServer({
				identity: rpcIdentity,
				hostname: "127.0.0.1",
				path: "/mobile",
				maxRequestBodyBytes: 32 * 1024,
				authenticate: auth.authenticate,
				handleHttpRequest: auth.handleHttpRequest,
				acceptedPeerRoles: ["mobile-client"],
				generationFence: fence,
				handlers: {
					requests: {
						[productRpcMethods.runtimeGet]: (_payload, context) => {
							runtimeGetCalls.push(context.remoteIdentity.peerId);
							return { runtimeBoxId: "local", stub: true };
						},
						// A handler exists for a forbidden method, yet the allowlist must still deny it —
						// proving isolation is enforced by policy, not by the absence of a handler.
						[productRpcMethods.providersDelete]: () => ({ deleted: true }),
					},
				},
				methodAllowlist: mobileAllowlist,
			});

			// 1) Desktop mints a pairing; the phone claims it over the pre-auth HTTP endpoint.
			const device = createDeviceKey();
			const pairing = auth.createPairing();
			const claimResponse = await fetch(`http://127.0.0.1:${server.port}/mobile-pair/claim`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					code: pairing.code,
					deviceKeyId: "device-key-1",
					publicKey: device.publicKey,
					displayName: "Jamie's iPhone",
					model: "iPhone16,2",
					platform: "ios",
					appVersion: "1.0.0",
				}),
			});
			const claim = claimMobilePairingOutputSchema.parse(await claimResponse.json());

			// 2) Desktop approves after confirming the fingerprint.
			const [pending] = auth.listPendingClaims().items;
			if (pending === undefined) {
				throw new Error("Expected a pending Mobile pairing claim.");
			}
			const approved = mobileDeviceSchema.parse(
				auth.approve({
					pairingId: claim.pairingId,
					expectedPublicKeyFingerprint: pending.publicKeyFingerprint,
				}).device,
			);

			// 3) The phone requests a signed challenge and completes the WebSocket handshake.
			const challengeInput: MobileChallengeInput = {
				mobileClientId: approved.mobileClientId,
				deviceKeyId: "device-key-1",
				instanceId: "mobile-instance-1",
				generation: 1,
				protocolVersion: 1,
			};
			const challenge = await requestChallenge(server, challengeInput);
			const peer = await connectRpcClient({
				url: server.url,
				identity: {
					role: "mobile-client",
					peerId: approved.mobileClientId,
					instanceId: "mobile-instance-1",
					generation: 1,
					deviceKeyId: "device-key-1",
				},
				expectedServerIdentity: rpcIdentity,
				getHandshakeHeaders: () =>
					signedHandshakeHeaders(challengeInput, challenge, device.privateKey),
			});

			// 4) An allowlisted method succeeds; a forbidden method is denied by policy.
			expect(await peer.request(productRpcMethods.runtimeGet, {})).toEqual({
				runtimeBoxId: "local",
				stub: true,
			});
			expect(runtimeGetCalls).toEqual([approved.mobileClientId]);
			await expect(peer.request(productRpcMethods.providersDelete, {})).rejects.toThrow();

			// 5) A reconnect at a higher generation fences the previous live peer.
			const reconnectInput: MobileChallengeInput = {
				...challengeInput,
				instanceId: "mobile-instance-2",
				generation: 2,
			};
			const reconnectChallenge = await requestChallenge(server, reconnectInput);
			const secondPeer = await connectRpcClient({
				url: server.url,
				identity: {
					role: "mobile-client",
					peerId: approved.mobileClientId,
					instanceId: "mobile-instance-2",
					generation: 2,
					deviceKeyId: "device-key-1",
				},
				expectedServerIdentity: rpcIdentity,
				getHandshakeHeaders: () =>
					signedHandshakeHeaders(reconnectInput, reconnectChallenge, device.privateKey),
			});
			await peer.closed;

			// 6) Revoking the device closes the live peer and blocks any new challenge/upgrade.
			auth.revokeDevice({ mobileClientId: approved.mobileClientId, deviceKeyId: "device-key-1" });
			for (const livePeer of server.peers) {
				if (livePeer.remoteIdentity.peerId === approved.mobileClientId) {
					livePeer.close(1008, "device revoked");
				}
			}
			await secondPeer.closed;

			const revokedInput: MobileChallengeInput = {
				...challengeInput,
				instanceId: "mobile-instance-3",
				generation: 3,
			};
			// The challenge endpoint is anonymous, so it still mints a challenge — but a revoked device
			// can never complete the authenticated WebSocket upgrade.
			const revokedChallenge = await requestChallenge(server, revokedInput);
			await expect(
				connectRpcClient({
					url: server.url,
					identity: {
						role: "mobile-client",
						peerId: approved.mobileClientId,
						instanceId: "mobile-instance-3",
						generation: 3,
						deviceKeyId: "device-key-1",
					},
					expectedServerIdentity: rpcIdentity,
					getHandshakeHeaders: () =>
						signedHandshakeHeaders(revokedInput, revokedChallenge, device.privateKey),
				}),
			).rejects.toThrow();
		} finally {
			server?.stop();
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
