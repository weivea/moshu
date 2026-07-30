import { z } from "zod";
import { actionJournalEpochSchema, processPeerIdentitySchema } from "./companion-bootstrap";

export const defaultLocalRuntimeBoxId = "moshu-local-runtime-box" as const;
export const runtimeBoxProtocolMinVersion = 5 as const;
export const runtimeBoxProtocolMaxVersion = 5 as const;
export const currentRuntimeBoxProtocolVersion = runtimeBoxProtocolMaxVersion;
export const runtimeBoxProtocolVersionSchema = z.int().positive().max(65_535);
export const runtimeBoxTransportSecuritySchema = z.enum(["relay-tls", "noise-xx"]);

export const runtimeBoxIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const runtimeBoxKindSchema = z.enum(["local", "remote"]);

export const runtimeBoxDeviceKeyIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const runtimeBoxCapabilitySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const runtimeBoxDescriptorSchema = z
	.object({
		schemaVersion: z.literal(1),
		runtimeBoxId: runtimeBoxIdSchema,
		kind: runtimeBoxKindSchema,
		displayName: z.string().trim().min(1).max(128),
		runtimeBoxVersion: z.string().min(1).max(64),
		platform: z.enum(["darwin", "win32", "linux"]),
		arch: z.string().min(1).max(64),
		capabilities: z
			.array(runtimeBoxCapabilitySchema)
			.max(128)
			.superRefine((capabilities, context) => {
				const seen = new Set<string>();
				for (const [index, capability] of capabilities.entries()) {
					if (seen.has(capability)) {
						context.addIssue({
							code: "custom",
							message: "Runtime Box capabilities must be unique.",
							path: [index],
						});
					}
					seen.add(capability);
				}
			}),
	})
	.strict();

export const runtimeBoxConnectionInfoSchema = z
	.object({
		runtimeBox: runtimeBoxDescriptorSchema,
		connected: z.boolean(),
		registered: z.boolean(),
		instanceId: z.string().min(1).max(256).optional(),
		generation: z.int().nonnegative().safe().optional(),
		deviceKeyIds: z.array(runtimeBoxDeviceKeyIdSchema).max(32),
		state: z.enum(["online", "syncing", "offline", "upgrade_required"]).default("offline"),
		compatibility: z.enum(["compatible", "unknown", "upgrade_required"]).default("unknown"),
		requiredProtocolMinVersion: runtimeBoxProtocolVersionSchema.optional(),
		requiredProtocolMaxVersion: runtimeBoxProtocolVersionSchema.optional(),
		negotiatedProtocolVersion: runtimeBoxProtocolVersionSchema.optional(),
		transportSecurity: runtimeBoxTransportSecuritySchema.optional(),
	})
	.strict();

export const activeRuntimeBoxSelectionSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		revision: z.int().positive().safe(),
	})
	.strict();

export const listRuntimeBoxesOutputSchema = z
	.object({
		active: activeRuntimeBoxSelectionSchema,
		items: z.array(runtimeBoxConnectionInfoSchema).max(128),
	})
	.strict();

export const switchRuntimeBoxInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		expectedRevision: z.int().positive().safe(),
	})
	.strict();

export const switchRuntimeBoxOutputSchema = z
	.object({
		active: activeRuntimeBoxSelectionSchema,
	})
	.strict();

// A stable client identity (the authenticated peer's `peerId`). Runtime Box selection is a
// per-client preference keyed by this identity so Desktop and a future Mobile client can each
// hold their own active Runtime Box; the server derives it from the authenticated peer and never
// trusts a caller-supplied value. Mirrors the RPC identifier bounds used for peer identities.
export const runtimeBoxClientIdSchema = z.string().min(1).max(256);

export const clientRuntimeBoxPreferenceSchema = z
	.object({
		clientId: runtimeBoxClientIdSchema,
		runtimeBoxId: runtimeBoxIdSchema,
		revision: z.int().positive().safe(),
	})
	.strict();

