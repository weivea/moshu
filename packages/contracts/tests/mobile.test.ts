import { describe, expect, test } from "bun:test";
import {
	createMobileAuthenticationPayload,
	createMobileServerChallengePayload,
	currentMobileProtocolVersion,
	type MobileChallengeInput,
	type MobileChallengeOutput,
	mobileClientProductEventMethods,
	mobileClientProductRequestMethods,
	mobilePairingQrPayloadSchema,
	mobileProtocolMaxVersion,
	mobileProtocolMinVersion,
	productRpcEvents,
	productRpcMethods,
} from "../src";

const challengeInput: MobileChallengeInput = {
	mobileClientId: "mobile-client-1",
	deviceKeyId: "device-key-1",
	instanceId: "mobile-instance-1",
	generation: 3,
	protocolVersion: currentMobileProtocolVersion,
};

const challengeOutput: Omit<MobileChallengeOutput, "signature"> = {
	challengeId: "11111111-1111-4111-8111-111111111111",
	nonce: "nonce-value-abcdefghijklmnop",
	expiresAt: "2025-01-01T00:00:30.000Z",
	agentServerId: "22222222-2222-4222-8222-222222222222",
	rpcIdentity: {
		role: "agents",
		peerId: "agents-peer",
		instanceId: "agents-instance-1",
		generation: 1,
	},
	actionJournalEpoch: "33333333-3333-4333-8333-333333333333",
	negotiatedProtocolVersion: currentMobileProtocolVersion,
	transportSecurity: "relay-tls",
	supportedTransportSecurity: ["relay-tls"],
};

describe("mobile QR payload", () => {
	test("carries the pinned server identity but never a secret or long-term token", () => {
		const payload = mobilePairingQrPayloadSchema.parse({
			v: 1,
			kind: "moshu-mobile-pairing",
			mobileUrl: "https://tunnel.example.com/mobile",
			pairingId: "44444444-4444-4444-8444-444444444444",
			code: "one-time-code-abcdefghij",
			agentServerId: "22222222-2222-4222-8222-222222222222",
			agentServerPublicKey: "MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789AB",
			agentServerPublicKeyFingerprint: "fingerprint-abcdef0123456789",
			expiresAt: "2025-01-01T00:05:00.000Z",
			protocolMinVersion: mobileProtocolMinVersion,
			protocolMaxVersion: mobileProtocolMaxVersion,
		});
		// The payload has no field that could carry a server secret or a long-term bearer token.
		const keys = Object.keys(payload);
		expect(keys).not.toContain("agentServerSecret");
		expect(keys).not.toContain("token");
		expect(keys).not.toContain("bearer");
		expect(keys).not.toContain("privateKey");
	});

	test("rejects an unexpected field to keep the QR contract tight", () => {
		expect(() =>
			mobilePairingQrPayloadSchema.parse({
				v: 1,
				kind: "moshu-mobile-pairing",
				mobileUrl: "https://tunnel.example.com/mobile",
				pairingId: "44444444-4444-4444-8444-444444444444",
				code: "one-time-code-abcdefghij",
				agentServerId: "22222222-2222-4222-8222-222222222222",
				agentServerPublicKey: "MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789AB",
				agentServerPublicKeyFingerprint: "fingerprint-abcdef0123456789",
				expiresAt: "2025-01-01T00:05:00.000Z",
				protocolMinVersion: mobileProtocolMinVersion,
				protocolMaxVersion: mobileProtocolMaxVersion,
				token: "long-lived",
			}),
		).toThrow();
	});
});

describe("mobile canonical signing payloads", () => {
	test("bind the full connection identity and differ by domain tag", () => {
		const challenge = createMobileServerChallengePayload(challengeInput, challengeOutput);
		const authentication = createMobileAuthenticationPayload(challengeInput, challengeOutput);
		expect(challenge).not.toBe(authentication);
		expect(challenge).toContain("moshu-mobile-server-challenge-v1");
		expect(authentication).toContain("moshu-mobile-authentication-v1");
		for (const bound of [
			challengeInput.mobileClientId,
			challengeInput.deviceKeyId,
			challengeInput.instanceId,
			challengeOutput.agentServerId,
			challengeOutput.challengeId,
			challengeOutput.nonce,
			challengeOutput.transportSecurity,
		]) {
			expect(challenge).toContain(bound);
			expect(authentication).toContain(bound);
		}
		expect(challenge).toContain(String(challengeInput.generation));
	});

	test("change when any bound field changes", () => {
		const base = createMobileAuthenticationPayload(challengeInput, challengeOutput);
		const tampered = createMobileAuthenticationPayload(
			{ ...challengeInput, generation: challengeInput.generation + 1 },
			challengeOutput,
		);
		expect(base).not.toBe(tampered);
	});
});

describe("mobile allowlist", () => {
	test("grants exactly the MVP request surface", () => {
		expect([...mobileClientProductRequestMethods].sort()).toEqual(
			[
				productRpcMethods.runtimeGet,
				productRpcMethods.runtimeBoxesList,
				productRpcMethods.runtimeBoxesSwitch,
				productRpcMethods.projectsList,
				productRpcMethods.projectsGet,
				productRpcMethods.projectsGetSidebar,
				productRpcMethods.modelsListAvailable,
				productRpcMethods.sessionCreate,
				productRpcMethods.sessionGet,
				productRpcMethods.sessionList,
				productRpcMethods.sessionSetModel,
				productRpcMethods.chatSend,
				productRpcMethods.chatCancel,
				productRpcMethods.chatReplay,
				productRpcMethods.chatSubscribe,
				productRpcMethods.chatUnsubscribe,
				productRpcMethods.chatRetiredSessionsList,
				productRpcMethods.approvalsList,
				productRpcMethods.approvalsGet,
				productRpcMethods.approvalsDecide,
				productRpcMethods.sessionApprovalPolicyGet,
				productRpcMethods.sessionApprovalPolicyUpdate,
			].sort(),
		);
	});

	test("never exposes a privileged or mutating control-plane method", () => {
		const requests = new Set<string>(mobileClientProductRequestMethods);
		for (const forbidden of [
			productRpcMethods.providersCreate,
			productRpcMethods.providersDelete,
			productRpcMethods.providerAuthStart,
			productRpcMethods.remoteAccessEnable,
			productRpcMethods.runtimeBoxesPairingCreate,
			productRpcMethods.runtimeBoxesPairingApprove,
			productRpcMethods.runtimeBoxesDeviceRevoke,
			productRpcMethods.projectsCreate,
			productRpcMethods.projectsRelink,
			productRpcMethods.projectsArchive,
			productRpcMethods.projectsDelete,
			productRpcMethods.projectsCheckPath,
			productRpcMethods.mcpUpsert,
			productRpcMethods.skillUpsert,
			productRpcMethods.runtimeDiagnosticsGet,
			productRpcMethods.defaultModelSet,
			productRpcMethods.agentGlobalProfileUpdate,
		]) {
			expect(requests.has(forbidden)).toBe(false);
		}
	});

	test("scopes events to visible chat, approval, and runtime signals", () => {
		expect([...mobileClientProductEventMethods].sort()).toEqual(
			[
				productRpcEvents.chatEvent,
				productRpcEvents.chatSessionsRetired,
				productRpcEvents.runtimeBoxesChanged,
				productRpcEvents.approvalEvent,
				productRpcEvents.sessionApprovalPolicyChanged,
				productRpcEvents.approvalActivityChanged,
			].sort(),
		);
	});
});
