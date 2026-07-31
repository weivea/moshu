import { z } from "zod";
import { actionJournalEpochSchema, processPeerIdentitySchema } from "./companion-bootstrap";
import { remoteAccessStateSchema } from "./runtime-box";

// Layer 3 — Mobile ingress. A physically and logically separate ingress from the Product and
// Runtime Box surfaces: its own listener/port/path, its own persistence, its own device identity
// and canonical signing tags. Nothing here reuses Runtime Box contracts so the two ingresses can
// evolve (and be revoked) independently.

export const mobileProtocolMinVersion = 1 as const;
export const mobileProtocolMaxVersion = 1 as const;
export const currentMobileProtocolVersion = mobileProtocolMaxVersion;
export const mobileProtocolVersionSchema = z.int().positive().max(65_535);
export const mobileTransportSecuritySchema = z.enum(["relay-tls", "noise-xx"]);

// The stable Mobile client identity. The server mints it on approval and it becomes the
// authenticated peer's `peerId`; the server never trusts a caller-supplied value.
export const mobileClientIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const mobileDeviceKeyIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const mobilePlatformSchema = z.enum(["ios", "ipados", "android"]);

const mobilePairingSecretSchema = z
	.string()
	.min(22)
	.max(171)
	.regex(/^[A-Za-z0-9_-]+$/);

export const mobilePublicKeySchema = z
	.string()
	.min(32)
	.max(2_048)
	.regex(/^[A-Za-z0-9_-]+$/);

export const mobilePublicKeyFingerprintSchema = z.string().min(16).max(128);

export const mobileDeviceSchema = z
	.object({
		schemaVersion: z.literal(1),
		mobileClientId: mobileClientIdSchema,
		displayName: z.string().trim().min(1).max(128),
		model: z.string().trim().min(1).max(128),
		platform: mobilePlatformSchema,
		appVersion: z.string().min(1).max(64),
		deviceKeyIds: z.array(mobileDeviceKeyIdSchema).max(32),
		approvedAt: z.string().datetime({ offset: true }),
		lastSeenAt: z.string().datetime({ offset: true }).optional(),
		revoked: z.boolean(),
	})
	.strict();

export const listMobileDevicesOutputSchema = z
	.object({
		items: z.array(mobileDeviceSchema).max(128),
	})
	.strict();

// The versioned QR payload the phone scans. It carries only ephemeral, single-use material plus the
// pinned Agent Server public identity. It MUST NOT include a server secret or any long-term token,
// and it MUST NOT be written to logs or persistent client storage.
export const mobilePairingQrPayloadSchema = z
	.object({
		v: z.literal(1),
		kind: z.literal("moshu-mobile-pairing"),
		mobileUrl: z.string().url(),
		pairingId: z.string().uuid(),
		code: mobilePairingSecretSchema,
		agentServerId: z.string().uuid(),
		agentServerPublicKey: mobilePublicKeySchema,
		agentServerPublicKeyFingerprint: mobilePublicKeyFingerprintSchema,
		expiresAt: z.string().datetime({ offset: true }),
		protocolMinVersion: z.literal(mobileProtocolMinVersion),
		protocolMaxVersion: z.literal(mobileProtocolMaxVersion),
	})
	.strict();

export const createMobilePairingOutputSchema = z
	.object({
		pairingId: z.string().uuid(),
		code: mobilePairingSecretSchema,
		expiresAt: z.string().datetime({ offset: true }),
		// Present only when the Mobile ingress is ready and has a public URL — a QR without a
		// reachable URL would be useless, so we never publish one until the ingress is exposed.
		mobileUrl: z.string().url().optional(),
		qr: mobilePairingQrPayloadSchema.optional(),
	})
	.strict();

export const claimMobilePairingInputSchema = z
	.object({
		code: mobilePairingSecretSchema,
		deviceKeyId: mobileDeviceKeyIdSchema,
		publicKey: mobilePublicKeySchema,
		displayName: z.string().trim().min(1).max(128),
		model: z.string().trim().min(1).max(128),
		platform: mobilePlatformSchema,
		appVersion: z.string().min(1).max(64),
	})
	.strict();

