import { z } from "zod";

import {
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatMessageSchema,
	chatRunEventCursorSchema,
	chatRunEventSchema,
	chatRunSchema,
	chatSendAcceptedOutputSchema,
	chatSessionSchema,
	createChatSessionInputSchema,
	createChatSessionOutputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	setChatSessionModelInputSchema,
	setChatSessionModelOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	uuidV7Schema,
} from "./chat";
import {
	createProviderInputSchema,
	deleteProviderInputSchema,
	deleteProviderOutputSchema,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	getDefaultModelOutputSchema,
	listAvailableModelsOutputSchema,
	listProvidersOutputSchema,
	providerMutationOutputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
	testProviderInputSchema,
	testProviderOutputSchema,
	updateProviderInputSchema,
} from "./provider";
import {
	logoutProviderInputSchema,
	logoutProviderOutputSchema,
	providerAuthAttemptInputSchema,
	providerAuthAttemptOutputSchema,
	respondProviderAuthInputSchema,
	startProviderAuthInputSchema,
} from "./provider-auth";
import { agentsRuntimeInfoSchema, emptyParamsSchema } from "./runtime";

export const productRpcMethods = {
	runtimeGet: "moshu.v1.runtime.get",
	providersList: "moshu.v1.providers.list",
	providersCreate: "moshu.v1.providers.create",
	providersUpdate: "moshu.v1.providers.update",
	providersDelete: "moshu.v1.providers.delete",
	providersTest: "moshu.v1.providers.test",
	providersFetchModels: "moshu.v1.providers.fetchModels",
	providersSetModelsEnabled: "moshu.v1.providers.setModelsEnabled",
	modelsListAvailable: "moshu.v1.models.listAvailable",
	defaultModelGet: "moshu.v1.settings.defaultModel.get",
	defaultModelSet: "moshu.v1.settings.defaultModel.set",
	providerAuthStart: "moshu.v2.providerAuth.start",
	providerAuthGet: "moshu.v2.providerAuth.get",
	providerAuthRespond: "moshu.v2.providerAuth.respond",
	providerAuthCancel: "moshu.v2.providerAuth.cancel",
	providerLogout: "moshu.v2.provider.logout",
	sessionCreate: "moshu.v1.session.create",
	sessionGet: "moshu.v1.session.get",
	sessionList: "moshu.v1.session.list",
	sessionUpdate: "moshu.v1.session.update",
	sessionArchive: "moshu.v1.session.archive",
	sessionSetModel: "moshu.v1.session.setModel",
	sessionDelete: "moshu.v1.session.delete",
	chatSend: "moshu.v1.chat.send",
	chatCancel: "moshu.v1.chat.cancel",
	chatReplay: "moshu.v1.chat.replay",
	executorRegister: "moshu.v1.executor.register",
} as const;

export const productRpcEvents = {
	chatEvent: "moshu.v1.chat.event",
} as const;

export const productRpcMaxFrameBytes = 4 * 1024 * 1024;
export const productRpcMaxBufferedOutboundBytes = 8 * 1024 * 1024;
export const maxReplayRunCursors = 1;
export const maxReplayEventsPerPage = 256;
export const maxReplayEventBytesPerPage = 2 * 1024 * 1024;
export const maxSessionRunsPerPage = 2;
export const retiredSessionTombstoneTtlMs = 30 * 24 * 60 * 60 * 1_000;
export const maxRetainedSessionRetirements = 256;
export const productRpcInternalHandlerErrorCode = "INTERNAL_HANDLER_ERROR";

export const sendAskChatMessageInputSchema = z
	.object({
		requestId: z.string().uuid(),
		sessionId: uuidV7Schema,
		content: z.string().trim().min(1).max(20_000),
	})
	.strict();

export const createProcessChatSessionInputSchema = createChatSessionInputSchema
	.required({ title: true, defaultMode: true })
	.extend({
		schemaVersion: z.literal(1),
		createKey: z.string().uuid(),
	})
	.strict();

export const executorRegisterInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		status: z.literal("ready"),
	})
	.strict();

export const executorRegisterOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		accepted: z.literal(true),
	})
	.strict();