const pairingSecretSchema = z
	.string()
	.min(22)
	.max(171)
	.regex(/^[A-Za-z0-9_-]+$/);

export const runtimeBoxPublicKeySchema = z
	.string()
	.min(32)
	.max(2_048)
	.regex(/^[A-Za-z0-9_-]+$/);

export const createRuntimeBoxPairingOutputSchema = z
	.object({
		pairingId: z.string().uuid(),
		code: pairingSecretSchema,
		expiresAt: z.string().datetime({ offset: true }),
		runtimeBaseUrl: z.string().url().optional(),
	})
	.strict();

export const claimRuntimeBoxPairingInputSchema = z
	.object({
		code: pairingSecretSchema,
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
		publicKey: runtimeBoxPublicKeySchema,
		displayName: z.string().trim().min(1).max(128),
		platform: z.enum(["darwin", "win32", "linux"]),
		arch: z.string().min(1).max(64),
	})
	.strict();

export const claimRuntimeBoxPairingOutputSchema = z
	.object({
		pairingId: z.string().uuid(),
		claimToken: pairingSecretSchema,
		status: z.literal("pending_approval"),
	})
	.strict();

export const runtimeBoxPairingClaimSchema = z
	.object({
		pairingId: z.string().uuid(),
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
		displayName: z.string().trim().min(1).max(128),
		platform: z.enum(["darwin", "win32", "linux"]),
		arch: z.string().min(1).max(64),
		publicKeyFingerprint: z.string().min(16).max(128),
		claimedAt: z.string().datetime({ offset: true }),
		expiresAt: z.string().datetime({ offset: true }),
	})
	.strict();

export const listRuntimeBoxPairingClaimsOutputSchema = z
	.object({
		items: z.array(runtimeBoxPairingClaimSchema).max(128),
	})
	.strict();

export const approveRuntimeBoxPairingInputSchema = z
	.object({
		pairingId: z.string().uuid(),
		expectedPublicKeyFingerprint: z.string().min(16).max(128),
	})
	.strict();

export const approveRuntimeBoxPairingOutputSchema = z
	.object({
		runtimeBox: runtimeBoxDescriptorSchema,
	})
	.strict();

export const rejectRuntimeBoxPairingInputSchema = z
	.object({
		pairingId: z.string().uuid(),
	})
	.strict();

export const rejectRuntimeBoxPairingOutputSchema = z
	.object({
		rejected: z.literal(true),
	})
	.strict();

export const revokeRuntimeBoxDeviceInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
	})
	.strict();

export const revokeRuntimeBoxDeviceOutputSchema = z
	.object({
		revoked: z.literal(true),
	})
	.strict();

export const getRuntimeBoxPairingStatusInputSchema = z
	.object({
		pairingId: z.string().uuid(),
		claimToken: pairingSecretSchema,
	})
	.strict();

export const runtimeBoxPairingStatusOutputSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("pending_approval") }).strict(),
	z.object({ status: z.literal("rejected") }).strict(),
	z.object({ status: z.literal("expired") }).strict(),
	z
		.object({
			status: z.literal("approved"),
			runtimeBoxId: runtimeBoxIdSchema,
			agentServerId: z.string().uuid(),
			agentServerPublicKey: runtimeBoxPublicKeySchema,
		})
		.strict(),
]);

export const runtimeBoxChallengeInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
		instanceId: z.string().min(1).max(256),
		generation: z.int().nonnegative().safe(),
		protocolVersion: runtimeBoxProtocolVersionSchema,
	})
	.strict();

