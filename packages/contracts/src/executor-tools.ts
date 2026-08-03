import { z } from "zod";

import { toolCallIdSchema, uuidV7Schema } from "./contract-primitives";
import { runtimeResourceIdSchema } from "./runtime-resources";
import {
	runtimeResourceContentHashSchema,
	runtimeResourceVersionSchema,
} from "./runtime-resources";

export const executorToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const executorToolNameSchema = z.enum(executorToolNames);

export const executorToolDefaultTimeoutMs = 30 * 60_000;
export const executorToolRpcTimeoutMs = executorToolDefaultTimeoutMs + 15_000;
export const maxExecutorToolImageBase64Chars = 3 * 1024 * 1024;
export const maxExecutorToolPayloadBytes = 7 * 512 * 1024;
export const maxExecutorToolTextContentBytes = 128 * 1024;
export const maxExecutorToolEditDetailBytes = 256 * 1024;
export const maxExecutorToolResultPayloadBytes = 7 * 512 * 1024;

const maxPathBytes = 32 * 1024;
const maxToolStringBytes = 512 * 1024;
const textEncoder = new TextEncoder();

export const actionIdSchema = z.string().uuid();
export const executionGrantIdSchema = z.string().uuid();
export const executionGrantTokenSchema = z
	.string()
	.min(32)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
export const actionParameterDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const executorExecutionContextSchema = z.discriminatedUnion("executionScope", [
	z.object({ executionScope: z.literal("request-cwd") }).strict(),
	z.object({ executionScope: z.literal("runtime-box-workspace") }).strict(),
	z
		.object({
			executionScope: z.literal("project-root"),
			projectPathRevision: z.int().positive().safe(),
		})
		.strict(),
]);

const runtimeBoxToolAuthorizationBaseSchema = z.object({
	actionId: actionIdSchema,
	grantId: executionGrantIdSchema,
	grantToken: executionGrantTokenSchema,
	parameterDigest: actionParameterDigestSchema,
	originInstanceId: z.string().min(1).max(256),
	originGeneration: z.int().nonnegative().safe(),
	targetRuntimeBoxId: z.string().min(1).max(128),
	targetInstanceId: z.string().min(1).max(256),
	targetGeneration: z.int().nonnegative().safe(),
	expiresAt: z.string().datetime({ offset: true }),
});

export const runtimeBoxToolAuthorizationSchema = z.discriminatedUnion("executionScope", [
	runtimeBoxToolAuthorizationBaseSchema
		.extend({ executionScope: z.literal("request-cwd") })
		.strict(),
	runtimeBoxToolAuthorizationBaseSchema
		.extend({ executionScope: z.literal("runtime-box-workspace") })
		.strict(),
	runtimeBoxToolAuthorizationBaseSchema
		.extend({
			executionScope: z.literal("project-root"),
			projectPathRevision: z.int().positive().safe(),
		})
		.strict(),
]);

function boundedUtf8String(maxBytes: number, label: string, minimumBytes = 0) {
	return z
		.string()
		.max(maxBytes)
		.superRefine((value, context) => {
			const byteLength = textEncoder.encode(value).byteLength;
			if (byteLength < minimumBytes || byteLength > maxBytes) {
				context.addIssue({
					code: "custom",
					message: `${label} must encode to between ${minimumBytes} and ${maxBytes} UTF-8 bytes.`,
				});
			}
		});
}

const pathSchema = boundedUtf8String(maxPathBytes, "Path", 1);
const positiveSafeIntegerSchema = z.int().positive().safe();
const nonnegativeSafeIntegerSchema = z.int().nonnegative().safe();

export const executorReadToolArgumentsSchema = z
	.object({
		path: pathSchema,
		offset: positiveSafeIntegerSchema.optional(),
		limit: positiveSafeIntegerSchema.optional(),
	})
	.strict();

