import { z } from "zod";

import { appErrorSchema } from "./app-error";
import { agentModeSchema } from "./mode";
import {
	providerIdSchema,
	providerSourceSchema,
	sessionModelSelectionSchema,
	thinkingLevelSchema,
} from "./provider";
import { runtimeBoxIdSchema } from "./runtime-box";
import {
	projectGitBranchSchema,
	projectPathRevisionSchema,
	projectPathSchema,
	projectRootAgentsIssueCodeSchema,
} from "./project";
import { isoDateTimeSchema, toolCallIdSchema, uuidV7Schema } from "./contract-primitives";

export {
	isoDateTimeSchema,
	maxToolCallIdBytes,
	toolCallIdSchema,
	uuidV7Pattern,
	uuidV7Schema,
} from "./contract-primitives";

export const contractSchemaVersion = 1 as const;

const providerNameSchema = z.string().trim().min(1).max(120);
const providerModelSchema = z.string().trim().min(1).max(200);
const sessionTitleSchema = z.string().trim().min(1).max(200);
const sessionSearchQuerySchema = z.string().trim().max(200);
const userMessageContentSchema = z.string().trim().min(1).max(20_000);
export const maxChatTextPartContentCharacters = 200_000;
export const maxChatDeltaCharacters = 8_000;
const textPartContentSchema = z.string().max(maxChatTextPartContentCharacters);
const deltaContentSchema = z.string().min(1).max(maxChatDeltaCharacters);
const cancellationReasonSchema = z.string().trim().min(1).max(500);
const positiveSequenceSchema = z.int().min(1);
const nonNegativeDurationSchema = z.int().min(0);

export const runProviderConfigInputSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		providerId: providerIdSchema,
		name: providerNameSchema,
		source: providerSourceSchema,
		api: z.string().trim().min(1).max(100),
		model: providerModelSchema,
		thinkingLevel: thinkingLevelSchema.optional(),
	})
	.strict();

export const providerStatusValues = ["ready", "missing_api_key", "error"] as const;
export const runProviderStatusSchema = z.enum(providerStatusValues);

const providerStateBaseSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		providerId: providerIdSchema,
		name: providerNameSchema,
		source: providerSourceSchema,
		api: z.string().trim().min(1).max(100),
		model: providerModelSchema,
		thinkingLevel: thinkingLevelSchema.optional(),
	})
	.strict();

export const readyProviderStateSchema = providerStateBaseSchema.extend({
	status: z.literal("ready"),
});

export const missingApiKeyProviderStateSchema = providerStateBaseSchema.extend({
	status: z.literal("missing_api_key"),
});

export const errorProviderStateSchema = providerStateBaseSchema.extend({
	status: z.literal("error"),
	lastError: appErrorSchema,
});

export const runProviderStateSchema = z.discriminatedUnion("status", [
	readyProviderStateSchema,
	missingApiKeyProviderStateSchema,
	errorProviderStateSchema,
]);

export const chatUserMessageSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		sessionId: uuidV7Schema,
		runId: uuidV7Schema,
		role: z.literal("user"),
		content: userMessageContentSchema,
		createdAt: isoDateTimeSchema,
	})
	.strict();

export const chatRunStatusValues = [
	"queued",
	"running",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
] as const;
export const chatRunStatusSchema = z.enum(chatRunStatusValues);

export const chatSessionSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		agentSessionId: uuidV7Schema,
		runtimeBoxId: runtimeBoxIdSchema,
		projectId: uuidV7Schema.optional(),
		title: sessionTitleSchema,
		defaultMode: agentModeSchema,
		model: sessionModelSelectionSchema.optional(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		lastMessageAt: isoDateTimeSchema.optional(),
		archivedAt: isoDateTimeSchema.optional(),
	})
	.strict();

export const projectRunContextSchema = z
	.object({
		projectId: uuidV7Schema,
		runtimeBoxId: runtimeBoxIdSchema,
		projectPath: projectPathSchema,
		projectPathRevision: projectPathRevisionSchema,
		gitRootPath: projectPathSchema.optional(),
		gitBranch: projectGitBranchSchema.optional(),
		rootAgentsHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();

export const chatRunSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		sessionId: uuidV7Schema,
		runtimeBoxId: runtimeBoxIdSchema,
		projectContext: projectRunContextSchema.optional(),
		mode: agentModeSchema,
		status: chatRunStatusSchema,
		provider: runProviderStateSchema,
		userMessageId: uuidV7Schema,
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		completedAt: isoDateTimeSchema.optional(),
		lastError: appErrorSchema.optional(),
	})
	.strict();