export const runtimeBoxChallengeOutputSchema = z
	.object({
		challengeId: z.string().uuid(),
		nonce: pairingSecretSchema,
		expiresAt: z.string().datetime({ offset: true }),
		agentServerId: z.string().uuid(),
		rpcIdentity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
		actionJournalEpoch: actionJournalEpochSchema,
		negotiatedProtocolVersion: z.literal(currentRuntimeBoxProtocolVersion),
		transportSecurity: z.literal("relay-tls"),
		supportedTransportSecurity: z.array(runtimeBoxTransportSecuritySchema).min(1).max(4),
		signature: pairingSecretSchema,
	})
	.strict();

const runtimeBoxCompatibilityReportUnsignedSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
		instanceId: z.string().min(1).max(256),
		generation: z.int().nonnegative().safe(),
		protocolVersion: runtimeBoxProtocolVersionSchema,
		reportId: z.string().uuid(),
		issuedAt: z.string().datetime({ offset: true }),
	})
	.strict();

export const runtimeBoxCompatibilityReportInputSchema =
	runtimeBoxCompatibilityReportUnsignedSchema.extend({
		signature: pairingSecretSchema,
	});

export const runtimeBoxCompatibilityReportOutputSchema = z
	.object({
		accepted: z.literal(true),
		requiredProtocolMinVersion: runtimeBoxProtocolVersionSchema,
		requiredProtocolMaxVersion: runtimeBoxProtocolVersionSchema,
	})
	.strict()
	.refine(
		(value) => value.requiredProtocolMinVersion <= value.requiredProtocolMaxVersion,
		"Runtime Box compatibility report protocol range is invalid.",
	);

export const remoteAccessStateSchema = z.enum([
	"disabled",
	"stopping",
	"auth_required",
	"starting",
	"online",
	"error",
	"repair_required",
]);

// "runtime" is the only ingress instantiated today. "mobile" is a forward-looking descriptor kind
// for a future Mobile ingress port (Layer 3); modelling it here lets the tunnel service manage and
// report a second expected ingress without implying any Mobile listener/pairing exists yet.
export const remoteAccessIngressKindSchema = z.enum(["runtime", "mobile"]);

export const remoteAccessIngressSchema = z
	.object({
		kind: remoteAccessIngressKindSchema,
		port: z.int().min(1).max(65_535),
		// Whether this ingress is currently forwarded and has published its public URL. Remote Access
		// only reaches "online" once every required ingress is ready.
		ready: z.boolean(),
		publicUrl: z.string().url().optional(),
	})
	.strict();

export const remoteAccessStatusOutputSchema = z
	.object({
		enabled: z.boolean(),
		authenticated: z.boolean(),
		state: remoteAccessStateSchema,
		runtimeIngressPort: z.int().min(1).max(65_535),
		tunnelId: z.string().min(3).max(60).optional(),
		publicUrl: z.string().url().optional(),
		ingresses: z.array(remoteAccessIngressSchema).min(1).max(10),
		lastError: z.string().min(1).max(1_024).optional(),
		trafficEstimate: z
			.object({
				month: z.string().regex(/^\d{4}-\d{2}$/),
				receivedBytes: z.int().nonnegative().safe(),
				sentBytes: z.int().nonnegative().safe(),
				totalBytes: z.int().nonnegative().safe(),
				monthlyLimitBytes: z.literal(5 * 1024 * 1024 * 1024),
				warningLevel: z.enum(["none", "50", "80", "100"]),
				source: z.literal("runtime-rpc-application-payload-estimate"),
			})
			.strict(),
		serviceLimits: z
			.object({
				maxTunnelsPerUser: z.literal(10),
				maxPortsPerTunnel: z.literal(10),
				maxBytesPerSecond: z.literal(20 * 1024 * 1024),
			})
			.strict(),
	})
	.strict();

export const remoteAccessAuthAttemptSchema = z
	.object({
		attemptId: z.string().uuid(),
		status: z.enum(["running", "succeeded", "failed"]),
		message: z.string().max(4_096),
	})
	.strict();

export const remoteAccessAuthAttemptInputSchema = z
	.object({
		attemptId: z.string().uuid(),
	})
	.strict();

