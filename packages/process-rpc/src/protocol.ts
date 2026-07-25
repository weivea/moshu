import { z } from "zod";

export const PROCESS_RPC_SCHEMA_VERSION = 1 as const;
export const PROCESS_RPC_PROTOCOL_MAJOR = 1 as const;
export const PROCESS_RPC_PROTOCOL_MINOR = 0 as const;

export const rpcProtocolVersionSchema = z
	.object({
		major: z.number().int().nonnegative(),
		minor: z.number().int().nonnegative(),
	})
	.strict();

export const rpcPeerRoleSchema = z.enum(["agents", "client", "executor"]);
export const rpcJsonValueSchema = z.json();

const rpcIdentifierSchema = z.string().min(1).max(256);
const rpcMethodSchema = z.string().min(1).max(256).regex(/^\S+$/);
const rpcTimestampSchema = z.number().int().nonnegative().safe();

export const rpcPeerIdentitySchema = z
	.object({
		role: rpcPeerRoleSchema,
		peerId: rpcIdentifierSchema,
		instanceId: rpcIdentifierSchema,
		generation: z.number().int().nonnegative().safe(),
	})
	.strict();

const envelopeBase = {
	schemaVersion: z.literal(PROCESS_RPC_SCHEMA_VERSION),
	protocol: rpcProtocolVersionSchema,
};

export const rpcHelloEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("hello"),
		peer: rpcPeerIdentitySchema,
	})
	.strict();

export const rpcHelloAckEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("hello-ack"),
		connectionId: rpcIdentifierSchema,
		peer: rpcPeerIdentitySchema,
		acceptedPeer: rpcPeerIdentitySchema,
	})
	.strict();

export const rpcRequestEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("request"),
		requestId: rpcIdentifierSchema,
		traceId: rpcIdentifierSchema,
		method: rpcMethodSchema,
		deadlineAt: rpcTimestampSchema,
		payload: rpcJsonValueSchema,
	})
	.strict();

export const rpcResponseErrorSchema = z
	.object({
		code: z.string().min(1).max(128),
		message: z.string().min(1).max(1024),
		data: rpcJsonValueSchema.optional(),
	})
	.strict();

export const rpcResponseResultSchema = z.discriminatedUnion("ok", [
	z
		.object({
			ok: z.literal(true),
			payload: rpcJsonValueSchema,
		})
		.strict(),
	z
		.object({
			ok: z.literal(false),
			error: rpcResponseErrorSchema,
		})
		.strict(),
]);

export const rpcResponseEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("response"),
		requestId: rpcIdentifierSchema,
		traceId: rpcIdentifierSchema,
		result: rpcResponseResultSchema,
	})
	.strict();

export const rpcEventEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("event"),
		eventId: rpcIdentifierSchema,
		traceId: rpcIdentifierSchema,
		method: rpcMethodSchema,
		payload: rpcJsonValueSchema,
	})
	.strict();

export const rpcCancelEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("cancel"),
		requestId: rpcIdentifierSchema,
		traceId: rpcIdentifierSchema,
		reason: z.string().min(1).max(512).optional(),
	})
	.strict();

export const rpcHeartbeatEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("heartbeat"),
		heartbeatId: rpcIdentifierSchema,
		kind: z.enum(["ping", "pong"]),
		sentAt: rpcTimestampSchema,
	})
	.strict();

export const rpcProtocolErrorCodeSchema = z.enum([
	"MALFORMED_FRAME",
	"FRAME_TOO_LARGE",
	"UNSUPPORTED_PROTOCOL",
	"UNSUPPORTED_SCHEMA",
	"UNEXPECTED_MESSAGE",
	"AUTHENTICATION_FAILED",
	"IDENTITY_MISMATCH",
	"ROLE_NOT_ALLOWED",
	"STALE_GENERATION",
	"GENERATION_CONFLICT",
	"HANDSHAKE_TIMEOUT",
	"METHOD_NOT_ALLOWED",
	"EVENT_LIMIT_EXCEEDED",
	"EVENT_HANDLER_FAILED",
	"INTERNAL_ERROR",
]);

export const rpcProtocolErrorEnvelopeSchema = z
	.object({
		...envelopeBase,
		type: z.literal("protocol-error"),
		code: rpcProtocolErrorCodeSchema,
		message: z.string().min(1).max(1024),
		fatal: z.boolean(),
		relatedId: rpcIdentifierSchema.optional(),
	})
	.strict();

export const rpcEnvelopeSchema = z.discriminatedUnion("type", [
	rpcHelloEnvelopeSchema,
	rpcHelloAckEnvelopeSchema,
	rpcRequestEnvelopeSchema,
	rpcResponseEnvelopeSchema,
	rpcEventEnvelopeSchema,
	rpcCancelEnvelopeSchema,
	rpcHeartbeatEnvelopeSchema,
	rpcProtocolErrorEnvelopeSchema,
]);

export type JsonValue = z.infer<typeof rpcJsonValueSchema>;
export type RpcProtocolVersion = z.infer<typeof rpcProtocolVersionSchema>;
export type RpcPeerRole = z.infer<typeof rpcPeerRoleSchema>;
export type RpcPeerIdentity = z.infer<typeof rpcPeerIdentitySchema>;
export type RpcHelloEnvelope = z.infer<typeof rpcHelloEnvelopeSchema>;
export type RpcHelloAckEnvelope = z.infer<typeof rpcHelloAckEnvelopeSchema>;
export type RpcRequestEnvelope = z.infer<typeof rpcRequestEnvelopeSchema>;
export type RpcResponseError = z.infer<typeof rpcResponseErrorSchema>;
export type RpcResponseResult = z.infer<typeof rpcResponseResultSchema>;
export type RpcResponseEnvelope = z.infer<typeof rpcResponseEnvelopeSchema>;
export type RpcEventEnvelope = z.infer<typeof rpcEventEnvelopeSchema>;
export type RpcCancelEnvelope = z.infer<typeof rpcCancelEnvelopeSchema>;
export type RpcHeartbeatEnvelope = z.infer<typeof rpcHeartbeatEnvelopeSchema>;
export type RpcProtocolErrorCode = z.infer<typeof rpcProtocolErrorCodeSchema>;
export type RpcProtocolErrorEnvelope = z.infer<typeof rpcProtocolErrorEnvelopeSchema>;
export type RpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export const CURRENT_PROCESS_RPC_PROTOCOL: RpcProtocolVersion = Object.freeze({
	major: PROCESS_RPC_PROTOCOL_MAJOR,
	minor: PROCESS_RPC_PROTOCOL_MINOR,
});

export function negotiateRpcProtocol(
	local: RpcProtocolVersion,
	remote: RpcProtocolVersion,
): RpcProtocolVersion | null {
	if (local.major !== remote.major) {
		return null;
	}

	return {
		major: local.major,
		minor: Math.min(local.minor, remote.minor),
	};
}

export function isSameRpcPeerIdentity(left: RpcPeerIdentity, right: RpcPeerIdentity): boolean {
	return (
		left.role === right.role &&
		left.peerId === right.peerId &&
		left.instanceId === right.instanceId &&
		left.generation === right.generation
	);
}

export function hasUnsupportedRpcSchemaVersion(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.hasOwn(value, "schemaVersion") &&
		Reflect.get(value, "schemaVersion") !== PROCESS_RPC_SCHEMA_VERSION
	);
}
