import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRisk, ApprovalActionSummary } from "@moshu/contracts";
import {
	ackMobileAttentionOutputSchema,
	claimMobilePairingOutputSchema,
	createMobileAuthenticationPayload,
	listMobileAttentionOutputSchema,
	type MobileChallengeInput,
	type MobileChallengeOutput,
	mobileChallengeOutputSchema,
	mobileDeviceSchema,
	productRpcMethods,
} from "@moshu/contracts";
import { type AppDatabase, createUuidV7, openAppDatabase } from "@moshu/database";
import { connectRpcClient, type RpcHandlers, type RpcServer } from "@moshu/process-rpc";

import { AgentServerIdentity } from "./agent-server-identity";
import { MobileIngressAuth } from "./mobile-ingress-auth";
import { createMobileIngressComposition } from "./mobile-ingress-composition";
import { MobileIngressGenerationFence } from "./mobile-ingress-generation-fence";

const rpcIdentity = {
	role: "agents" as const,
	peerId: "mobile-smoke-agents",
	instanceId: "mobile-smoke-agents-1",
	generation: 1,
};
const actionJournalEpoch = "550e8400-e29b-41d4-a716-446655440099";

const mediumRisk: ActionRisk = { tier: "medium", overridable: true, reasons: ["edit"] };

function makeActionSummary(): ApprovalActionSummary {
	return {
		tool: "bash",
		operation: "bash",
		target: { kind: "runtime-box", id: "box-1" },
		command: "echo secret-command",
		redactedParams: {},
	};
}

function makeProviderInput() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		thinkingLevel: "medium" as const,
	};
}

// Drive the real production write path: create a session + Run through the durable repositories so
// the transactional attention outbox is written atomically by the same code paths the Agent Server
// uses at runtime — no bespoke append.
function seedRun(database: AppDatabase): {
	sessionId: string;
	runId: string;
} {
	const session = database.sessions.create({ title: "Smoke Session" }).session;
	const created = database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId: session.id,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "Smoke prompt",
	});
	return {
		sessionId: session.id,
		runId: created.run.id,
	};
}

function createPendingApproval(database: AppDatabase, sessionId: string, runId: string): string {
	const now = Date.now();
	const id = crypto.randomUUID();
	database.approvals.create({
		id,
		sessionId,
		runId,
		actionId: crypto.randomUUID(),
		toolCallId: `call-${crypto.randomUUID()}`,
		action: makeActionSummary(),
		risk: mediumRisk,
		createdAtMs: now,
		expiresAtMs: now + 60_000,
	});
	return id;
}