export const claimMobilePairingOutputSchema = z
	.object({
		pairingId: z.string().uuid(),
		claimToken: mobilePairingSecretSchema,
		status: z.literal("pending_approval"),
	})
	.strict();

export const mobilePairingClaimSchema = z
	.object({
		pairingId: z.string().uuid(),
		deviceKeyId: mobileDeviceKeyIdSchema,
		displayName: z.string().trim().min(1).max(128),
		model: z.string().trim().min(1).max(128),
		platform: mobilePlatformSchema,
		appVersion: z.string().min(1).max(64),
		publicKeyFingerprint: mobilePublicKeyFingerprintSchema,
		claimedAt: z.string().datetime({ offset: true }),
		expiresAt: z.string().datetime({ offset: true }),
	})
	.strict();

export const listMobilePairingClaimsOutputSchema = z
	.object({
		items: z.array(mobilePairingClaimSchema).max(128),
	})
	.strict();

export const approveMobilePairingInputSchema = z
	.object({
		pairingId: z.string().uuid(),
		expectedPublicKeyFingerprint: mobilePublicKeyFingerprintSchema,
	})
	.strict();

export const approveMobilePairingOutputSchema = z
	.object({
		device: mobileDeviceSchema,
	})
	.strict();

export const rejectMobilePairingInputSchema = z
	.object({
		pairingId: z.string().uuid(),
	})
	.strict();

export const rejectMobilePairingOutputSchema = z
	.object({
		rejected: z.literal(true),
	})
	.strict();

export const revokeMobileDeviceInputSchema = z
	.object({
		mobileClientId: mobileClientIdSchema,
		deviceKeyId: mobileDeviceKeyIdSchema,
	})
	.strict();

export const revokeMobileDeviceOutputSchema = z
	.object({
		revoked: z.literal(true),
	})
	.strict();

export const getMobilePairingStatusInputSchema = z
	.object({
		pairingId: z.string().uuid(),
		claimToken: mobilePairingSecretSchema,
	})
	.strict();

export const mobilePairingStatusOutputSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("pending_approval") }).strict(),
	z.object({ status: z.literal("rejected") }).strict(),
	z.object({ status: z.literal("expired") }).strict(),
	z
		.object({
			status: z.literal("approved"),
			mobileClientId: mobileClientIdSchema,
			agentServerId: z.string().uuid(),
			agentServerPublicKey: mobilePublicKeySchema,
		})
		.strict(),
]);

export const mobileChallengeInputSchema = z
	.object({
		mobileClientId: mobileClientIdSchema,
		deviceKeyId: mobileDeviceKeyIdSchema,
		instanceId: z.string().min(1).max(256),
		generation: z.int().nonnegative().safe(),
		protocolVersion: mobileProtocolVersionSchema,
	})
	.strict();

export const mobileChallengeOutputSchema = z
	.object({
		challengeId: z.string().uuid(),
		nonce: mobilePairingSecretSchema,
		expiresAt: z.string().datetime({ offset: true }),
		agentServerId: z.string().uuid(),
		rpcIdentity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
		actionJournalEpoch: actionJournalEpochSchema,
		negotiatedProtocolVersion: z.literal(currentMobileProtocolVersion),
		transportSecurity: z.literal("relay-tls"),
		supportedTransportSecurity: z.array(mobileTransportSecuritySchema).min(1).max(4),
		signature: mobilePairingSecretSchema,
	})
	.strict();

// The versioned Mobile ingress status. The Remote Access status wire contract stays at v1 (a single
// scalar Runtime ingress); this is a separate, explicit method so old strict v1 clients keep working
// while Desktop learns about the second ingress and its public URL.
export const mobileAccessStatusOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		remoteAccessEnabled: z.boolean(),
		remoteAccessState: remoteAccessStateSchema,
		ingressPort: z.int().min(1).max(65_535),
		ingressReady: z.boolean(),
		publicUrl: z.string().url().optional(),
		protocolMinVersion: z.literal(mobileProtocolMinVersion),
		protocolMaxVersion: z.literal(mobileProtocolMaxVersion),
		transportSecurity: z.literal("relay-tls"),
		supportedTransportSecurity: z.array(mobileTransportSecuritySchema).min(1).max(4),
	})
	.strict();