export const chatRunTextPartStatusValues = ["streaming", "completed", "interrupted"] as const;
export const chatRunTextPartStatusSchema = z.enum(chatRunTextPartStatusValues);

export const chatRunToolStatusValues = [
	"queued",
	"waiting_approval",
	"running",
	"completed",
	"failed",
	"denied",
	"cancelled",
	"outcome_unknown",
] as const;
export const chatRunToolStatusSchema = z.enum(chatRunToolStatusValues);

export const chatRunPartStatusValues = [
	...chatRunTextPartStatusValues,
	...chatRunToolStatusValues.filter((status) => status !== "completed"),
] as const;

export const builtinChatToolNameValues = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;
export const builtinChatToolNameSchema = z.enum(builtinChatToolNameValues);

export const chatToolIdentitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("builtin"),
			name: builtinChatToolNameSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("mcp"),
			name: z.string().trim().min(1).max(256),
			mcpServerId: z.string().trim().min(1).max(256),
			stableToolId: z.string().trim().min(1).max(256),
		})
		.strict(),
]);

export const toolPublicPayloadFormatValues = ["text", "json", "content"] as const;
export const toolPublicPayloadFormatSchema = z.enum(toolPublicPayloadFormatValues);

export const toolPublicPayloadSchema = z
	.object({
		format: toolPublicPayloadFormatSchema,
		value: z.json(),
		truncated: z.boolean(),
		originalBytes: z.int().min(0).optional(),
		redactionCount: z.int().min(0),
	})
	.strict();

export const chatRunToolPayloadBudgetBytes = 2 * 1024 * 1024;

const chatRunPartBaseShape = {
	schemaVersion: z.literal(contractSchemaVersion),
	id: uuidV7Schema,
	runId: uuidV7Schema,
	position: positiveSequenceSchema,
	assistantTurnId: uuidV7Schema,
	revision: positiveSequenceSchema,
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
};

export const chatRunTextPartSchema = z
	.object({
		...chatRunPartBaseShape,
		kind: z.literal("text"),
		status: chatRunTextPartStatusSchema,
		content: textPartContentSchema,
	})
	.strict();

export const chatRunToolPartSchema = z
	.object({
		...chatRunPartBaseShape,
		kind: z.literal("tool"),
		toolCallId: toolCallIdSchema,
		tool: chatToolIdentitySchema,
		status: chatRunToolStatusSchema,
		summary: z.string().trim().min(1).max(2_000),
		input: toolPublicPayloadSchema.optional(),
		progress: toolPublicPayloadSchema.optional(),
		output: toolPublicPayloadSchema.optional(),
		payloadsTruncated: z.boolean().optional(),
		error: appErrorSchema.optional(),
		approvalId: uuidV7Schema.optional(),
		startedAt: isoDateTimeSchema.optional(),
		completedAt: isoDateTimeSchema.optional(),
		durationMs: nonNegativeDurationSchema.optional(),
	})
	.strict();

export const chatRunPartSchema = z.discriminatedUnion("kind", [
	chatRunTextPartSchema,
	chatRunToolPartSchema,
]);

export const chatRunSnapshotSchema = chatRunSchema
	.extend({
		userMessage: chatUserMessageSchema,
		timeline: z.array(chatRunPartSchema),
		lastEventSeq: z.int().min(0),
	})
	.strict();

export const chatRunEventSourceKindValues = ["user", "assistant", "system"] as const;
export const chatRunEventSourceKindSchema = z.enum(chatRunEventSourceKindValues);
export const chatRunEventVisibilityValues = ["user", "debug"] as const;
export const chatRunEventVisibilitySchema = z.enum(chatRunEventVisibilityValues);

export const chatRunEventSourceSchema = z
	.object({
		kind: chatRunEventSourceKindSchema,
		id: uuidV7Schema.optional(),
	})
	.strict();

const chatRunEventBaseSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		runId: uuidV7Schema,
		sessionId: uuidV7Schema,
		seq: positiveSequenceSchema,
		source: chatRunEventSourceSchema,
		visibility: chatRunEventVisibilitySchema,
		createdAt: isoDateTimeSchema,
	})
	.strict();