function completeRun(database: AppDatabase, runId: string): void {
	database.runs.updateStatus({ runId, status: "running" });
	database.runs.commitTerminal({
		runId,
		status: "completed",
	});
}

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
		// The disconnect closure mirrors the production create-agents-server wiring: revoking a device
		// tears down any live peer for that client id. It is passed to the shared revoke helper so the
		// smoke exercises the real revoke composition rather than manually closing peers.
		const disconnectMobileDevice = (mobileClientId: string, reason: string): void => {
			for (const peer of server?.peers ?? []) {
				if (peer.remoteIdentity.peerId === mobileClientId && !peer.isClosed) {
					peer.close(1008, reason);
				}
			}
		};
		try {
			const identity = AgentServerIdentity.open(join(directory, "identity.json"));
			const auth = new MobileIngressAuth({
				pairings: database.mobilePairings,
				identity,
				rpcIdentity,
				actionJournalEpoch,
				getMobilePublicUrl: () => "https://mobile.example.devtunnels.ms",
				isRemoteAccessEnabled: () => true,
			});
			const fence = new MobileIngressGenerationFence(database.mobileDevices);
			let attentionChangedHints = 0;
			// A minimal stub of the shared Product handler map: only the two methods this smoke needs to
			// prove allowlist isolation. `runtimeGet` is allowlisted; `providersDelete` is NOT — a handler
			// exists for it, yet the allowlist must still deny it, proving isolation is enforced by policy,
			// not by the absence of a handler. In production these come from the full product handler map;
			// the composition merges the durable attention handlers on top of whatever base is supplied.
			const runtimeGetCalls: string[] = [];
			const baseHandlers: RpcHandlers = {
				requests: {
					[productRpcMethods.runtimeGet]: (_payload, context) => {
						runtimeGetCalls.push(context.remoteIdentity.peerId);
						return { runtimeBoxId: "local", stub: true };
					},
					[productRpcMethods.providersDelete]: () => ({ deleted: true }),
				},
			};
			// Drive the REAL production wiring: `createMobileIngressComposition` is the single source of
			// truth that create-agents-server also uses. It builds the ingress server (identity, /mobile
			// path, mobile-client role, strict allowlist, frame limits, auth + generation fence), merges
			// the durable attention list/ack handlers onto the base map, owns the transactional-outbox
			// drainer, and exposes the shared revoke closure. The smoke never re-declares the allowlist,
			// re-implements the attention handlers, or hand-builds the drainer/revoke — so a new ingress
			// method or event added to the composition is automatically exercised here.
			const composition = createMobileIngressComposition({
				serverIdentity: rpcIdentity,
				authenticate: auth.authenticate,
				handleHttpRequest: auth.handleHttpRequest,
				generationFence: fence,
				baseHandlers,
				mobileAttention: database.mobileAttention,
				mobileAttentionOutbox: database.mobileAttentionOutbox,
				// The mobile-only `attention.changed` live hint; losing it never affects durable recovery.
				onAttentionAppended: () => {
					attentionChangedHints += 1;
				},
				revokeDeviceKey: (input) => auth.revokeDevice(input),
				disconnectMobileDevice,
			});
			const drainer = composition.drainer;
			server = composition.createServer();

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

			// 4b) Durable attention feed via the REAL production composition: a pending approval and a
			// Run terminal transition each write the transactional outbox atomically with their business
			// state; the production drainer projects them into the durable feed (desensitized). The phone
			// lists unread, acks, and — critically — recovers missed unread after a disconnect from the
			// server-owned feed, never from device storage.
			const { sessionId, runId } = seedRun(database);
			createPendingApproval(database, sessionId, runId);
			completeRun(database, runId);

			// Nothing is visible on the feed until the drainer projects the committed outbox rows.
			expect(database.mobileAttention.latestSeq()).toBe(0);
			expect(database.mobileAttentionOutbox.pendingCount()).toBe(2);
			const drainResult = drainer.drain();
			expect(drainResult.appended).toBe(2);
			expect(database.mobileAttentionOutbox.pendingCount()).toBe(0);
			// The live `attention.changed` hint fired for the projected batch.
			expect(attentionChangedHints).toBeGreaterThanOrEqual(1);

			const feed = listMobileAttentionOutputSchema.parse(
				await peer.request(productRpcMethods.mobileAttentionList, {}),
			);
			expect(feed.unreadCount).toBe(2);
			expect(feed.items).toHaveLength(2);
			expect(feed.latestSeq).toBe(2);
			expect(feed.resyncRequired).toBe(false);
			// Desensitization: only opaque ids and localization keys ever cross the wire.
			for (const item of feed.items) {
				expect(item.visibility).toBe("mobile-clients");
				expect(item.titleKey).toMatch(/^attention\./);
				expect(Object.keys(item)).not.toContain("prompt");
				expect(Object.keys(item)).not.toContain("command");
			}
			// Reconfirm nothing raw leaked into the feed payload.
			expect(JSON.stringify(feed)).not.toContain("secret-command");

			const ack = ackMobileAttentionOutputSchema.parse(
				await peer.request(productRpcMethods.mobileAttentionAck, { seq: 1 }),
			);
			expect(ack.ackSeq).toBe(1);
			expect(ack.unreadCount).toBe(1);

			// A missed event arrives (another pending approval) while the phone will be offline between
			// reconnects; it flows through the same outbox → drainer projection path.
			createPendingApproval(database, sessionId, runId);
			expect(drainer.drain().appended).toBe(1);

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

			// 5b) After reconnect the phone re-snapshots the server-owned feed and recovers the unread
			// that accrued while it was offline (ack cursor persisted at seq 1; two later events unread),
			// without ever having stored a business event on-device.
			const recovered = listMobileAttentionOutputSchema.parse(
				await secondPeer.request(productRpcMethods.mobileAttentionList, {}),
			);
			expect(recovered.ackSeq).toBe(1);
			expect(recovered.unreadCount).toBe(2);
			expect(recovered.latestSeq).toBe(3);
			expect(recovered.resyncRequired).toBe(false);

			// 6) Revoking the device runs the REAL shared revoke composition: it revokes the durable key,
			// drops the device's server-side unread cursor (so a re-paired client id can never inherit
			// stale read state), and tears down the live peer.
			composition.revoke({
				mobileClientId: approved.mobileClientId,
				deviceKeyId: "device-key-1",
			});
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