export type MobileProtocolVersion = z.infer<typeof mobileProtocolVersionSchema>;
export type MobileTransportSecurity = z.infer<typeof mobileTransportSecuritySchema>;
export type MobilePlatform = z.infer<typeof mobilePlatformSchema>;
export type MobileDevice = z.infer<typeof mobileDeviceSchema>;
export type ListMobileDevicesOutput = z.infer<typeof listMobileDevicesOutputSchema>;
export type MobilePairingQrPayload = z.infer<typeof mobilePairingQrPayloadSchema>;
export type CreateMobilePairingOutput = z.infer<typeof createMobilePairingOutputSchema>;
export type ClaimMobilePairingInput = z.infer<typeof claimMobilePairingInputSchema>;
export type ClaimMobilePairingOutput = z.infer<typeof claimMobilePairingOutputSchema>;
export type MobilePairingClaim = z.infer<typeof mobilePairingClaimSchema>;
export type ListMobilePairingClaimsOutput = z.infer<typeof listMobilePairingClaimsOutputSchema>;
export type ApproveMobilePairingInput = z.infer<typeof approveMobilePairingInputSchema>;
export type ApproveMobilePairingOutput = z.infer<typeof approveMobilePairingOutputSchema>;
export type RejectMobilePairingInput = z.infer<typeof rejectMobilePairingInputSchema>;
export type RejectMobilePairingOutput = z.infer<typeof rejectMobilePairingOutputSchema>;
export type RevokeMobileDeviceInput = z.infer<typeof revokeMobileDeviceInputSchema>;
export type RevokeMobileDeviceOutput = z.infer<typeof revokeMobileDeviceOutputSchema>;
export type GetMobilePairingStatusInput = z.infer<typeof getMobilePairingStatusInputSchema>;
export type MobilePairingStatusOutput = z.infer<typeof mobilePairingStatusOutputSchema>;
export type MobileChallengeInput = z.infer<typeof mobileChallengeInputSchema>;
export type MobileChallengeOutput = z.infer<typeof mobileChallengeOutputSchema>;
export type MobileAccessStatusOutput = z.infer<typeof mobileAccessStatusOutputSchema>;

export function createMobileServerChallengePayload(
	input: MobileChallengeInput,
	output: Omit<MobileChallengeOutput, "signature">,
): string {
	return JSON.stringify([
		"moshu-mobile-server-challenge-v1",
		output.agentServerId,
		output.rpcIdentity.role,
		output.rpcIdentity.peerId,
		output.rpcIdentity.instanceId,
		output.rpcIdentity.generation,
		output.actionJournalEpoch,
		output.negotiatedProtocolVersion,
		output.transportSecurity,
		output.supportedTransportSecurity,
		input.mobileClientId,
		input.deviceKeyId,
		input.instanceId,
		input.generation,
		input.protocolVersion,
		output.challengeId,
		output.nonce,
		output.expiresAt,
	]);
}

export function createMobileAuthenticationPayload(
	input: MobileChallengeInput,
	challenge: Omit<MobileChallengeOutput, "signature">,
): string {
	return JSON.stringify([
		"moshu-mobile-authentication-v1",
		challenge.agentServerId,
		challenge.rpcIdentity.role,
		challenge.rpcIdentity.peerId,
		challenge.rpcIdentity.instanceId,
		challenge.rpcIdentity.generation,
		challenge.actionJournalEpoch,
		challenge.negotiatedProtocolVersion,
		challenge.transportSecurity,
		challenge.supportedTransportSecurity,
		input.mobileClientId,
		input.deviceKeyId,
		input.instanceId,
		input.generation,
		input.protocolVersion,
		challenge.challengeId,
		challenge.nonce,
		challenge.expiresAt,
	]);
}