export const chatRunStatusEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("run.status"),
	payload: z
		.object({
			status: chatRunStatusSchema,
			previousStatus: chatRunStatusSchema.optional(),
		})
		.strict(),
});

export const chatTimelinePartCreatedEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("timeline.part.created"),
	payload: z
		.object({
			part: chatRunPartSchema,
		})
		.strict(),
});

export const chatTimelineTextDeltaEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("timeline.text.delta"),
	payload: z
		.object({
			partId: uuidV7Schema,
			revision: positiveSequenceSchema,
			delta: deltaContentSchema,
		})
		.strict(),
});

export const chatTimelineTextCompletedEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("timeline.text.completed"),
	payload: z
		.object({
			part: chatRunTextPartSchema,
		})
		.strict(),
});

export const chatTimelineToolUpdatedEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("timeline.tool.updated"),
	payload: z
		.object({
			part: chatRunToolPartSchema,
		})
		.strict(),
});

export const chatTimelineToolProgressEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("timeline.tool.progress"),
	payload: z
		.object({
			partId: uuidV7Schema,
			revision: positiveSequenceSchema,
			progress: toolPublicPayloadSchema.optional(),
			payloadsTruncated: z.boolean().optional(),
		})
		.strict()
		.refine(
			(payload) => payload.progress !== undefined || payload.payloadsTruncated === true,
			"Tool progress must include a public payload or an explicit truncation marker.",
		),
});

export const chatRunErrorEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("run.error"),
	payload: z
		.object({
			error: appErrorSchema,
		})
		.strict(),
});

export const chatRunWarningEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("run.warning"),
	payload: z
		.object({
			code: z.literal("ROOT_AGENTS_SKIPPED"),
			reason: projectRootAgentsIssueCodeSchema,
		})
		.strict(),
});

export const chatRunEventSchema = z.discriminatedUnion("type", [
	chatRunStatusEventSchema,
	chatTimelinePartCreatedEventSchema,
	chatTimelineTextDeltaEventSchema,
	chatTimelineTextCompletedEventSchema,
	chatTimelineToolUpdatedEventSchema,
	chatTimelineToolProgressEventSchema,
	chatRunErrorEventSchema,
	chatRunWarningEventSchema,
]);

export const createChatSessionInputSchema = z
	.object({
		title: sessionTitleSchema,
		defaultMode: agentModeSchema.optional(),
		model: sessionModelSelectionSchema.optional(),
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		projectId: uuidV7Schema.optional(),
	})
	.strict();

export const createChatSessionOutputSchema = z
	.object({
		session: chatSessionSchema,
	})
	.strict();

export const listChatSessionsInputSchema = z
	.object({
		limit: z.int().min(1).max(100).optional(),
		query: sessionSearchQuerySchema.optional(),
		archived: z.boolean().optional(),
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		scope: z
			.discriminatedUnion("kind", [
				z
					.object({
						kind: z.literal("global"),
						runtimeBoxId: runtimeBoxIdSchema.optional(),
					})
					.strict(),
				z.object({ kind: z.literal("project"), projectId: uuidV7Schema }).strict(),
			])
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.runtimeBoxId !== undefined && value.scope !== undefined) {
			context.addIssue({
				code: "custom",
				message: "runtimeBoxId cannot be combined with an explicit Session scope.",
			});
		}
	});

export const listChatSessionsOutputSchema = z
	.object({
		items: z.array(chatSessionSchema),
	})
	.strict();

export const updateChatSessionInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		title: sessionTitleSchema,
	})
	.strict();

export const updateChatSessionOutputSchema = z
	.object({
		session: chatSessionSchema,
	})
	.strict();

export const setChatSessionModelInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		model: sessionModelSelectionSchema.nullable(),
	})
	.strict();

export const setChatSessionModelOutputSchema = updateChatSessionOutputSchema;

export const setChatSessionArchivedInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		archived: z.boolean(),
	})
	.strict();

export const setChatSessionArchivedOutputSchema = updateChatSessionOutputSchema;

export const deleteChatSessionInputSchema = z
	.object({
		sessionId: uuidV7Schema,
	})
	.strict();

export const deleteChatSessionOutputSchema = z
	.object({
		sessionId: uuidV7Schema,
	})
	.strict();

