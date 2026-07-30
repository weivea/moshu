import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, type KeyObject, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimRuntimeBoxPairingOutputSchema,
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxCompatibilityReportPayload,
	createRuntimeBoxServerChallengePayload,
	defaultLocalRuntimeBoxId,
	runtimeBoxChallengeOutputSchema,
	runtimeBoxCompatibilityReportOutputSchema,
	runtimeBoxPairingStatusOutputSchema,
	type ProcessPeerIdentity,
} from "@moshu/contracts";
import { openAppDatabase } from "@moshu/database";
import { connectRpcClient, createRpcServer, type RpcServer } from "@moshu/process-rpc";

import { AgentServerIdentity } from "./agent-server-identity";
import { RuntimeIngressAuth } from "./runtime-ingress-auth";

const rpcIdentity = {
	role: "agents" as const,
	peerId: "pairing-test-agents",
	instanceId: "pairing-test-agents-1",
	generation: 1,
};
const actionJournalEpoch = "550e8400-e29b-41d4-a716-446655440099";

describe("RuntimeIngressAuth", () => {
	test("returns stateless upgrade-required before issuing an incompatible challenge", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-runtime-upgrade-required-"));
		const database = openAppDatabase(":memory:");
		try {
			const upgrades: string[] = [];
			const auth = new RuntimeIngressAuth({
				pairings: database.runtimeBoxPairings,
				runtimeBoxes: database.runtimeBoxes,
				identity: AgentServerIdentity.open(join(directory, "identity.json")),
				rpcIdentity,
				actionJournalEpoch,
				localAuthenticator: async () => null,
				onUpgradeRequired: (runtimeBoxId) => upgrades.push(runtimeBoxId),
			});
			const response = requireResponse(
				await auth.handleHttpRequest(
					jsonRequest("/runtime-auth/challenge", {
						runtimeBoxId: defaultLocalRuntimeBoxId,
						deviceKeyId: "old-device",
						instanceId: "old-runtime",
						generation: 1,
						protocolVersion: 1,
					}),
				),
			);
			expect(response.status).toBe(426);
			expect(await response.json()).toEqual({
				error: "RUNTIME_BOX_UPGRADE_REQUIRED",
				minProtocolVersion: 2,
				maxProtocolVersion: 2,
			});
			expect(upgrades).toEqual([]);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("pairs, mutually authenticates, rejects replay, and honors revocation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-runtime-ingress-auth-"));
		const database = openAppDatabase(":memory:");
		let server: RpcServer | undefined;
		try {
			const upgrades: string[] = [];
			const identity = AgentServerIdentity.open(join(directory, "identity.json"));
			const auth = new RuntimeIngressAuth({
				pairings: database.runtimeBoxPairings,
				runtimeBoxes: database.runtimeBoxes,
				identity,
				rpcIdentity,
				actionJournalEpoch,
				localAuthenticator: async () => null,
				onUpgradeRequired: (runtimeBoxId) => upgrades.push(runtimeBoxId),
			});
			const device = generateKeyPairSync("ed25519");
			const publicKey = device.publicKey
				.export({ format: "der", type: "spki" })
				.toString("base64url");
			const pairing = auth.createPairing();
			const claimResponse = await auth.handleHttpRequest(
				jsonRequest("/runtime-pair/claim", {
					code: pairing.code,
					deviceKeyId: "device-key-1",
					publicKey,
					displayName: "Remote Linux",
					platform: "linux",
					arch: "x64",
				}),
			);
			const claim = claimRuntimeBoxPairingOutputSchema.parse(
				await requireResponse(claimResponse).json(),
			);
			await expect(
				auth.handleHttpRequest(
					jsonRequest("/runtime-pair/claim", {
						code: pairing.code,
						deviceKeyId: "device-key-replay",
						publicKey,
						displayName: "Replay",
						platform: "linux",
						arch: "x64",
					}),
				),
			).resolves.toMatchObject({ status: 400 });

			const [pending] = auth.listPendingClaims().items;
			if (pending === undefined) {
				throw new Error("Expected a pending Runtime Box pairing claim.");
			}
			const approved = auth.approve({
				pairingId: claim.pairingId,
				expectedPublicKeyFingerprint: pending.publicKeyFingerprint,
			});
			const statusResponse = await auth.handleHttpRequest(
				jsonRequest("/runtime-pair/status", {
					pairingId: claim.pairingId,
					claimToken: claim.claimToken,
				}),
			);
			const status = runtimeBoxPairingStatusOutputSchema.parse(
				await requireResponse(statusResponse).json(),
			);
			if (status.status !== "approved") {
				throw new Error("Expected approved Runtime Box pairing status.");
			}
			expect(status.runtimeBoxId).toBe(approved.runtimeBox.runtimeBoxId);
			expect(status.agentServerId).toBe(identity.agentServerId);

			const compatibility = {
				runtimeBoxId: status.runtimeBoxId,
				deviceKeyId: "device-key-1",
				instanceId: "remote-instance-1",
				generation: 1,
				protocolVersion: 1,
				reportId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
			};
			const compatibilityResponse = requireResponse(
				await auth.handleHttpRequest(
					jsonRequest("/runtime-auth/compatibility", {
						...compatibility,
						signature: sign(
							null,
							Buffer.from(
								createRuntimeBoxCompatibilityReportPayload(identity.agentServerId, compatibility),
								"utf8",
							),
							device.privateKey,
						).toString("base64url"),
					}),
				),
			);
			expect(compatibilityResponse.status).toBe(200);
			expect(
				runtimeBoxCompatibilityReportOutputSchema.parse(await compatibilityResponse.json()),
			).toEqual({
				accepted: true,
				requiredProtocolMinVersion: 2,
				requiredProtocolMaxVersion: 2,
			});
			expect(upgrades).toEqual([status.runtimeBoxId]);
			expect(database.runtimeBoxes.listCompatibility()).toEqual([
				{
					runtimeBoxId: status.runtimeBoxId,
					state: "upgrade_required",
					generation: 1,
					protocolVersion: 1,
				},
			]);
			await expect(
				auth.handleHttpRequest(
					jsonRequest("/runtime-auth/compatibility", {
						...compatibility,
						signature: sign(
							null,
							Buffer.from(
								createRuntimeBoxCompatibilityReportPayload(identity.agentServerId, compatibility),
								"utf8",
							),
							device.privateKey,
						).toString("base64url"),
					}),
				),
			).resolves.toMatchObject({ status: 400 });
			database.runtimeBoxes.upsertRegistration({
				...approved.runtimeBox,
				runtimeBoxVersion: "2.0.0",
			});
			expect(database.runtimeBoxes.listCompatibility()).toEqual([]);

			const challengeInput = {
				runtimeBoxId: status.runtimeBoxId,
				deviceKeyId: "device-key-1",
				instanceId: "remote-instance-1",
				generation: 1,
				protocolVersion: 2 as const,
			};
			const serverIdentity = rpcIdentity;
			server = createRpcServer({
				identity: serverIdentity,
				path: "/runtime",
				authenticate: auth.authenticate,
				handleHttpRequest: auth.handleHttpRequest,
				acceptedPeerRoles: ["runtime-box"],
			});
			const challengeResponse = await fetch(
				`http://127.0.0.1:${server.port}/runtime-auth/challenge`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(challengeInput),
				},
			);
			const challenge = runtimeBoxChallengeOutputSchema.parse(await challengeResponse.json());
			const serverPublicKey = createPublicKey({
				key: Buffer.from(status.agentServerPublicKey, "base64url"),
				format: "der",
				type: "spki",
			});
			expect(
				verify(
					null,
					Buffer.from(
						createRuntimeBoxServerChallengePayload(challengeInput, {
							challengeId: challenge.challengeId,
							nonce: challenge.nonce,
							expiresAt: challenge.expiresAt,
							agentServerId: challenge.agentServerId,
							rpcIdentity: challenge.rpcIdentity,
							actionJournalEpoch: challenge.actionJournalEpoch,
							negotiatedProtocolVersion: challenge.negotiatedProtocolVersion,
							transportSecurity: challenge.transportSecurity,
							supportedTransportSecurity: challenge.supportedTransportSecurity,
						}),
						"utf8",
					),
					serverPublicKey,
					Buffer.from(challenge.signature, "base64url"),
				),
			).toBe(true);

			const upgradeRequest = signedUpgradeRequest(challengeInput, challenge, device.privateKey);
			const peer = await connectRpcClient({
				url: server.url,
				identity: {
					role: "runtime-box",
					peerId: status.runtimeBoxId,
					instanceId: "remote-instance-1",
					generation: 1,
					deviceKeyId: "device-key-1",
				},
				expectedServerIdentity: serverIdentity,
				getHandshakeHeaders: () => Object.fromEntries(upgradeRequest.headers.entries()),
			});
			peer.close(1000, "test complete");
			await peer.closed;
			await expect(
				auth.authenticate(upgradeRequest, { remoteAddress: "203.0.113.10" }),
			).resolves.toBeNull();

			const revokedChallenge = runtimeBoxChallengeOutputSchema.parse(
				await requireResponse(
					await auth.handleHttpRequest(
						jsonRequest("/runtime-auth/challenge", {
							...challengeInput,
							instanceId: "remote-instance-2",
							generation: 2,
						}),
					),
				).json(),
			);
			expect(
				auth.revokeDeviceKey({
					runtimeBoxId: status.runtimeBoxId,
					deviceKeyId: "device-key-1",
				}),
			).toEqual({ revoked: true });
			await expect(
				auth.authenticate(
					signedUpgradeRequest(
						{ ...challengeInput, instanceId: "remote-instance-2", generation: 2 },
						revokedChallenge,
						device.privateKey,
					),
					{ remoteAddress: "203.0.113.10" },
				),
			).resolves.toBeNull();
		} finally {
			server?.stop();
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("applies independent anonymous endpoint rate limits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-runtime-ingress-rate-"));
		const database = openAppDatabase(":memory:");
		try {
			const auth = new RuntimeIngressAuth({
				pairings: database.runtimeBoxPairings,
				runtimeBoxes: database.runtimeBoxes,
				identity: AgentServerIdentity.open(join(directory, "identity.json")),
				rpcIdentity,
				actionJournalEpoch,
				localAuthenticator: async () => null,
			});
			for (let index = 0; index < 60; index += 1) {
				expect(
					(
						await auth.handleHttpRequest(jsonRequest("/runtime-pair/claim", { invalid: index }), {
							remoteAddress: "203.0.113.10",
						})
					)?.status,
				).toBe(400);
			}
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/runtime-pair/claim", {}), {
						remoteAddress: "203.0.113.10",
					})
				)?.status,
			).toBe(429);
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/runtime-pair/claim", {}), {
						remoteAddress: "203.0.113.11",
					})
				)?.status,
			).toBe(400);
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/runtime-auth/challenge", {}), {
						remoteAddress: "203.0.113.10",
					})
				)?.status,
			).toBe(400);
		} finally {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("times out slow bodies and caps concurrent pre-auth requests", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-runtime-ingress-timeout-"));
		const database = openAppDatabase(":memory:");
		try {
			const auth = new RuntimeIngressAuth({
				pairings: database.runtimeBoxPairings,
				runtimeBoxes: database.runtimeBoxes,
				identity: AgentServerIdentity.open(join(directory, "identity.json")),
				rpcIdentity,
				actionJournalEpoch,
				localAuthenticator: async () => null,
				preAuthRequestTimeoutMs: 5,
				maxConcurrentPreAuthRequests: 1,
			});
			const slow = new Request("http://127.0.0.1/runtime-pair/claim", {
				method: "POST",
				body: new ReadableStream<Uint8Array>({}),
			});
			const first = auth.handleHttpRequest(slow, { remoteAddress: "203.0.113.10" });
			await Bun.sleep(0);
			expect(
				(
					await auth.handleHttpRequest(jsonRequest("/runtime-pair/claim", {}), {
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
	input: {
		runtimeBoxId: string;
		deviceKeyId: string;
		instanceId: string;
		generation: number;
		protocolVersion: 2;
	},
	challenge: {
		challengeId: string;
		nonce: string;
		expiresAt: string;
		agentServerId: string;
		rpcIdentity: ProcessPeerIdentity;
		actionJournalEpoch: string;
		negotiatedProtocolVersion: 2;
		transportSecurity: "relay-tls";
		supportedTransportSecurity: Array<"relay-tls" | "noise-xx">;
	},
	privateKey: KeyObject,
): Request {
	const signature = sign(
		null,
		Buffer.from(
			createRuntimeBoxAuthenticationPayload(input, {
				challengeId: challenge.challengeId,
				nonce: challenge.nonce,
				expiresAt: challenge.expiresAt,
				agentServerId: challenge.agentServerId,
				rpcIdentity: challenge.rpcIdentity,
				actionJournalEpoch: challenge.actionJournalEpoch,
				negotiatedProtocolVersion: challenge.negotiatedProtocolVersion,
				transportSecurity: challenge.transportSecurity,
				supportedTransportSecurity: challenge.supportedTransportSecurity,
			}),
			"utf8",
		),
		privateKey,
	).toString("base64url");
	return new Request("http://127.0.0.1/runtime", {
		headers: {
			"x-moshu-runtime-box-id": input.runtimeBoxId,
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
		throw new Error("Runtime ingress did not handle the request.");
	}
	return response;
}