export const executorBashToolArgumentsSchema = z
	.object({
		command: boundedUtf8String(maxToolStringBytes, "Command", 1),
		timeout: z
			.number()
			.positive()
			.finite()
			.max(executorToolDefaultTimeoutMs / 1_000)
			.optional(),
	})
	.strict();

export const executorEditReplacementSchema = z
	.object({
		oldText: boundedUtf8String(maxToolStringBytes, "oldText", 1),
		newText: boundedUtf8String(maxToolStringBytes, "newText"),
	})
	.strict();

export const executorEditToolArgumentsSchema = z
	.object({
		path: pathSchema,
		edits: z.array(executorEditReplacementSchema).min(1).max(64),
	})
	.strict();

export const executorWriteToolArgumentsSchema = z
	.object({
		path: pathSchema,
		content: boundedUtf8String(maxToolStringBytes, "Content"),
	})
	.strict();

export const executorGrepToolArgumentsSchema = z
	.object({
		pattern: boundedUtf8String(maxToolStringBytes, "Pattern", 1),
		path: pathSchema.optional(),
		glob: boundedUtf8String(maxPathBytes, "Glob", 1).optional(),
		ignoreCase: z.boolean().optional(),
		literal: z.boolean().optional(),
		context: z.int().nonnegative().max(10_000).optional(),
		limit: z.int().positive().max(100_000).optional(),
	})
	.strict();

export const executorFindToolArgumentsSchema = z
	.object({
		pattern: boundedUtf8String(maxPathBytes, "Pattern", 1),
		path: pathSchema.optional(),
		limit: z.int().positive().max(100_000).optional(),
	})
	.strict();

export const executorLsToolArgumentsSchema = z
	.object({
		path: pathSchema.optional(),
		limit: z.int().positive().max(100_000).optional(),
	})
	.strict();

export const executorToolCallSchema = z.discriminatedUnion("tool", [
	z.object({ tool: z.literal("read"), arguments: executorReadToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("bash"), arguments: executorBashToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("edit"), arguments: executorEditToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("write"), arguments: executorWriteToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("grep"), arguments: executorGrepToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("find"), arguments: executorFindToolArgumentsSchema }).strict(),
	z.object({ tool: z.literal("ls"), arguments: executorLsToolArgumentsSchema }).strict(),
]);

export const runtimeBoxToolInvokeInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		invocationId: z.string().uuid(),
		runId: uuidV7Schema,
		toolCallId: toolCallIdSchema,
		cwd: pathSchema,
		call: executorToolCallSchema,
		authorization: runtimeBoxToolAuthorizationSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxExecutorToolPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: `Executor tool request exceeds the ${maxExecutorToolPayloadBytes}-byte payload limit.`,
			});
		}
	});

export const runtimeBoxMcpToolInvokeInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		invocationId: z.string().uuid(),
		runId: uuidV7Schema,
		toolCallId: toolCallIdSchema,
		mcpServerId: runtimeResourceIdSchema,
		mcpServerVersion: runtimeResourceVersionSchema,
		mcpServerContentHash: runtimeResourceContentHashSchema,
		stableToolId: runtimeResourceIdSchema,
		toolSchemaHash: runtimeResourceContentHashSchema,
		arguments: z.json(),
		authorization: runtimeBoxToolAuthorizationSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxExecutorToolPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: `MCP tool request exceeds the ${maxExecutorToolPayloadBytes}-byte payload limit.`,
			});
		}
	});

export const executorToolTextContentSchema = z
	.object({
		type: z.literal("text"),
		text: boundedUtf8String(maxExecutorToolTextContentBytes, "Tool text content"),
	})
	.strict();

const canonicalBase64Schema = z
	.string()
	.min(4)
	.max(maxExecutorToolImageBase64Chars)
	.superRefine((value, context) => {
		const decoded = Buffer.from(value, "base64");
		if (decoded.byteLength === 0 || decoded.toString("base64") !== value) {
			context.addIssue({
				code: "custom",
				message: "Image data must use canonical padded base64 encoding.",
			});
		}
	});