export const chatEventDeliverySchema = z
	.object({
		clientRequestId: z.string().uuid(),
		event: chatRunEventSchema,
	})
	.strict();

export const replayRunCursorSchema = chatRunEventCursorSchema.extend({
	sessionId: uuidV7Schema,
	issuedAtMs: z.int().nonnegative().safe(),
});

export const replayChatEventsInputSchema = z
	.object({
		cursors: z.array(replayRunCursorSchema).max(maxReplayRunCursors),
	})
	.strict();

export const replayCursorSupportSchema = z
	.object({
		schemaVersion: z.literal(1),
		serverTimeMs: z.int().nonnegative().safe(),
		oldestSupportedCursorIssuedAtMs: z.int().safe(),
		tombstoneTtlMs: z.literal(retiredSessionTombstoneTtlMs),
	})
	.strict();

export const replayChatEventsOutputSchema = z
	.object({
		events: z.array(chatRunEventSchema).max(maxReplayEventsPerPage),
		retiredSessionIds: z.array(uuidV7Schema).max(maxReplayRunCursors).default([]),
		resnapshotSessionIds: z.array(uuidV7Schema).max(maxReplayRunCursors).default([]),
		cursorSupport: replayCursorSupportSchema,
		hasMore: z.boolean().default(false),
	})
	.strict();

export const getChatSessionPageInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		cursor: z.string().min(1).max(512).optional(),
		limit: z.int().min(1).max(maxSessionRunsPerPage),
	})
	.strict();

export const getChatSessionPageOutputSchema = z
	.object({
		session: chatSessionSchema,
		messages: z.array(chatMessageSchema).max(maxSessionRunsPerPage * 2),
		runs: z.array(chatRunSchema).max(maxSessionRunsPerPage),
		eventCursors: z.array(chatRunEventCursorSchema).max(maxSessionRunsPerPage),
		nextCursor: z.string().min(1).max(512).optional(),
	})
	.strict();

export const productRpcRequestSchemas = {
	[productRpcMethods.runtimeGet]: { input: emptyParamsSchema, output: agentsRuntimeInfoSchema },
	[productRpcMethods.providersList]: {
		input: emptyParamsSchema,
		output: listProvidersOutputSchema,
	},
	[productRpcMethods.providersCreate]: {
		input: createProviderInputSchema,
		output: providerMutationOutputSchema,
	},
	[productRpcMethods.providersUpdate]: {
		input: updateProviderInputSchema,
		output: providerMutationOutputSchema,
	},
	[productRpcMethods.providersDelete]: {
		input: deleteProviderInputSchema,
		output: deleteProviderOutputSchema,
	},
	[productRpcMethods.providersTest]: {
		input: testProviderInputSchema,
		output: testProviderOutputSchema,
	},
	[productRpcMethods.providersFetchModels]: {
		input: fetchProviderModelsInputSchema,
		output: fetchProviderModelsOutputSchema,
	},
	[productRpcMethods.providersSetModelsEnabled]: {
		input: setProviderModelsEnabledInputSchema,
		output: setProviderModelsEnabledOutputSchema,
	},
	[productRpcMethods.modelsListAvailable]: {
		input: emptyParamsSchema,
		output: listAvailableModelsOutputSchema,
	},
	[productRpcMethods.defaultModelGet]: {
		input: emptyParamsSchema,
		output: getDefaultModelOutputSchema,
	},
	[productRpcMethods.defaultModelSet]: {
		input: setDefaultModelInputSchema,
		output: setDefaultModelOutputSchema,
	},
	[productRpcMethods.providerAuthStart]: {
		input: startProviderAuthInputSchema,
		output: providerAuthAttemptOutputSchema,
	},
	[productRpcMethods.providerAuthGet]: {
		input: providerAuthAttemptInputSchema,
		output: providerAuthAttemptOutputSchema,
	},
	[productRpcMethods.providerAuthRespond]: {
		input: respondProviderAuthInputSchema,
		output: providerAuthAttemptOutputSchema,
	},
	[productRpcMethods.providerAuthCancel]: {
		input: providerAuthAttemptInputSchema,
		output: providerAuthAttemptOutputSchema,
	},
	[productRpcMethods.providerLogout]: {
		input: logoutProviderInputSchema,
		output: logoutProviderOutputSchema,
	},
	[productRpcMethods.sessionCreate]: {
		input: createProcessChatSessionInputSchema,
		output: createChatSessionOutputSchema,
	},
	[productRpcMethods.sessionGet]: {
		input: getChatSessionPageInputSchema,
		output: getChatSessionPageOutputSchema,
	},
	[productRpcMethods.sessionList]: {
		input: listChatSessionsInputSchema,
		output: listChatSessionsOutputSchema,
	},
	[productRpcMethods.sessionUpdate]: {
		input: updateChatSessionInputSchema,
		output: updateChatSessionOutputSchema,
	},
	[productRpcMethods.sessionArchive]: {
		input: setChatSessionArchivedInputSchema,
		output: setChatSessionArchivedOutputSchema,
	},
	[productRpcMethods.sessionSetModel]: {
		input: setChatSessionModelInputSchema,
		output: setChatSessionModelOutputSchema,
	},
	[productRpcMethods.sessionDelete]: {
		input: deleteChatSessionInputSchema,
		output: deleteChatSessionOutputSchema,
	},
	[productRpcMethods.chatSend]: {
		input: sendAskChatMessageInputSchema,
		output: chatSendAcceptedOutputSchema,
	},
	[productRpcMethods.chatCancel]: {
		input: cancelChatRunInputSchema,
		output: cancelChatRunOutputSchema,
	},
	[productRpcMethods.chatReplay]: {
		input: replayChatEventsInputSchema,
		output: replayChatEventsOutputSchema,
	},
	[productRpcMethods.executorRegister]: {
		input: executorRegisterInputSchema,
		output: executorRegisterOutputSchema,
	},
} as const;

