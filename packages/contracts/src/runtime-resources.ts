import { z } from "zod";

import { runtimeBoxIdSchema } from "./runtime-box";

const textEncoder = new TextEncoder();
export const maxRuntimeBoxInventoryResources = 512;
const maxInventoryChanges = 128;
const maxMcpToolsPerServer = 256;
const maxSkillFiles = 256;
const maxSkillPackageBytes = 2 * 1024 * 1024;
export const maxRuntimeBoxSkillMarkdownBytes = 512 * 1024;
export const maxRuntimeBoxSkillFileBytes = 1024 * 1024;
export const maxEffectiveSkillMarkdownBytes = 2 * 1024 * 1024;
export const maxRuntimeBoxMcpSecretFileBytes = 2 * 1024 * 1024;
export const maxRuntimeBoxInventoryPayloadBytes = 7 * 512 * 1024;
const maxMcpToolSchemaBytes = 256 * 1024;

export const runtimeResourceKindSchema = z.enum(["mcp", "skill"]);
export const runtimeResourceIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const runtimeResourceVersionSchema = z.string().uuid();
export const runtimeResourceContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeInventoryEpochSchema = z.string().uuid();
export const runtimeInventoryRevisionSchema = z.int().nonnegative().safe();
export const runtimeInventoryCategorySchema = z.enum([
	"capability",
	"mcp",
	"mcp_tool_schema",
	"skill",
]);
export const runtimeResourceHealthSchema = z.enum(["ready", "stopped", "error"]);
export const mcpToolArgumentsSchema = z.json();
const mcpToolInputSchemaSchema = z
	.record(z.string(), z.json())
	.refine((value) => value.type === "object", "MCP Tool input Schema must describe an object.");

export const mcpToolDescriptorSchema = z
	.object({
		stableToolId: runtimeResourceIdSchema,
		name: z.string().trim().min(1).max(128),
		description: z.string().trim().max(2_048).optional(),
		schemaHash: runtimeResourceContentHashSchema,
		inputSchema: mcpToolInputSchemaSchema,
		outputSchema: z.json().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxMcpToolSchemaBytes) {
			context.addIssue({
				code: "custom",
				message: "MCP Tool descriptor exceeds the Schema byte limit.",
			});
		}
	});

export const runtimeBoxMcpInventoryResourceSchema = z
	.object({
		resourceKind: z.literal("mcp"),
		stableResourceId: runtimeResourceIdSchema,
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		health: runtimeResourceHealthSchema,
		credentialConfigured: z.boolean(),
		mcpTools: z.array(mcpToolDescriptorSchema).max(maxMcpToolsPerServer),
	})
	.strict();

export const runtimeBoxSkillInventoryResourceSchema = z
	.object({
		resourceKind: z.literal("skill"),
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		health: runtimeResourceHealthSchema,
	})
	.strict();

export const runtimeBoxInventoryResourceSchema = z.discriminatedUnion("resourceKind", [
	runtimeBoxMcpInventoryResourceSchema,
	runtimeBoxSkillInventoryResourceSchema,
]);

export const runtimeBoxInventorySnapshotSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		runtimeBoxGeneration: z.int().nonnegative().safe(),
		inventoryEpoch: runtimeInventoryEpochSchema,
		inventoryRevision: runtimeInventoryRevisionSchema,
		generatedAt: z.string().datetime({ offset: true }),
		capabilities: z.array(z.string().min(1).max(128)).max(128),
		resources: z.array(runtimeBoxInventoryResourceSchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxRuntimeBoxInventoryPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: "Runtime Box inventory snapshot exceeds the payload limit.",
			});
		}
	});

export const runtimeBoxInventoryChangedHintSchema = z
	.object({
		inventoryEpoch: runtimeInventoryEpochSchema,
		inventoryRevision: runtimeInventoryRevisionSchema,
		categories: z.array(runtimeInventoryCategorySchema).min(1).max(4),
	})
	.strict();

export const runtimeBoxInventoryTombstoneSchema = z
	.object({
		resourceKind: runtimeResourceKindSchema,
		stableResourceId: runtimeResourceIdSchema,
		deletedVersion: runtimeResourceVersionSchema.optional(),
	})
	.strict();