export const executorToolImageContentSchema = z
	.object({
		type: z.literal("image"),
		data: canonicalBase64Schema,
		mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
	})
	.strict();

export const executorToolContentSchema = z.discriminatedUnion("type", [
	executorToolTextContentSchema,
	executorToolImageContentSchema,
]);

export const executorToolTruncationSchema = z
	.object({
		content: boundedUtf8String(64 * 1024, "Truncated content"),
		truncated: z.boolean(),
		truncatedBy: z.enum(["lines", "bytes"]).nullable(),
		totalLines: nonnegativeSafeIntegerSchema,
		totalBytes: nonnegativeSafeIntegerSchema,
		outputLines: nonnegativeSafeIntegerSchema,
		outputBytes: nonnegativeSafeIntegerSchema,
		lastLinePartial: z.boolean(),
		firstLineExceedsLimit: z.boolean(),
		maxLines: positiveSafeIntegerSchema,
		maxBytes: positiveSafeIntegerSchema,
	})
	.strict();

export const executorReadToolDetailsSchema = z
	.object({
		truncation: executorToolTruncationSchema.optional(),
	})
	.strict();

export const executorBashToolDetailsSchema = z
	.object({
		truncation: executorToolTruncationSchema.optional(),
		fullOutputPath: pathSchema.optional(),
	})
	.strict();

export const executorEditToolDetailsSchema = z
	.object({
		diff: boundedUtf8String(maxExecutorToolEditDetailBytes, "Edit diff"),
		patch: boundedUtf8String(maxExecutorToolEditDetailBytes, "Edit patch"),
		firstChangedLine: positiveSafeIntegerSchema.optional(),
	})
	.strict();

export const executorGrepToolDetailsSchema = z
	.object({
		truncation: executorToolTruncationSchema.optional(),
		matchLimitReached: positiveSafeIntegerSchema.optional(),
		linesTruncated: z.boolean().optional(),
	})
	.strict();

export const executorFindToolDetailsSchema = z
	.object({
		truncation: executorToolTruncationSchema.optional(),
		resultLimitReached: positiveSafeIntegerSchema.optional(),
	})
	.strict();

export const executorLsToolDetailsSchema = z
	.object({
		truncation: executorToolTruncationSchema.optional(),
		entryLimitReached: positiveSafeIntegerSchema.optional(),
	})
	.strict();

const resultBase = {
	schemaVersion: z.literal(1),
	invocationId: z.string().uuid(),
};
const textResultContentSchema = z.array(executorToolTextContentSchema).min(1).max(1);

export const runtimeBoxToolInvokeOutputSchema = z
	.discriminatedUnion("tool", [
		z
			.object({
				...resultBase,
				tool: z.literal("read"),
				content: z.array(executorToolContentSchema).min(1).max(2),
				details: executorReadToolDetailsSchema.optional(),
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("bash"),
				content: textResultContentSchema,
				details: executorBashToolDetailsSchema.optional(),
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("edit"),
				content: textResultContentSchema,
				details: executorEditToolDetailsSchema,
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("write"),
				content: textResultContentSchema,
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("grep"),
				content: textResultContentSchema,
				details: executorGrepToolDetailsSchema.optional(),
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("find"),
				content: textResultContentSchema,
				details: executorFindToolDetailsSchema.optional(),
			})
			.strict(),
		z
			.object({
				...resultBase,
				tool: z.literal("ls"),
				content: textResultContentSchema,
				details: executorLsToolDetailsSchema.optional(),
			})
			.strict(),
	])
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxExecutorToolResultPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: `Executor tool result exceeds the ${maxExecutorToolResultPayloadBytes}-byte payload limit.`,
			});
		}
	});

export const runtimeBoxMcpToolInvokeOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		invocationId: z.string().uuid(),
		mcpServerId: runtimeResourceIdSchema,
		stableToolId: runtimeResourceIdSchema,
		result: z.json(),
		isError: z.boolean(),
	})
	.strict()
	.superRefine((value, context) => {
		if (textEncoder.encode(JSON.stringify(value)).byteLength > maxExecutorToolResultPayloadBytes) {
			context.addIssue({
				code: "custom",
				message: `MCP tool result exceeds the ${maxExecutorToolResultPayloadBytes}-byte payload limit.`,
			});
		}
	});

export const runtimeBoxActionResultSchema = z.union([
	runtimeBoxToolInvokeOutputSchema,
	runtimeBoxMcpToolInvokeOutputSchema,
]);

export const runtimeBoxToolProgressEventSchema = z
	.object({
		schemaVersion: z.literal(1),
		invocationId: z.string().uuid(),
		tool: z.literal("bash"),
		sequence: nonnegativeSafeIntegerSchema,
		content: z.array(executorToolTextContentSchema).max(1),
		details: executorBashToolDetailsSchema.optional(),
	})
	.strict();

export const runtimeBoxInvocationEvidenceStateSchema = z.enum([
	"succeeded",
	"failed",
	"cancelled",
	"outcome_unknown",
]);

export const runtimeBoxInvocationEvidenceSchema = z
	.object({
		invocationId: z.string().uuid(),
		actionId: actionIdSchema,
		grantId: executionGrantIdSchema,
		parameterDigest: actionParameterDigestSchema,
		originInstanceId: z.string().min(1).max(256),
		originGeneration: z.int().nonnegative().safe(),
		targetRuntimeBoxId: z.string().min(1).max(128),
		targetInstanceId: z.string().min(1).max(256),
		targetGeneration: z.int().nonnegative().safe(),
		state: runtimeBoxInvocationEvidenceStateSchema,
		result: runtimeBoxActionResultSchema.optional(),
		safeError: z.string().min(1).max(1_024).optional(),
		completedAt: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.state === "succeeded" && value.result === undefined) {
			context.addIssue({ code: "custom", message: "Succeeded evidence requires a result." });
		}
		if (value.state !== "succeeded" && value.result !== undefined) {
			context.addIssue({
				code: "custom",
				message: "Only succeeded evidence may include a result.",
			});
		}
	});

export const reconcileRuntimeBoxInvocationsInputSchema = z
	.object({
		items: z.array(runtimeBoxInvocationEvidenceSchema).max(64),
		acknowledgedInvocationIds: z.array(z.string().uuid()).max(64).default([]),
	})
	.strict();

export const reconcileRuntimeBoxInvocationsOutputSchema = z
	.object({
		ackedInvocationIds: z.array(z.string().uuid()).max(64),
		confirmedAcknowledgementIds: z.array(z.string().uuid()).max(64).default([]),
	})
	.strict();

export const acknowledgeRuntimeBoxInvocationsInputSchema = z
	.object({
		invocationIds: z.array(z.string().uuid()).min(1).max(64),
	})
	.strict();

export const acknowledgeRuntimeBoxInvocationsOutputSchema = z
	.object({
		ackedInvocationIds: z.array(z.string().uuid()).min(1).max(64),
	})
	.strict();

export function createExecutorToolParameterPayload(
	input: Omit<ExecutorToolInvokeInput, "authorization">,
	executionContext: ExecutorExecutionContext,
): string {
	const parsedContext = executorExecutionContextSchema.parse(executionContext);
	return JSON.stringify([
		"moshu-executor-tool-parameters-v2",
		input.schemaVersion,
		input.invocationId,
		input.runId,
		input.toolCallId,
		input.cwd,
		input.call,
		parsedContext.executionScope,
		parsedContext.executionScope === "project-root" ? parsedContext.projectPathRevision : undefined,
	]);
}

