import { z } from "zod";

import { appErrorSchema } from "./app-error";
import { agentModeSchema } from "./mode";
import {
	providerIdSchema,
	providerSourceSchema,
	sessionModelSelectionSchema,
	thinkingLevelSchema,
} from "./provider";

export const contractSchemaVersion = 1 as const;

export const uuidV7Pattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV7Schema = z.string().regex(uuidV7Pattern, "Expected UUIDv7.");
export const isoDateTimeSchema = z.string().datetime({ offset: true });

const providerNameSchema = z.string().trim().min(1).max(120);
const providerModelSchema = z.string().trim().min(1).max(200);
const sessionTitleSchema = z.string().trim().min(1).max(200);
const sessionSearchQuerySchema = z.string().trim().max(200);
const userMessageContentSchema = z.string().trim().min(1).max(20_000);
export const maxAssistantMessageContentCharacters = 200_000;
export const maxChatDeltaCharacters = 8_000;
const assistantMessageContentSchema = z.string().max(maxAssistantMessageContentCharacters);
const deltaContentSchema = z.string().min(1).max(maxChatDeltaCharacters);
const cancellationReasonSchema = z.string().trim().min(1).max(500);
const positiveSequenceSchema = z.int().min(1);

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

export const chatMessageRoleValues = ["user", "assistant"] as const;
export const chatMessageRoleSchema = z.enum(chatMessageRoleValues);

export const chatMessageStatusValues = ["streaming", "complete", "failed", "cancelled"] as const;
export const chatMessageStatusSchema = z.enum(chatMessageStatusValues);

const chatMessageBaseSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		sessionId: uuidV7Schema,
		runId: uuidV7Schema.optional(),
		sequence: positiveSequenceSchema,
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
	})
	.strict();

export const userChatMessageSchema = chatMessageBaseSchema.extend({
	role: z.literal("user"),
	status: z.literal("complete"),
	content: userMessageContentSchema,
});

export const assistantStreamingChatMessageSchema = chatMessageBaseSchema.extend({
	role: z.literal("assistant"),
	status: z.literal("streaming"),
	content: assistantMessageContentSchema,
});

export const assistantCompleteChatMessageSchema = chatMessageBaseSchema.extend({
	role: z.literal("assistant"),
	status: z.literal("complete"),
	content: assistantMessageContentSchema.min(1),
});

export const assistantFailedChatMessageSchema = chatMessageBaseSchema.extend({
	role: z.literal("assistant"),
	status: z.literal("failed"),
	content: assistantMessageContentSchema,
	error: appErrorSchema,
});

export const assistantCancelledChatMessageSchema = chatMessageBaseSchema.extend({
	role: z.literal("assistant"),
	status: z.literal("cancelled"),
	content: assistantMessageContentSchema,
});

export const assistantChatMessageSchema = z.union([
	assistantStreamingChatMessageSchema,
	assistantCompleteChatMessageSchema,
	assistantFailedChatMessageSchema,
	assistantCancelledChatMessageSchema,
]);

export const chatMessageSchema = z.union([userChatMessageSchema, assistantChatMessageSchema]);

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
		title: sessionTitleSchema,
		defaultMode: agentModeSchema,
		model: sessionModelSelectionSchema.optional(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		lastMessageAt: isoDateTimeSchema.optional(),
		archivedAt: isoDateTimeSchema.optional(),
	})
	.strict();

export const chatRunSchema = z
	.object({
		schemaVersion: z.literal(contractSchemaVersion),
		id: uuidV7Schema,
		sessionId: uuidV7Schema,
		mode: agentModeSchema,
		status: chatRunStatusSchema,
		provider: runProviderStateSchema,
		userMessageId: uuidV7Schema,
		assistantMessageId: uuidV7Schema.optional(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		completedAt: isoDateTimeSchema.optional(),
		lastError: appErrorSchema.optional(),
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

export const chatMessageStartedEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("message.started"),
	payload: z
		.object({
			messageId: uuidV7Schema,
			role: z.literal("assistant"),
			status: z.literal("streaming"),
		})
		.strict(),
});

export const chatMessageDeltaEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("message.delta"),
	payload: z
		.object({
			messageId: uuidV7Schema,
			delta: deltaContentSchema,
		})
		.strict(),
});

const chatMessageCompletedPayloadCompleteSchema = z
	.object({
		messageId: uuidV7Schema,
		status: z.literal("complete"),
		content: assistantMessageContentSchema.min(1),
	})
	.strict();

const chatMessageCompletedPayloadFailedSchema = z
	.object({
		messageId: uuidV7Schema,
		status: z.literal("failed"),
		content: assistantMessageContentSchema,
		error: appErrorSchema,
	})
	.strict();

const chatMessageCompletedPayloadCancelledSchema = z
	.object({
		messageId: uuidV7Schema,
		status: z.literal("cancelled"),
		content: assistantMessageContentSchema,
	})
	.strict();

export const chatMessageCompletedEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("message.completed"),
	payload: z.discriminatedUnion("status", [
		chatMessageCompletedPayloadCompleteSchema,
		chatMessageCompletedPayloadFailedSchema,
		chatMessageCompletedPayloadCancelledSchema,
	]),
});

export const chatRunErrorEventSchema = chatRunEventBaseSchema.extend({
	type: z.literal("run.error"),
	payload: z
		.object({
			error: appErrorSchema,
		})
		.strict(),
});

export const chatRunEventSchema = z.discriminatedUnion("type", [
	chatRunStatusEventSchema,
	chatMessageStartedEventSchema,
	chatMessageDeltaEventSchema,
	chatMessageCompletedEventSchema,
	chatRunErrorEventSchema,
]);

export const createChatSessionInputSchema = z
	.object({
		title: sessionTitleSchema,
		defaultMode: agentModeSchema.optional(),
		model: sessionModelSelectionSchema.optional(),
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
	})
	.strict();

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
		messages: z.array(chatMessageSchema),
		runs: z.array(chatRunSchema),
	})
	.strict();

export const chatRunEventCursorSchema = z
	.object({
		runId: uuidV7Schema,
		lastSeq: z.int().min(0),
	})
	.strict();

export const getChatSessionSnapshotOutputSchema = getChatSessionOutputSchema.extend({
	eventCursors: z.array(chatRunEventCursorSchema),
});

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
		run: chatRunSchema,
		userMessage: userChatMessageSchema,
		assistantMessage: assistantChatMessageSchema,
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
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;
export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatRun = z.infer<typeof chatRunSchema>;
export type ChatRunEventSource = z.infer<typeof chatRunEventSourceSchema>;
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionInputSchema>;
export type CreateChatSessionOutput = z.infer<typeof createChatSessionOutputSchema>;
export type ListChatSessionsInput = z.infer<typeof listChatSessionsInputSchema>;
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