export const runtimeBoxInventoryChangeSchema = z
	.object({
		revision: runtimeInventoryRevisionSchema,
		category: runtimeInventoryCategorySchema,
		operation: z.enum(["upsert", "delete"]),
		stableResourceId: runtimeResourceIdSchema.optional(),
		descriptor: runtimeBoxInventoryResourceSchema.optional(),
		capabilities: z.array(z.string().min(1).max(128)).max(128).optional(),
		tombstone: runtimeBoxInventoryTombstoneSchema.optional(),
	})
	.strict()
	.superRefine((change, context) => {
		if (change.category === "capability") {
			if (change.operation !== "upsert" || change.capabilities === undefined) {
				context.addIssue({
					code: "custom",
					message: "Capability changes must upsert a capability list.",
				});
			}
			if (
				change.stableResourceId !== undefined ||
				change.descriptor !== undefined ||
				change.tombstone !== undefined
			) {
				context.addIssue({
					code: "custom",
					message: "Capability changes cannot carry resource fields.",
				});
			}
			return;
		}
		if (change.capabilities !== undefined || change.stableResourceId === undefined) {
			context.addIssue({
				code: "custom",
				message: "Resource changes require stableResourceId and cannot carry capabilities.",
			});
		}
		if (change.operation === "upsert") {
			if (
				change.descriptor === undefined ||
				change.tombstone !== undefined ||
				change.descriptor.stableResourceId !== change.stableResourceId
			) {
				context.addIssue({
					code: "custom",
					message: "Resource upserts require a matching descriptor.",
				});
			}
		} else if (
			change.tombstone === undefined ||
			change.descriptor !== undefined ||
			change.tombstone.stableResourceId !== change.stableResourceId
		) {
			context.addIssue({
				code: "custom",
				message: "Resource deletes require a matching tombstone.",
			});
		}
	});

export const getRuntimeBoxInventoryChangesInputSchema = z
	.object({
		inventoryEpoch: runtimeInventoryEpochSchema,
		fromRevisionExclusive: runtimeInventoryRevisionSchema,
		cursor: z.string().min(1).max(2_048).optional(),
	})
	.strict();

export const runtimeBoxInventoryChangesPageSchema = z
	.object({
		inventoryEpoch: runtimeInventoryEpochSchema,
		fromRevisionExclusive: runtimeInventoryRevisionSchema,
		throughRevision: runtimeInventoryRevisionSchema,
		oldestAvailableRevision: runtimeInventoryRevisionSchema,
		changes: z.array(runtimeBoxInventoryChangeSchema).max(maxInventoryChanges),
		nextCursor: z.string().min(1).max(2_048).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxRuntimeBoxInventoryPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: "Runtime Box inventory changes page exceeds the payload limit.",
			});
		}
	});

const environmentNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const headerNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
const boundedStringMap = (key: z.ZodType<string>, maxEntries: number, maxValueLength: number) =>
	z.record(key, z.string().max(maxValueLength)).superRefine((value, context) => {
		if (Object.keys(value).length > maxEntries) {
			context.addIssue({
				code: "custom",
				message: `Map cannot contain more than ${maxEntries} entries.`,
			});
		}
	});

export const mcpStdioTransportConfigSchema = z
	.object({
		type: z.literal("stdio"),
		command: z.string().trim().min(1).max(4_096),
		args: z.array(z.string().max(4_096)).max(64),
		cwd: z.string().min(1).max(32_768).optional(),
		environmentKeys: z.array(environmentNameSchema).max(64).optional(),
		startupTimeoutMs: z.int().min(1_000).max(120_000),
	})
	.strict();