export const getChatSessionInputSchema = z
	.object({
		sessionId: uuidV7Schema,
	})
	.strict();

export const getChatSessionOutputSchema = z
	.object({
		session: chatSessionSchema,
		runs: z.array(chatRunSnapshotSchema),
	})
	.strict();

export const chatRunEventCursorSchema = z
	.object({
		runId: uuidV7Schema,
		lastSeq: z.int().min(0),
	})
	.strict();

export const getChatSessionSnapshotOutputSchema = getChatSessionOutputSchema;

export const sendChatMessageInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		content: userMessageContentSchema,
		mode: agentModeSchema,
		provider: runProviderConfigInputSchema,
	})
	.strict();

export const chatSendAcceptedOutputSchema = z
	.object({
		run: chatRunSnapshotSchema,
	})
	.strict();

export const cancelChatRunInputSchema = z
	.object({
		runId: uuidV7Schema,
		reason: cancellationReasonSchema.optional(),
	})
	.strict();

export const cancelChatRunOutputSchema = z
	.object({
		run: chatRunSchema,
	})
	.strict();

export type RunProviderConfigInput = z.infer<typeof runProviderConfigInputSchema>;
export type RunProviderStatus = z.infer<typeof runProviderStatusSchema>;
export type RunProviderState = z.infer<typeof runProviderStateSchema>;
export type ChatUserMessage = z.infer<typeof chatUserMessageSchema>;
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;
export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ProjectRunContext = z.infer<typeof projectRunContextSchema>;
export type ChatRun = z.infer<typeof chatRunSchema>;
export type ChatRunTextPartStatus = z.infer<typeof chatRunTextPartStatusSchema>;
export type ChatRunToolStatus = z.infer<typeof chatRunToolStatusSchema>;
export type ChatToolIdentity = z.infer<typeof chatToolIdentitySchema>;
export type ToolPublicPayload = z.infer<typeof toolPublicPayloadSchema>;
export type ChatRunTextPart = z.infer<typeof chatRunTextPartSchema>;
export type ChatRunToolPart = z.infer<typeof chatRunToolPartSchema>;
export type ChatRunPart = z.infer<typeof chatRunPartSchema>;
export type ChatRunSnapshot = z.infer<typeof chatRunSnapshotSchema>;
export type ChatRunEventSource = z.infer<typeof chatRunEventSourceSchema>;
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionInputSchema>;
export type CreateChatSessionOutput = z.infer<typeof createChatSessionOutputSchema>;
export type ListChatSessionsInput = z.infer<typeof listChatSessionsInputSchema>;
export type SessionListScope = NonNullable<ListChatSessionsInput["scope"]>;
export type ListChatSessionsOutput = z.infer<typeof listChatSessionsOutputSchema>;
export type UpdateChatSessionInput = z.infer<typeof updateChatSessionInputSchema>;
export type UpdateChatSessionOutput = z.infer<typeof updateChatSessionOutputSchema>;
export type SetChatSessionArchivedInput = z.infer<typeof setChatSessionArchivedInputSchema>;
export type SetChatSessionArchivedOutput = z.infer<typeof setChatSessionArchivedOutputSchema>;
export type SetChatSessionModelInput = z.infer<typeof setChatSessionModelInputSchema>;
export type SetChatSessionModelOutput = z.infer<typeof setChatSessionModelOutputSchema>;
export type DeleteChatSessionInput = z.infer<typeof deleteChatSessionInputSchema>;
export type DeleteChatSessionOutput = z.infer<typeof deleteChatSessionOutputSchema>;
export type GetChatSessionInput = z.infer<typeof getChatSessionInputSchema>;
export type GetChatSessionOutput = z.infer<typeof getChatSessionOutputSchema>;
export type ChatRunEventCursor = z.infer<typeof chatRunEventCursorSchema>;
export type GetChatSessionSnapshotOutput = z.infer<typeof getChatSessionSnapshotOutputSchema>;
export type SendChatMessageInput = z.infer<typeof sendChatMessageInputSchema>;
export type ChatSendAcceptedOutput = z.infer<typeof chatSendAcceptedOutputSchema>;
export type CancelChatRunInput = z.infer<typeof cancelChatRunInputSchema>;
export type CancelChatRunOutput = z.infer<typeof cancelChatRunOutputSchema>;