export const remoteAccessMutationOutputSchema = z
	.object({
		status: remoteAccessStatusOutputSchema,
	})
	.strict();

export const runtimeDiagnosticsOutputSchema = z
	.object({
		generatedAt: z.string().datetime({ offset: true }),
		server: z
			.object({
				version: z.string().min(1).max(64),
				identity: processPeerIdentitySchema,
				processRpcProtocol: z
					.object({
						major: z.int().nonnegative(),
						minor: z.int().nonnegative(),
					})
					.strict(),
				runtimeProtocolMinVersion: z.literal(runtimeBoxProtocolMinVersion),
				runtimeProtocolMaxVersion: z.literal(runtimeBoxProtocolMaxVersion),
				transportSecurity: z.literal("relay-tls"),
				noiseUpgradeAvailable: z.literal(false),
			})
			.strict(),
		database: z
			.object({
				schemaVersion: z.int().positive().safe(),
				integrity: z.enum(["ok", "error"]),
			})
			.strict(),
		runtimeBoxes: z.array(runtimeBoxConnectionInfoSchema).max(128),
		inventories: z
			.array(
				z
					.object({
						runtimeBoxId: runtimeBoxIdSchema,
						inventoryEpoch: z.string().uuid().optional(),
						inventoryRevision: z.int().nonnegative().safe().optional(),
						stale: z.boolean(),
						resourceCount: z.int().nonnegative().max(512),
					})
					.strict(),
			)
			.max(128),
		remoteAccess: remoteAccessStatusOutputSchema,
	})
	.strict();

export type RuntimeBoxId = z.infer<typeof runtimeBoxIdSchema>;
export type RuntimeBoxProtocolVersion = z.infer<typeof runtimeBoxProtocolVersionSchema>;
export type RuntimeBoxTransportSecurity = z.infer<typeof runtimeBoxTransportSecuritySchema>;
export type RuntimeBoxKind = z.infer<typeof runtimeBoxKindSchema>;
export type RuntimeBoxDescriptor = z.infer<typeof runtimeBoxDescriptorSchema>;
export type RuntimeBoxConnectionInfo = z.infer<typeof runtimeBoxConnectionInfoSchema>;
export type ActiveRuntimeBoxSelection = z.infer<typeof activeRuntimeBoxSelectionSchema>;
export type ListRuntimeBoxesOutput = z.infer<typeof listRuntimeBoxesOutputSchema>;
export type SwitchRuntimeBoxInput = z.infer<typeof switchRuntimeBoxInputSchema>;
export type SwitchRuntimeBoxOutput = z.infer<typeof switchRuntimeBoxOutputSchema>;
export type RuntimeBoxClientId = z.infer<typeof runtimeBoxClientIdSchema>;
export type ClientRuntimeBoxPreference = z.infer<typeof clientRuntimeBoxPreferenceSchema>;
export type CreateRuntimeBoxPairingOutput = z.infer<typeof createRuntimeBoxPairingOutputSchema>;
export type ClaimRuntimeBoxPairingInput = z.infer<typeof claimRuntimeBoxPairingInputSchema>;
export type ClaimRuntimeBoxPairingOutput = z.infer<typeof claimRuntimeBoxPairingOutputSchema>;
export type RuntimeBoxPairingClaim = z.infer<typeof runtimeBoxPairingClaimSchema>;
export type ListRuntimeBoxPairingClaimsOutput = z.infer<
	typeof listRuntimeBoxPairingClaimsOutputSchema