const mcpRemoteUrlSchema = z
	.string()
	.url()
	.max(4_096)
	.refine((value) => {
		const url = new URL(value);
		if (url.username.length > 0 || url.password.length > 0) {
			return false;
		}
		return (
			url.protocol === "https:" ||
			(url.protocol === "http:" &&
				(url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost"))
		);
	}, "MCP URL must use HTTPS, except for loopback HTTP.");

const mcpRemoteTransportFields = {
	url: mcpRemoteUrlSchema,
	headerNames: z.array(headerNameSchema).max(64).optional(),
	timeoutMs: z.int().min(1_000).max(120_000),
};

export const mcpHttpTransportConfigSchema = z
	.object({ type: z.literal("streamable-http"), ...mcpRemoteTransportFields })
	.strict();
export const mcpSseTransportConfigSchema = z
	.object({ type: z.literal("sse"), ...mcpRemoteTransportFields })
	.strict();
export const mcpTransportConfigSchema = z.discriminatedUnion("type", [
	mcpStdioTransportConfigSchema,
	mcpHttpTransportConfigSchema,
	mcpSseTransportConfigSchema,
]);

export const mcpSecretInputSchema = z
	.object({
		environment: boundedStringMap(environmentNameSchema, 64, 16_384).optional(),
		headers: boundedStringMap(headerNameSchema, 64, 16_384).optional(),
	})
	.strict()
	.refine(
		(value) => value.environment !== undefined || value.headers !== undefined,
		"At least one MCP secret value is required.",
	)
	.superRefine((value, context) => {
		const encodedBytes = textEncoder.encode(
			JSON.stringify({
				schemaVersion: 1,
				resourceId: "x".repeat(128),
				value,
			}),
		).byteLength;
		if (encodedBytes > maxRuntimeBoxMcpSecretFileBytes) {
			context.addIssue({
				code: "custom",
				message: "MCP secret exceeds the encoded byte limit.",
			});
		}
	});

export const runtimeBoxMcpServerSchema = z
	.object({
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		displayName: z.string().trim().min(1).max(128),
		enabled: z.boolean(),
		transport: mcpTransportConfigSchema,
		credentialConfigured: z.boolean(),
		health: runtimeResourceHealthSchema,
		tools: z.array(mcpToolDescriptorSchema).max(maxMcpToolsPerServer),
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict();

export const listRuntimeBoxMcpServersInputSchema = z
	.object({ runtimeBoxId: runtimeBoxIdSchema.optional() })
	.strict();
export const listRuntimeBoxMcpServersOutputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		items: z.array(runtimeBoxMcpServerSchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxRuntimeBoxInventoryPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: "MCP Server query exceeds the payload limit.",
			});
		}
	});

export const runtimeBoxMcpServerSummarySchema = runtimeBoxMcpServerSchema.omit({
	transport: true,
	createdAt: true,
	updatedAt: true,
});
export const listRuntimeBoxMcpServerSummariesOutputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		items: z.array(runtimeBoxMcpServerSummarySchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict();

export const upsertRuntimeBoxMcpServerInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema.optional(),
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema.optional(),
		displayName: z.string().trim().min(1).max(128),
		enabled: z.boolean(),
		transport: mcpTransportConfigSchema,
		secret: mcpSecretInputSchema.optional(),
		clearSecret: z.boolean().optional(),
	})
	.strict()
	.refine(
		(input) => input.secret === undefined || input.clearSecret !== true,
		"Cannot set and clear an MCP secret in the same command.",
	);

export const setRuntimeBoxMcpServerEnabledInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema.optional(),
		enabled: z.boolean(),
	})
	.strict();

export const deleteRuntimeBoxMcpServerInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema.optional(),
		deleteCredentials: z.boolean(),
	})
	.strict();

export const runtimeBoxResourceMutationResultSchema = z
	.object({
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		inventoryEpoch: runtimeInventoryEpochSchema,
		inventoryRevision: runtimeInventoryRevisionSchema,
		descriptor: runtimeBoxInventoryResourceSchema.optional(),
		deleted: z.boolean(),
	})
	.strict();

export const skillMetadataSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		description: z.string().trim().min(1).max(1_024),
		license: z.string().trim().max(256).optional(),
		compatibility: z.string().trim().max(1_024).optional(),
		allowedTools: z.array(z.string().trim().min(1).max(128)).max(128),
		metadata: boundedStringMap(z.string().min(1).max(128), 64, 4_096),
	})
	.strict();

export const runtimeBoxSkillSchema = z
	.object({
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		metadata: skillMetadataSchema,
		enabled: z.boolean(),
		source: z.string().trim().min(1).max(2_048),
		installedAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict();

export const skillPackageFileSchema = z
	.object({
		path: z
			.string()
			.min(1)
			.max(1_024)
			.refine(
				(value) =>
					!value.startsWith("/") &&
					!value.includes("\\") &&
					value
						.split("/")
						.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
				"Skill file path must be a normalized relative POSIX path.",
			),
		encoding: z.enum(["utf8", "base64"]),
		content: z.string().max(1024 * 1024),
		executable: z.boolean(),
	})
	.strict();

export const installRuntimeBoxSkillInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema.optional(),
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema.optional(),
		source: z.string().trim().min(1).max(2_048),
		enabled: z.boolean(),
		files: z
			.array(skillPackageFileSchema)
			.min(1)
			.max(maxSkillFiles)
			.superRefine((files, context) => {
				const paths = new Set<string>();
				let totalBytes = 0;
				for (const [index, file] of files.entries()) {
					if (paths.has(file.path)) {
						context.addIssue({
							code: "custom",
							message: "Skill package file paths must be unique.",
							path: [index, "path"],
						});
					}
					paths.add(file.path);
					const fileBytes =
						file.encoding === "base64"
							? Math.floor((file.content.length * 3) / 4)
							: textEncoder.encode(file.content).byteLength;
					totalBytes += fileBytes;
					if (fileBytes > maxRuntimeBoxSkillFileBytes) {
						context.addIssue({
							code: "custom",
							message: "Skill file exceeds the decoded byte limit.",
							path: [index, "content"],
						});
					}
					if (file.path === "SKILL.md" && fileBytes > maxRuntimeBoxSkillMarkdownBytes) {
						context.addIssue({
							code: "custom",
							message: "SKILL.md exceeds the content byte limit.",
							path: [index, "content"],
						});
					}
				}
				if (!paths.has("SKILL.md")) {
					context.addIssue({
						code: "custom",
						message: "Skill package must contain SKILL.md.",
					});
				}
				if (totalBytes > maxSkillPackageBytes) {
					context.addIssue({
						code: "custom",
						message: "Skill package exceeds the aggregate byte limit.",
					});
				}
			}),
	})
	.strict();

export const setRuntimeBoxSkillEnabledInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe(),
		enabled: z.boolean(),
	})
	.strict();

export const listRuntimeBoxSkillsInputSchema = z
	.object({ runtimeBoxId: runtimeBoxIdSchema.optional() })
	.strict();
export const listRuntimeBoxSkillsOutputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		items: z.array(runtimeBoxSkillSchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxRuntimeBoxInventoryPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: "Skill query exceeds the payload limit.",
			});
		}
	});

export const deleteRuntimeBoxSkillInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema,
	})
	.strict();

export const runtimeBoxResourceRefSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		resourceKind: runtimeResourceKindSchema,
		stableResourceId: runtimeResourceIdSchema,
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
	})
	.strict();

export const validateRuntimeBoxResourcesInputSchema = z
	.object({
		refs: z.array(runtimeBoxResourceRefSchema).max(256),
	})
	.strict();

export const runtimeBoxResourceValidationIssueSchema = z
	.object({
		ref: runtimeBoxResourceRefSchema,
		code: z.enum([
			"WRONG_RUNTIME_BOX",
			"MISSING",
			"VERSION_MISMATCH",
			"HASH_MISMATCH",
			"NOT_READY",
		]),
		message: z.string().min(1).max(1_024),
	})
	.strict();

export const validateRuntimeBoxResourcesOutputSchema = z
	.object({
		valid: z.boolean(),
		resources: z.array(runtimeBoxInventoryResourceSchema).max(256),
		issues: z.array(runtimeBoxResourceValidationIssueSchema).max(256),
	})
	.strict();

export const getRuntimeBoxSkillContentInputSchema = z
	.object({ ref: runtimeBoxResourceRefSchema })
	.strict()
	.refine((input) => input.ref.resourceKind === "skill", "Skill content requires a Skill ref.");
export const getRuntimeBoxSkillContentOutputSchema = z
	.object({
		ref: runtimeBoxResourceRefSchema,
		metadata: skillMetadataSchema,
		skillMarkdown: z
			.string()
			.min(1)
			.max(maxRuntimeBoxSkillMarkdownBytes)
			.superRefine((value, context) => {
				if (textEncoder.encode(value).byteLength > maxRuntimeBoxSkillMarkdownBytes) {
					context.addIssue({
						code: "custom",
						message: "SKILL.md exceeds the content byte limit.",
					});
				}
			}),
	})
	.strict();