export function createMcpToolParameterPayload(
	input: Omit<RuntimeBoxMcpToolInvokeInput, "authorization">,
): string {
	return JSON.stringify([
		"moshu-mcp-tool-parameters-v1",
		input.schemaVersion,
		input.invocationId,
		input.runId,
		input.toolCallId,
		input.mcpServerId,
		input.mcpServerVersion,
		input.mcpServerContentHash,
		input.stableToolId,
		input.toolSchemaHash,
		input.arguments,
	]);
}

export type ExecutorToolName = z.infer<typeof executorToolNameSchema>;
export type ExecutorReadToolArguments = z.infer<typeof executorReadToolArgumentsSchema>;
export type ExecutorBashToolArguments = z.infer<typeof executorBashToolArgumentsSchema>;
export type ExecutorEditReplacement = z.infer<typeof executorEditReplacementSchema>;
export type ExecutorEditToolArguments = z.infer<typeof executorEditToolArgumentsSchema>;
export type ExecutorWriteToolArguments = z.infer<typeof executorWriteToolArgumentsSchema>;
export type ExecutorGrepToolArguments = z.infer<typeof executorGrepToolArgumentsSchema>;
export type ExecutorFindToolArguments = z.infer<typeof executorFindToolArgumentsSchema>;
export type ExecutorLsToolArguments = z.infer<typeof executorLsToolArgumentsSchema>;
export type ExecutorToolCall = z.infer<typeof executorToolCallSchema>;
export type ExecutorToolInvokeInput = z.infer<typeof runtimeBoxToolInvokeInputSchema>;
export type ExecutorExecutionContext = z.infer<typeof executorExecutionContextSchema>;
export type RuntimeBoxToolAuthorization = z.infer<typeof runtimeBoxToolAuthorizationSchema>;
export type ExecutorToolTextContent = z.infer<typeof executorToolTextContentSchema>;
export type ExecutorToolImageContent = z.infer<typeof executorToolImageContentSchema>;
export type ExecutorToolContent = z.infer<typeof executorToolContentSchema>;
export type ExecutorToolTruncation = z.infer<typeof executorToolTruncationSchema>;
export type ExecutorReadToolDetails = z.infer<typeof executorReadToolDetailsSchema>;
export type ExecutorBashToolDetails = z.infer<typeof executorBashToolDetailsSchema>;
export type ExecutorEditToolDetails = z.infer<typeof executorEditToolDetailsSchema>;
export type ExecutorGrepToolDetails = z.infer<typeof executorGrepToolDetailsSchema>;
export type ExecutorFindToolDetails = z.infer<typeof executorFindToolDetailsSchema>;
export type ExecutorLsToolDetails = z.infer<typeof executorLsToolDetailsSchema>;
export type ExecutorToolInvokeOutput = z.infer<typeof runtimeBoxToolInvokeOutputSchema>;
export type RuntimeBoxMcpToolInvokeInput = z.infer<typeof runtimeBoxMcpToolInvokeInputSchema>;
export type RuntimeBoxMcpToolInvokeOutput = z.infer<typeof runtimeBoxMcpToolInvokeOutputSchema>;
export type RuntimeBoxActionResult = z.infer<typeof runtimeBoxActionResultSchema>;
export type ExecutorToolProgressEvent = z.infer<typeof runtimeBoxToolProgressEventSchema>;
export type RuntimeBoxInvocationEvidence = z.infer<typeof runtimeBoxInvocationEvidenceSchema>;
export type ReconcileRuntimeBoxInvocationsInput = z.infer<
	typeof reconcileRuntimeBoxInvocationsInputSchema
>;
export type ReconcileRuntimeBoxInvocationsOutput = z.infer<
	typeof reconcileRuntimeBoxInvocationsOutputSchema
>;
export type AcknowledgeRuntimeBoxInvocationsInput = z.infer<
	typeof acknowledgeRuntimeBoxInvocationsInputSchema
>;
export type AcknowledgeRuntimeBoxInvocationsOutput = z.infer<
	typeof acknowledgeRuntimeBoxInvocationsOutputSchema
>;