export const productRpcEventSchemas = {
	[productRpcEvents.chatEvent]: chatEventDeliverySchema,
} as const;

export const clientProductRequestMethods = [
	productRpcMethods.runtimeGet,
	productRpcMethods.providersList,
	productRpcMethods.providersCreate,
	productRpcMethods.providersUpdate,
	productRpcMethods.providersDelete,
	productRpcMethods.providersTest,
	productRpcMethods.providersFetchModels,
	productRpcMethods.providersSetModelsEnabled,
	productRpcMethods.modelsListAvailable,
	productRpcMethods.defaultModelGet,
	productRpcMethods.defaultModelSet,
	productRpcMethods.providerAuthStart,
	productRpcMethods.providerAuthGet,
	productRpcMethods.providerAuthRespond,
	productRpcMethods.providerAuthCancel,
	productRpcMethods.providerLogout,
	productRpcMethods.sessionCreate,
	productRpcMethods.sessionGet,
	productRpcMethods.sessionList,
	productRpcMethods.sessionUpdate,
	productRpcMethods.sessionArchive,
	productRpcMethods.sessionSetModel,
	productRpcMethods.sessionDelete,
	productRpcMethods.chatSend,
	productRpcMethods.chatCancel,
	productRpcMethods.chatReplay,
] as const;

export const executorProductRequestMethods = [productRpcMethods.executorRegister] as const;
export const agentsProductEventMethods = [productRpcEvents.chatEvent] as const;

export type SendAskChatMessageInput = z.infer<typeof sendAskChatMessageInputSchema>;
export type CreateProcessChatSessionInput = z.infer<typeof createProcessChatSessionInputSchema>;
export type ExecutorRegisterInput = z.infer<typeof executorRegisterInputSchema>;
export type ExecutorRegisterOutput = z.infer<typeof executorRegisterOutputSchema>;
export type ChatEventDelivery = z.infer<typeof chatEventDeliverySchema>;
export type ReplayChatEventsInput = z.infer<typeof replayChatEventsInputSchema>;
export type ReplayChatEventsOutput = z.infer<typeof replayChatEventsOutputSchema>;
export type ReplayCursorSupport = z.infer<typeof replayCursorSupportSchema>;
export type GetChatSessionPageInput = z.infer<typeof getChatSessionPageInputSchema>;
export type GetChatSessionPageOutput = z.infer<typeof getChatSessionPageOutputSchema>;