export const runtimeProfileSchema = z
	.object({
		agentId: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
		runtimeBoxId: runtimeBoxIdSchema,
		revision: z.int().positive().safe(),
		resources: z.array(runtimeBoxResourceRefSchema).max(256),
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((profile, context) => {
		const keys = new Set<string>();
		for (const [index, ref] of profile.resources.entries()) {
			if (ref.runtimeBoxId !== profile.runtimeBoxId) {
				context.addIssue({
					code: "custom",
					message: "Runtime Profile resources must belong to the same Runtime Box.",
					path: ["resources", index, "runtimeBoxId"],
				});
			}
			const key = `${ref.resourceKind}:${ref.stableResourceId}`;
			if (keys.has(key)) {
				context.addIssue({
					code: "custom",
					message: "Runtime Profile resource refs must be unique.",
					path: ["resources", index],
				});
			}
			keys.add(key);
		}
	});

export const getRuntimeProfileInputSchema = z
	.object({
		agentId: runtimeProfileSchema.shape.agentId.default("moshu.default"),
		runtimeBoxId: runtimeBoxIdSchema.optional(),
	})
	.strict();
export const getRuntimeProfileOutputSchema = z.object({ profile: runtimeProfileSchema }).strict();
export const updateRuntimeProfileInputSchema = z
	.object({
		agentId: runtimeProfileSchema.shape.agentId.default("moshu.default"),
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		expectedRevision: z.int().positive().safe(),
		resources: z.array(runtimeBoxResourceRefSchema).max(256),
	})
	.strict()
	.superRefine((input, context) => {
		const keys = new Set<string>();
		for (const [index, ref] of input.resources.entries()) {
			if (input.runtimeBoxId !== undefined && ref.runtimeBoxId !== input.runtimeBoxId) {
				context.addIssue({
					code: "custom",
					message: "Runtime Profile resources must belong to the selected Runtime Box.",
					path: ["resources", index, "runtimeBoxId"],
				});
			}
			const key = `${ref.resourceKind}:${ref.stableResourceId}`;
			if (keys.has(key)) {
				context.addIssue({
					code: "custom",
					message: "Runtime Profile resource refs must be unique.",
					path: ["resources", index],
				});
			}
			keys.add(key);
		}
	});
export const updateRuntimeProfileOutputSchema = getRuntimeProfileOutputSchema;

export const listRuntimeBoxInventoryInputSchema = z
	.object({ runtimeBoxId: runtimeBoxIdSchema.optional() })
	.strict();
export const listRuntimeBoxInventoryOutputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema,
		inventoryEpoch: runtimeInventoryEpochSchema.optional(),
		inventoryRevision: runtimeInventoryRevisionSchema.optional(),
		stale: z.boolean(),
		resources: z.array(runtimeBoxInventoryResourceSchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict();

export const agentServerResourceOwnerSchema = z
	.object({ kind: z.literal("agent-server") })
	.strict();
export const runtimeBoxResourceOwnerSchema = z
	.object({
		kind: z.literal("runtime-box"),
		runtimeBoxId: runtimeBoxIdSchema,
	})
	.strict();
export const resourceOwnerSchema = z.discriminatedUnion("kind", [
	agentServerResourceOwnerSchema,
	runtimeBoxResourceOwnerSchema,
]);
export const agentServerMcpOwnerSchema = agentServerResourceOwnerSchema;
export const runtimeBoxMcpOwnerSchema = runtimeBoxResourceOwnerSchema;
export const mcpOwnerSchema = resourceOwnerSchema;
export const agentServerSkillOwnerSchema = agentServerResourceOwnerSchema;
export const runtimeBoxSkillOwnerSchema = runtimeBoxResourceOwnerSchema;
export const skillOwnerSchema = resourceOwnerSchema;

export const mcpServerSummarySchema = z
	.object({
		owner: mcpOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		displayName: z.string().trim().min(1).max(128),
		enabled: z.boolean(),
		credentialConfigured: z.boolean(),
		health: runtimeResourceHealthSchema,
		tools: z.array(mcpToolDescriptorSchema).max(maxMcpToolsPerServer),
		stale: z.boolean(),
	})
	.strict();

export const listMcpServersInputSchema = z.object({ owner: mcpOwnerSchema }).strict();
export const listMcpServersOutputSchema = z
	.object({
		owner: mcpOwnerSchema,
		items: z.array(mcpServerSummarySchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict()
	.superRefine((value, context) => {
		for (const [index, item] of value.items.entries()) {
			if (mcpOwnerKey(item.owner) !== mcpOwnerKey(value.owner)) {
				context.addIssue({
					code: "custom",
					message: "MCP Server summary owner does not match the requested owner.",
					path: ["items", index, "owner"],
				});
			}
		}
	});

export const upsertMcpServerInputSchema = z
	.object({
		owner: mcpOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema.optional(),
		expectedConfigRevision: z.int().positive().safe().optional(),
		displayName: z.string().trim().min(1).max(128),
		enabled: z.boolean(),
		transport: mcpTransportConfigSchema,
		secret: mcpSecretInputSchema.optional(),
		clearSecret: z.boolean().optional(),
	})
	.strict()
	.refine(
		(input) => input.secret === undefined || input.clearSecret !== true,
		"Cannot set and clear an MCP secret in the same command.",
	);

export const setMcpServerEnabledInputSchema = z
	.object({
		owner: mcpOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe(),
		enabled: z.boolean(),
	})
	.strict();

export const deleteMcpServerInputSchema = z
	.object({
		owner: mcpOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe(),
		deleteCredentials: z.boolean(),
	})
	.strict();

export const mcpServerMutationResultSchema = z
	.object({
		owner: mcpOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		deleted: z.boolean(),
		summary: mcpServerSummarySchema.optional(),
	})
	.strict();

export const skillSourceKindSchema = z.enum(["inline-editor", "local-upload", "import"]);
export const skillSourceInputSchema = z
	.object({
		kind: skillSourceKindSchema,
		label: z.string().trim().min(1).max(256).optional(),
	})
	.strict();
export const skillPackageKindSchema = z.enum(["prompt-only", "runtime-package"]);
export const skillSummarySchema = z
	.object({
		owner: skillOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		metadata: skillMetadataSchema.optional(),
		enabled: z.boolean(),
		health: runtimeResourceHealthSchema,
		packageKind: skillPackageKindSchema,
		sourceKind: skillSourceKindSchema,
		sourceLabel: z.string().trim().min(1).max(256).optional(),
		stale: z.boolean(),
		installedAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
		lastErrorCode: z.string().trim().min(1).max(128).optional(),
	})
	.strict();

export const listSkillsInputSchema = z.object({ owner: skillOwnerSchema }).strict();
export const listSkillsOutputSchema = z
	.object({
		owner: skillOwnerSchema,
		items: z.array(skillSummarySchema).max(maxRuntimeBoxInventoryResources),
	})
	.strict()
	.superRefine((value, context) => {
		for (const [index, item] of value.items.entries()) {
			if (resourceOwnerKey(item.owner) !== resourceOwnerKey(value.owner)) {
				context.addIssue({
					code: "custom",
					message: "Skill summary owner does not match the requested owner.",
					path: ["items", index, "owner"],
				});
			}
		}
	});

export const upsertSkillInputSchema = z
	.object({
		owner: skillOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema.optional(),
		expectedConfigRevision: z.int().positive().safe().optional(),
		expectedVersion: runtimeResourceVersionSchema.optional(),
		source: skillSourceInputSchema,
		enabled: z.boolean(),
		files: installRuntimeBoxSkillInputSchema.shape.files,
	})
	.strict()
	.superRefine((input, context) => {
		if ((input.expectedConfigRevision === undefined) !== (input.expectedVersion === undefined)) {
			context.addIssue({
				code: "custom",
				message: "Skill updates require both expectedConfigRevision and expectedVersion.",
				path: ["expectedVersion"],
			});
		}
	});

export const setSkillEnabledInputSchema = z
	.object({
		owner: skillOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe(),
		enabled: z.boolean(),
	})
	.strict();

export const deleteSkillInputSchema = z
	.object({
		owner: skillOwnerSchema,
		commandId: z.string().uuid(),
		stableResourceId: runtimeResourceIdSchema,
		expectedConfigRevision: z.int().positive().safe(),
		expectedVersion: runtimeResourceVersionSchema,
	})
	.strict();

export const skillMutationResultSchema = z
	.object({
		owner: skillOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		configRevision: z.int().positive().safe(),
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
		deleted: z.boolean(),
		summary: skillSummarySchema.optional(),
	})
	.strict();

export const agentServerMcpResourceRefSchema = z
	.object({
		owner: agentServerMcpOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
	})
	.strict();

export const agentServerSkillResourceRefSchema = z
	.object({
		owner: agentServerSkillOwnerSchema,
		stableResourceId: runtimeResourceIdSchema,
		version: runtimeResourceVersionSchema,
		contentHash: runtimeResourceContentHashSchema,
	})
	.strict();

export const skillResourceRefSchema = z.union([
	z
		.object({
			owner: agentServerSkillOwnerSchema,
			stableResourceId: runtimeResourceIdSchema,
			version: runtimeResourceVersionSchema,
			contentHash: runtimeResourceContentHashSchema,
		})
		.strict(),
	z
		.object({
			owner: runtimeBoxSkillOwnerSchema,
			stableResourceId: runtimeResourceIdSchema,
			version: runtimeResourceVersionSchema,
			contentHash: runtimeResourceContentHashSchema,
		})
		.strict(),
]);

export const agentGlobalProfileSchema = z
	.object({
		agentId: runtimeProfileSchema.shape.agentId,
		revision: z.int().positive().safe(),
		serverMcpRefs: z.array(agentServerMcpResourceRefSchema).max(256),
		serverSkillRefs: z.array(agentServerSkillResourceRefSchema).max(256),
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((profile, context) => {
		const ids = new Set<string>();
		for (const [index, ref] of profile.serverMcpRefs.entries()) {
			if (ids.has(ref.stableResourceId)) {
				context.addIssue({
					code: "custom",
					message: "Agent global MCP refs must be unique.",
					path: ["serverMcpRefs", index],
				});
			}
			ids.add(ref.stableResourceId);
		}
		const skillIds = new Set<string>();
		for (const [index, ref] of profile.serverSkillRefs.entries()) {
			if (skillIds.has(ref.stableResourceId)) {
				context.addIssue({
					code: "custom",
					message: "Agent global Skill refs must be unique.",
					path: ["serverSkillRefs", index],
				});
			}
			skillIds.add(ref.stableResourceId);
		}
	});

export const getAgentGlobalProfileInputSchema = z
	.object({ agentId: runtimeProfileSchema.shape.agentId.default("moshu.default") })
	.strict();
export const getAgentGlobalProfileOutputSchema = z
	.object({ profile: agentGlobalProfileSchema })
	.strict();
export const updateAgentGlobalProfileInputSchema = z
	.object({
		agentId: runtimeProfileSchema.shape.agentId.default("moshu.default"),
		expectedRevision: z.int().positive().safe(),
		serverMcpRefs: z.array(agentServerMcpResourceRefSchema).max(256),
		serverSkillRefs: z.array(agentServerSkillResourceRefSchema).max(256),
	})
	.strict()
	.superRefine((input, context) => {
		const ids = new Set<string>();
		for (const [index, ref] of input.serverMcpRefs.entries()) {
			if (ids.has(ref.stableResourceId)) {
				context.addIssue({
					code: "custom",
					message: "Agent global MCP refs must be unique.",
					path: ["serverMcpRefs", index],
				});
			}
			ids.add(ref.stableResourceId);
		}
		const skillIds = new Set<string>();
		for (const [index, ref] of input.serverSkillRefs.entries()) {
			if (skillIds.has(ref.stableResourceId)) {
				context.addIssue({
					code: "custom",
					message: "Agent global Skill refs must be unique.",
					path: ["serverSkillRefs", index],
				});
			}
			skillIds.add(ref.stableResourceId);
		}
	});
export const updateAgentGlobalProfileOutputSchema = getAgentGlobalProfileOutputSchema;

export function resourceOwnerKey(owner: z.infer<typeof resourceOwnerSchema>): string {
	return owner.kind === "agent-server" ? owner.kind : `${owner.kind}:${owner.runtimeBoxId}`;
}

const mcpOwnerKey = resourceOwnerKey;

export type RuntimeResourceKind = z.infer<typeof runtimeResourceKindSchema>;
export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;
export type McpTransportConfig = z.infer<typeof mcpTransportConfigSchema>;
export type McpSecretInput = z.infer<typeof mcpSecretInputSchema>;
export type RuntimeBoxInventoryResource = z.infer<typeof runtimeBoxInventoryResourceSchema>;
export type RuntimeBoxInventorySnapshot = z.infer<typeof runtimeBoxInventorySnapshotSchema>;
export type RuntimeBoxInventoryChangedHint = z.infer<typeof runtimeBoxInventoryChangedHintSchema>;
export type RuntimeBoxInventoryChange = z.infer<typeof runtimeBoxInventoryChangeSchema>;
export type GetRuntimeBoxInventoryChangesInput = z.infer<
	typeof getRuntimeBoxInventoryChangesInputSchema
>;
export type RuntimeBoxInventoryChangesPage = z.infer<typeof runtimeBoxInventoryChangesPageSchema>;
export type RuntimeBoxMcpServer = z.infer<typeof runtimeBoxMcpServerSchema>;
export type RuntimeBoxMcpServerSummary = z.infer<typeof runtimeBoxMcpServerSummarySchema>;
export type ListRuntimeBoxMcpServersInput = z.infer<typeof listRuntimeBoxMcpServersInputSchema>;
export type ListRuntimeBoxMcpServersOutput = z.infer<typeof listRuntimeBoxMcpServersOutputSchema>;
export type ListRuntimeBoxMcpServerSummariesOutput = z.infer<
	typeof listRuntimeBoxMcpServerSummariesOutputSchema
>;
export type UpsertRuntimeBoxMcpServerInput = z.infer<typeof upsertRuntimeBoxMcpServerInputSchema>;
export type SetRuntimeBoxMcpServerEnabledInput = z.infer<
	typeof setRuntimeBoxMcpServerEnabledInputSchema
>;
export type DeleteRuntimeBoxMcpServerInput = z.infer<typeof deleteRuntimeBoxMcpServerInputSchema>;
export type RuntimeBoxResourceMutationResult = z.infer<
	typeof runtimeBoxResourceMutationResultSchema
>;
export type RuntimeBoxSkill = z.infer<typeof runtimeBoxSkillSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type SkillPackageFile = z.infer<typeof skillPackageFileSchema>;
export type ListRuntimeBoxSkillsInput = z.infer<typeof listRuntimeBoxSkillsInputSchema>;
export type ListRuntimeBoxSkillsOutput = z.infer<typeof listRuntimeBoxSkillsOutputSchema>;
export type InstallRuntimeBoxSkillInput = z.infer<typeof installRuntimeBoxSkillInputSchema>;
export type SetRuntimeBoxSkillEnabledInput = z.infer<typeof setRuntimeBoxSkillEnabledInputSchema>;
export type DeleteRuntimeBoxSkillInput = z.infer<typeof deleteRuntimeBoxSkillInputSchema>;
export type RuntimeBoxResourceRef = z.infer<typeof runtimeBoxResourceRefSchema>;
export type ValidateRuntimeBoxResourcesInput = z.infer<
	typeof validateRuntimeBoxResourcesInputSchema
>;
export type ValidateRuntimeBoxResourcesOutput = z.infer<
	typeof validateRuntimeBoxResourcesOutputSchema
>;
export type GetRuntimeBoxSkillContentInput = z.infer<typeof getRuntimeBoxSkillContentInputSchema>;
export type GetRuntimeBoxSkillContentOutput = z.infer<typeof getRuntimeBoxSkillContentOutputSchema>;
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type GetRuntimeProfileInput = z.infer<typeof getRuntimeProfileInputSchema>;
export type GetRuntimeProfileOutput = z.infer<typeof getRuntimeProfileOutputSchema>;
export type UpdateRuntimeProfileInput = z.infer<typeof updateRuntimeProfileInputSchema>;
export type ListRuntimeBoxInventoryOutput = z.infer<typeof listRuntimeBoxInventoryOutputSchema>;
export type McpOwner = z.infer<typeof mcpOwnerSchema>;
export type ResourceOwner = z.infer<typeof resourceOwnerSchema>;
export type SkillOwner = z.infer<typeof skillOwnerSchema>;
export type SkillSourceInput = z.infer<typeof skillSourceInputSchema>;
export type SkillPackageKind = z.infer<typeof skillPackageKindSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type ListSkillsInput = z.infer<typeof listSkillsInputSchema>;
export type ListSkillsOutput = z.infer<typeof listSkillsOutputSchema>;
export type UpsertSkillInput = z.infer<typeof upsertSkillInputSchema>;
export type SetSkillEnabledInput = z.infer<typeof setSkillEnabledInputSchema>;
export type DeleteSkillInput = z.infer<typeof deleteSkillInputSchema>;
export type SkillMutationResult = z.infer<typeof skillMutationResultSchema>;
export type AgentServerSkillResourceRef = z.infer<typeof agentServerSkillResourceRefSchema>;
export type SkillResourceRef = z.infer<typeof skillResourceRefSchema>;
export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type ListMcpServersInput = z.infer<typeof listMcpServersInputSchema>;
export type ListMcpServersOutput = z.infer<typeof listMcpServersOutputSchema>;
export type UpsertMcpServerInput = z.infer<typeof upsertMcpServerInputSchema>;
export type SetMcpServerEnabledInput = z.infer<typeof setMcpServerEnabledInputSchema>;
export type DeleteMcpServerInput = z.infer<typeof deleteMcpServerInputSchema>;
export type McpServerMutationResult = z.infer<typeof mcpServerMutationResultSchema>;
export type AgentServerMcpResourceRef = z.infer<typeof agentServerMcpResourceRefSchema>;
export type AgentGlobalProfile = z.infer<typeof agentGlobalProfileSchema>;
export type GetAgentGlobalProfileInput = z.infer<typeof getAgentGlobalProfileInputSchema>;
export type GetAgentGlobalProfileOutput = z.infer<typeof getAgentGlobalProfileOutputSchema>;
export type UpdateAgentGlobalProfileInput = z.infer<typeof updateAgentGlobalProfileInputSchema>;
export type UpdateAgentGlobalProfileOutput = z.infer<typeof updateAgentGlobalProfileOutputSchema>;
