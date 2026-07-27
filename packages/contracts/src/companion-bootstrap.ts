import { z } from "zod";

export const companionBootstrapChannel = "moshu-companion-bootstrap" as const;
export const companionControlVersion = 2 as const;
export const maxCompanionControlRecordBytes = 4096;

const identifierSchema = z.string().trim().min(1).max(256);
const generationSchema = z.int().nonnegative().safe();
const nonceSchema = z
	.string()
	.min(8)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
const processVersionSchema = z.string().min(1).max(64);
const pidSchema = z.int().positive().safe();
const portSchema = z.int().min(1).max(65_535);
const absolutePathSchema = z.string().trim().min(1).max(2048);

export const processPeerIdentitySchema = z
	.object({
		role: z.enum(["agents", "client", "executor"]),
		peerId: identifierSchema,
		instanceId: identifierSchema,
		generation: generationSchema,
	})
	.strict();

export const bootstrapCredentialSchema = z
	.string()
	.min(43)
	.max(171)
	.regex(/^[A-Za-z0-9_-]+$/)
	.superRefine((value, context) => {
		const decoded = Buffer.from(value, "base64url");
		if (
			decoded.toString("base64url") !== value ||
			decoded.byteLength < 32 ||
			decoded.byteLength > 128
		) {
			context.addIssue({
				code: "custom",
				message: "Expected a canonical base64url credential encoding 32 to 128 bytes.",
			});
		}
	});

export const rpcCredentialBindingSchema = z
	.object({
		credential: bootstrapCredentialSchema,
		identity: processPeerIdentitySchema,
	})
	.strict();

export const agentsServerDataPathsSchema = z
	.object({
		productDatabase: absolutePathSchema,
		agentDataDirectory: absolutePathSchema,
	})
	.strict();

export const agentsServerEndpointSchema = z
	.object({
		host: z.literal("127.0.0.1"),
		port: portSchema,
		path: z.literal("/rpc"),
	})
	.strict();

export const agentsServerBootstrapRecordSchema = z
	.object({
		channel: z.literal(companionBootstrapChannel),
		controlVersion: z.literal(companionControlVersion),
		type: z.literal("START"),
		role: z.literal("agents-server"),
		nonce: nonceSchema,
		serverIdentity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
		peerBindings: z
			.array(rpcCredentialBindingSchema)
			.min(2)
			.max(4)
			.superRefine((bindings, context) => {
				const credentials = new Set<string>();
				const identities = new Set<string>();
				for (const [index, binding] of bindings.entries()) {
					if (binding.identity.role === "agents") {
						context.addIssue({
							code: "custom",
							message: "Agents-server peer bindings may only contain client or executor roles.",
							path: [index, "identity", "role"],
						});
					}
					if (credentials.has(binding.credential)) {
						context.addIssue({
							code: "custom",
							message: "Bootstrap credentials must be unique.",
							path: [index, "credential"],
						});
					}
					credentials.add(binding.credential);
					const identityKey = JSON.stringify(binding.identity);
					if (identities.has(identityKey)) {
						context.addIssue({
							code: "custom",
							message: "Bootstrap peer identities must be unique.",
							path: [index, "identity"],
						});
					}
					identities.add(identityKey);
				}
				if (!bindings.some((binding) => binding.identity.role === "client")) {
					context.addIssue({ code: "custom", message: "A client binding is required." });
				}
				if (!bindings.some((binding) => binding.identity.role === "executor")) {
					context.addIssue({ code: "custom", message: "An executor binding is required." });
				}
			}),
		paths: agentsServerDataPathsSchema,
	})
	.strict();

export const agentsServerReadyRecordSchema = z
	.object({
		channel: z.literal(companionBootstrapChannel),
		controlVersion: z.literal(companionControlVersion),
		type: z.literal("READY"),
		role: z.literal("agents-server"),
		pid: pidSchema,
		processVersion: processVersionSchema,
		nonce: nonceSchema,
		serverIdentity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
		endpoint: agentsServerEndpointSchema,
	})
	.strict();

export const executorBootstrapRecordSchema = z
	.object({
		channel: z.literal(companionBootstrapChannel),
		controlVersion: z.literal(companionControlVersion),
		type: z.literal("START"),
		role: z.literal("executor"),
		nonce: nonceSchema,
		identity: processPeerIdentitySchema.refine((identity) => identity.role === "executor"),
		credential: bootstrapCredentialSchema,
		agentsServer: z
			.object({
				identity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
				endpoint: agentsServerEndpointSchema,
			})
			.strict(),
	})
	.strict();

export const executorReadyRecordSchema = z
	.object({
		channel: z.literal(companionBootstrapChannel),
		controlVersion: z.literal(companionControlVersion),
		type: z.literal("READY"),
		role: z.literal("executor"),
		pid: pidSchema,
		processVersion: processVersionSchema,
		nonce: nonceSchema,
		identity: processPeerIdentitySchema.refine((identity) => identity.role === "executor"),
		agentsServer: z
			.object({
				identity: processPeerIdentitySchema.refine((identity) => identity.role === "agents"),
				endpoint: agentsServerEndpointSchema,
			})
			.strict(),
	})
	.strict();

export type ProcessPeerIdentity = z.infer<typeof processPeerIdentitySchema>;
export type RpcCredentialBinding = z.infer<typeof rpcCredentialBindingSchema>;
export type AgentsServerDataPaths = z.infer<typeof agentsServerDataPathsSchema>;
export type AgentsServerEndpoint = z.infer<typeof agentsServerEndpointSchema>;
export type AgentsServerBootstrapRecord = z.infer<typeof agentsServerBootstrapRecordSchema>;
export type AgentsServerReadyRecord = z.infer<typeof agentsServerReadyRecordSchema>;
export type ExecutorBootstrapRecord = z.infer<typeof executorBootstrapRecordSchema>;
export type ExecutorReadyRecord = z.infer<typeof executorReadyRecordSchema>;
export type CompanionReadyRecord = AgentsServerReadyRecord | ExecutorReadyRecord;

export function parseCompanionControlRecord<T>(
	input: string,
	schema: z.ZodType<T>,
	label: string,
): T {
	if (new TextEncoder().encode(input).byteLength > maxCompanionControlRecordBytes) {
		throw new Error(`${label} control record exceeds the byte limit.`);
	}
	const withoutLineFeed = input.endsWith("\n") ? input.slice(0, -1) : input;
	const record = withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
	if (record.length === 0 || record.includes("\n") || record.includes("\r")) {
		throw new Error(`Expected exactly one ${label} control record.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(record);
	} catch {
		throw new Error(`${label} control record is not valid JSON.`);
	}
	return schema.parse(parsed);
}

export function serializeCompanionControlRecord<T>(record: T, schema: z.ZodType<T>): Uint8Array {
	const parsed = schema.parse(record);
	const bytes = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
	if (bytes.byteLength > maxCompanionControlRecordBytes) {
		throw new Error("Companion control record exceeds the byte limit.");
	}
	return bytes;
}

export function redactCompanionControlRecord(record: unknown): unknown {
	if (Array.isArray(record)) {
		return record.map(redactCompanionControlRecord);
	}
	if (typeof record !== "object" || record === null) {
		return record;
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			key === "credential" || key === "paths" ? "[REDACTED]" : redactCompanionControlRecord(value),
		]),
	);
}