>;
export type ApproveRuntimeBoxPairingInput = z.infer<typeof approveRuntimeBoxPairingInputSchema>;
export type ApproveRuntimeBoxPairingOutput = z.infer<typeof approveRuntimeBoxPairingOutputSchema>;
export type RejectRuntimeBoxPairingInput = z.infer<typeof rejectRuntimeBoxPairingInputSchema>;
export type RejectRuntimeBoxPairingOutput = z.infer<typeof rejectRuntimeBoxPairingOutputSchema>;
export type RevokeRuntimeBoxDeviceInput = z.infer<typeof revokeRuntimeBoxDeviceInputSchema>;
export type RevokeRuntimeBoxDeviceOutput = z.infer<typeof revokeRuntimeBoxDeviceOutputSchema>;
export type RuntimeBoxPairingStatusOutput = z.infer<typeof runtimeBoxPairingStatusOutputSchema>;
export type RuntimeBoxChallengeInput = z.infer<typeof runtimeBoxChallengeInputSchema>;
export type RuntimeBoxChallengeOutput = z.infer<typeof runtimeBoxChallengeOutputSchema>;
export type RuntimeBoxCompatibilityReportInput = z.infer<
	typeof runtimeBoxCompatibilityReportInputSchema
>;
export type RuntimeBoxCompatibilityReportOutput = z.infer<
	typeof runtimeBoxCompatibilityReportOutputSchema
>;
export type RemoteAccessStatusOutput = z.infer<typeof remoteAccessStatusOutputSchema>;
export type RemoteAccessIngress = z.infer<typeof remoteAccessIngressSchema>;
export type RemoteAccessIngressKind = z.infer<typeof remoteAccessIngressKindSchema>;
export type RemoteAccessAuthAttempt = z.infer<typeof remoteAccessAuthAttemptSchema>;
export type RemoteAccessMutationOutput = z.infer<typeof remoteAccessMutationOutputSchema>;
export type RuntimeDiagnosticsOutput = z.infer<typeof runtimeDiagnosticsOutputSchema>;

export function createRuntimeBoxServerChallengePayload(
	input: RuntimeBoxChallengeInput,
	output: Omit<RuntimeBoxChallengeOutput, "signature">,
): string {
	return JSON.stringify([
		"moshu-runtime-box-server-challenge-v1",
		output.agentServerId,
		output.rpcIdentity.role,
		output.rpcIdentity.peerId,
		output.rpcIdentity.instanceId,
		output.rpcIdentity.generation,
		output.actionJournalEpoch,
		output.negotiatedProtocolVersion,
		output.transportSecurity,
		output.supportedTransportSecurity,
		input.runtimeBoxId,
		input.deviceKeyId,
		input.instanceId,
		input.generation,
		input.protocolVersion,
		output.challengeId,
		output.nonce,
		output.expiresAt,
	]);
}

export function createRuntimeBoxAuthenticationPayload(
	input: RuntimeBoxChallengeInput,
	challenge: Omit<RuntimeBoxChallengeOutput, "signature">,
): string {
	return JSON.stringify([
		"moshu-runtime-box-authentication-v1",
		challenge.agentServerId,
		challenge.rpcIdentity.role,
		challenge.rpcIdentity.peerId,
		challenge.rpcIdentity.instanceId,
		challenge.rpcIdentity.generation,
		challenge.actionJournalEpoch,
		challenge.negotiatedProtocolVersion,
		challenge.transportSecurity,
		challenge.supportedTransportSecurity,
		input.runtimeBoxId,
		input.deviceKeyId,
		input.instanceId,
		input.generation,
		input.protocolVersion,
		challenge.challengeId,
		challenge.nonce,
		challenge.expiresAt,
	]);
}

export function createRuntimeBoxCompatibilityReportPayload(
	agentServerId: string,
	report: Omit<RuntimeBoxCompatibilityReportInput, "signature">,
): string {
	const parsed = runtimeBoxCompatibilityReportUnsignedSchema.parse(report);
	return JSON.stringify([
		"moshu-runtime-box-compatibility-report-v1",
		agentServerId,
		parsed.runtimeBoxId,
		parsed.deviceKeyId,
		parsed.instanceId,
		parsed.generation,
		parsed.protocolVersion,
		parsed.reportId,
		parsed.issuedAt,
	]);
}
