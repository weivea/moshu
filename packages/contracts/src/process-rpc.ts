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
	acknowledgeRuntimeBoxInvocationsInputSchema,
	acknowledgeRuntimeBoxInvocationsOutputSchema,
	reconcileRuntimeBoxInvocationsInputSchema,
	reconcileRuntimeBoxInvocationsOutputSchema,
	runtimeBoxMcpToolInvokeInputSchema,
	runtimeBoxMcpToolInvokeOutputSchema,
	runtimeBoxToolInvokeInputSchema,
	runtimeBoxToolInvokeOutputSchema,
	runtimeBoxToolProgressEventSchema,
} from "./executor-tools";
import {
	checkProjectPathInputSchema,
	checkProjectPathOutputSchema,
	confirmCreateProjectInputSchema,
	confirmCreateProjectOutputSchema,
	getProjectDeleteConfirmationInputSchema,
	getProjectDeleteConfirmationOutputSchema,
	getProjectInputSchema,
	getProjectOutputSchema,
	getProjectSidebarInputSchema,
	getProjectSidebarOutputSchema,
	listProjectsInputSchema,
	listProjectsOutputSchema,
	previewProjectPathInputSchema,
	previewProjectPathOutputSchema,
	previewProjectRelinkInputSchema,
	previewProjectRelinkOutputSchema,
	readRuntimeBoxProjectRootAgentsInputSchema,
	readRuntimeBoxProjectRootAgentsOutputSchema,
	relinkProjectInputSchema,
	relinkProjectOutputSchema,
	requestProjectDeletionInputSchema,
	requestProjectDeletionOutputSchema,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	updateProjectInputSchema,
	updateProjectOutputSchema,
	validateRuntimeBoxProjectPathInputSchema,
	validateRuntimeBoxProjectPathOutputSchema,
} from "./project";
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
import {
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	createRuntimeBoxPairingOutputSchema,
	currentRuntimeBoxProtocolVersion,
	listRuntimeBoxesOutputSchema,
	listRuntimeBoxPairingClaimsOutputSchema,
	rejectRuntimeBoxPairingInputSchema,
	rejectRuntimeBoxPairingOutputSchema,
	remoteAccessAuthAttemptInputSchema,
	remoteAccessAuthAttemptSchema,
	remoteAccessMutationOutputSchema,
	remoteAccessStatusOutputSchema,
	revokeRuntimeBoxDeviceInputSchema,
	revokeRuntimeBoxDeviceOutputSchema,
	runtimeBoxDescriptorSchema,
	runtimeBoxIdSchema,
	runtimeBoxTransportSecuritySchema,
	runtimeDiagnosticsOutputSchema,
	switchRuntimeBoxInputSchema,
	switchRuntimeBoxOutputSchema,
} from "./runtime-box";
import {
	deleteMcpServerInputSchema,
	deleteRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	deleteSkillInputSchema,
	getAgentGlobalProfileInputSchema,
	getAgentGlobalProfileOutputSchema,
	getRuntimeBoxInventoryChangesInputSchema,
	getRuntimeBoxSkillContentInputSchema,
	getRuntimeBoxSkillContentOutputSchema,
	getRuntimeProfileInputSchema,
	getRuntimeProfileOutputSchema,
	installRuntimeBoxSkillInputSchema,
	listMcpServersInputSchema,
	listMcpServersOutputSchema,
	listRuntimeBoxInventoryInputSchema,
	listRuntimeBoxInventoryOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	listRuntimeBoxMcpServersInputSchema,
	listRuntimeBoxMcpServersOutputSchema,
	listRuntimeBoxSkillsInputSchema,
	listRuntimeBoxSkillsOutputSchema,
	listSkillsInputSchema,
	listSkillsOutputSchema,
	mcpServerMutationResultSchema,
	runtimeBoxInventoryChangedHintSchema,
	runtimeBoxInventoryChangesPageSchema,
	runtimeBoxInventorySnapshotSchema,
	runtimeBoxResourceMutationResultSchema,
	setMcpServerEnabledInputSchema,
	setRuntimeBoxMcpServerEnabledInputSchema,
	setRuntimeBoxSkillEnabledInputSchema,
	setSkillEnabledInputSchema,
	skillMutationResultSchema,
	updateAgentGlobalProfileInputSchema,
	updateAgentGlobalProfileOutputSchema,
	updateRuntimeProfileInputSchema,
	updateRuntimeProfileOutputSchema,
	upsertMcpServerInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	upsertSkillInputSchema,
	validateRuntimeBoxResourcesInputSchema,
	validateRuntimeBoxResourcesOutputSchema,
} from "./runtime-resources";

export const productRpcMethods = {
	runtimeGet: "moshu.v1.runtime.get",
	runtimeBoxesList: "moshu.v1.runtimeBoxes.list",
	runtimeBoxesSwitch: "moshu.v1.runtimeBoxes.switch",
	runtimeBoxesPairingCreate: "moshu.v1.runtimeBoxes.pairing.create",
	runtimeBoxesPairingListClaims: "moshu.v1.runtimeBoxes.pairing.listClaims",
	runtimeBoxesPairingApprove: "moshu.v1.runtimeBoxes.pairing.approve",
	runtimeBoxesPairingReject: "moshu.v1.runtimeBoxes.pairing.reject",
	runtimeBoxesDeviceRevoke: "moshu.v1.runtimeBoxes.device.revoke",
	remoteAccessStatus: "moshu.v1.remoteAccess.status",
	remoteAccessAuthStart: "moshu.v1.remoteAccess.auth.start",
	remoteAccessAuthGet: "moshu.v1.remoteAccess.auth.get",
	remoteAccessEnable: "moshu.v1.remoteAccess.enable",
	remoteAccessDisable: "moshu.v1.remoteAccess.disable",
	remoteAccessRecreate: "moshu.v1.remoteAccess.recreate",
	runtimeDiagnosticsGet: "moshu.v1.runtimeDiagnostics.get",
	projectsPreviewPath: "moshu.v1.projects.previewPath",
	projectsCreate: "moshu.v1.projects.create",
	projectsList: "moshu.v1.projects.list",
	projectsGet: "moshu.v1.projects.get",
	projectsCheckPath: "moshu.v1.projects.checkPath",
	projectsUpdateName: "moshu.v1.projects.updateName",
	projectsUpdate: "moshu.v1.projects.update",
	projectsPreviewRelink: "moshu.v1.projects.previewRelink",
	projectsRelink: "moshu.v1.projects.relink",
	projectsSetArchived: "moshu.v1.projects.setArchived",
	projectsArchive: "moshu.v1.projects.archive",
	projectsGetDeleteConfirmation: "moshu.v1.projects.getDeleteConfirmation",
	projectsDelete: "moshu.v1.projects.delete",
	projectsGetSidebar: "moshu.v1.projects.getSidebar",
	runtimeInventoryList: "moshu.v1.runtimeInventory.list",
	mcpServersList: "moshu.v1.mcpServers.list",
	mcpServersUpsert: "moshu.v1.mcpServers.upsert",
	mcpServersSetEnabled: "moshu.v1.mcpServers.setEnabled",
	mcpServersDelete: "moshu.v1.mcpServers.delete",
	mcpList: "moshu.v2.mcp.list",
	mcpUpsert: "moshu.v2.mcp.upsert",
	mcpSetEnabled: "moshu.v2.mcp.setEnabled",
	mcpDelete: "moshu.v2.mcp.delete",
	agentGlobalProfileGet: "moshu.v2.agentGlobalProfile.get",
	agentGlobalProfileUpdate: "moshu.v2.agentGlobalProfile.update",
	skillsList: "moshu.v1.skills.list",
	skillsInstall: "moshu.v1.skills.install",
	skillsDelete: "moshu.v1.skills.delete",
	skillList: "moshu.v2.skills.list",
	skillUpsert: "moshu.v2.skills.upsert",
	skillSetEnabled: "moshu.v2.skills.setEnabled",
	skillDelete: "moshu.v2.skills.delete",
	runtimeProfilesGet: "moshu.v1.runtimeProfiles.get",
	runtimeProfilesUpdate: "moshu.v1.runtimeProfiles.update",
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
	chatRetiredSessionsList: "moshu.v1.chat.retiredSessions.list",
	runtimeBoxRegister: "moshu.v1.runtimeBox.register",
	runtimeBoxReady: "moshu.v1.runtimeBox.ready",
	runtimeBoxToolInvoke: "moshu.v1.runtimeBox.tool.invoke",
	runtimeBoxMcpToolInvoke: "moshu.v1.runtimeBox.mcpTool.invoke",
	runtimeBoxProjectValidatePath: "moshu.v1.runtimeBox.projects.validatePath",
	runtimeBoxProjectReadRootAgents: "moshu.v1.runtimeBox.projects.readRootAgents",
	runtimeBoxInvocationsReconcile: "moshu.v1.runtimeBox.invocations.reconcile",
	runtimeBoxInvocationsAck: "moshu.v1.runtimeBox.invocations.ack",
	runtimeBoxInventoryGetSnapshot: "moshu.v1.runtimeBox.inventory.getSnapshot",
	runtimeBoxInventoryGetChanges: "moshu.v1.runtimeBox.inventory.getChanges",
	runtimeBoxMcpServersList: "moshu.v1.runtimeBox.mcpServers.list",
	runtimeBoxMcpServersUpsert: "moshu.v1.runtimeBox.mcpServers.upsert",
	runtimeBoxMcpServersSetEnabled: "moshu.v1.runtimeBox.mcpServers.setEnabled",
	runtimeBoxMcpServersDelete: "moshu.v1.runtimeBox.mcpServers.delete",
	runtimeBoxSkillsList: "moshu.v1.runtimeBox.skills.list",
	runtimeBoxSkillsInstall: "moshu.v1.runtimeBox.skills.install",
	runtimeBoxSkillsSetEnabled: "moshu.v2.runtimeBox.skills.setEnabled",
	runtimeBoxSkillsDelete: "moshu.v1.runtimeBox.skills.delete",
	runtimeBoxResourcesValidate: "moshu.v1.runtimeBox.resources.validate",
	runtimeBoxSkillGetContent: "moshu.v1.runtimeBox.skills.getContent",
} as const;

export const remoteAccessMutationRpcTimeoutMs = 2 * 60_000;
export const remoteAccessMutationMethods = [
	productRpcMethods.remoteAccessEnable,
	productRpcMethods.remoteAccessDisable,
	productRpcMethods.remoteAccessRecreate,
] as const;

export const productRpcEvents = {
	chatEvent: "moshu.v1.chat.event",
	chatSessionsRetired: "moshu.v1.chat.sessions.retired",
	runtimeBoxesChanged: "moshu.v1.runtimeBoxes.changed",
	runtimeBoxToolProgress: "moshu.v1.runtimeBox.tool.progress",
	runtimeBoxInventoryChanged: "moshu.v1.runtimeBox.inventory.changed",
} as const;

export const productRpcMaxFrameBytes = 4 * 1024 * 1024;
export const productRpcMaxBufferedOutboundBytes = 8 * 1024 * 1024;
export const maxReplayRunCursors = 1;
export const maxReplayEventsPerPage = 256;
export const maxReplayEventBytesPerPage = 2 * 1024 * 1024;
export const maxSessionRunsPerPage = 2;
export const maxRetiredSessionsPerEvent = 100;
export const maxRetiredSessionsPerRecoveryPage = 100;
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

export const runtimeBoxRegisterInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		status: z.literal("ready"),
		protocolVersion: z.literal(currentRuntimeBoxProtocolVersion),
		transportSecurity: runtimeBoxTransportSecuritySchema,
		runtimeBox: runtimeBoxDescriptorSchema,
	})
	.strict();

export const runtimeBoxRegisterOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		accepted: z.literal(true),
		runtimeBoxId: runtimeBoxIdSchema,
		negotiatedProtocolVersion: z
			.literal(currentRuntimeBoxProtocolVersion)
			.default(currentRuntimeBoxProtocolVersion),
		transportSecurity: runtimeBoxTransportSecuritySchema.default("relay-tls"),
	})
	.strict();

export const chatEventDeliverySchema = z
	.object({
		clientRequestId: z.string().uuid(),
		event: chatRunEventSchema,
	})
	.strict();

export const chatSessionsRetiredEventSchema = z
	.object({
		schemaVersion: z.literal(1),
		sessionIds: z
			.array(uuidV7Schema)
			.min(1)
			.max(maxRetiredSessionsPerEvent)
			.refine((sessionIds) => new Set(sessionIds).size === sessionIds.length, {
				message: "Retired Session IDs must be unique.",
			}),
	})
	.strict();

export const listRetiredChatSessionsInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		cursor: uuidV7Schema.optional(),
		limit: z.int().min(1).max(maxRetiredSessionsPerRecoveryPage),
	})
	.strict();

export const listRetiredChatSessionsOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		sessionIds: z.array(uuidV7Schema).max(maxRetiredSessionsPerRecoveryPage),
		nextCursor: uuidV7Schema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		for (let index = 1; index < value.sessionIds.length; index += 1) {
			if ((value.sessionIds[index - 1] ?? "") >= (value.sessionIds[index] ?? "")) {
				context.addIssue({
					code: "custom",
					path: ["sessionIds", index],
					message: "Retired Session IDs must be unique and strictly ordered.",
				});
				break;
			}
		}
		if (value.nextCursor !== undefined && value.nextCursor !== value.sessionIds.at(-1)) {
			context.addIssue({
				code: "custom",
				path: ["nextCursor"],
				message: "The retirement cursor must match the final Session ID.",
			});
		}
	});

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
	[productRpcMethods.runtimeBoxesList]: {
		input: emptyParamsSchema,
		output: listRuntimeBoxesOutputSchema,
	},
	[productRpcMethods.runtimeBoxesSwitch]: {
		input: switchRuntimeBoxInputSchema,
		output: switchRuntimeBoxOutputSchema,
	},
	[productRpcMethods.runtimeBoxesPairingCreate]: {
		input: emptyParamsSchema,
		output: createRuntimeBoxPairingOutputSchema,
	},
	[productRpcMethods.runtimeBoxesPairingListClaims]: {
		input: emptyParamsSchema,
		output: listRuntimeBoxPairingClaimsOutputSchema,
	},
	[productRpcMethods.runtimeBoxesPairingApprove]: {
		input: approveRuntimeBoxPairingInputSchema,
		output: approveRuntimeBoxPairingOutputSchema,
	},
	[productRpcMethods.runtimeBoxesPairingReject]: {
		input: rejectRuntimeBoxPairingInputSchema,
		output: rejectRuntimeBoxPairingOutputSchema,
	},
	[productRpcMethods.runtimeBoxesDeviceRevoke]: {
		input: revokeRuntimeBoxDeviceInputSchema,
		output: revokeRuntimeBoxDeviceOutputSchema,
	},
	[productRpcMethods.remoteAccessStatus]: {
		input: emptyParamsSchema,
		output: remoteAccessStatusOutputSchema,
	},
	[productRpcMethods.remoteAccessAuthStart]: {
		input: emptyParamsSchema,
		output: remoteAccessAuthAttemptSchema,
	},
	[productRpcMethods.remoteAccessAuthGet]: {
		input: remoteAccessAuthAttemptInputSchema,
		output: remoteAccessAuthAttemptSchema,
	},
	[productRpcMethods.remoteAccessEnable]: {
		input: emptyParamsSchema,
		output: remoteAccessMutationOutputSchema,
	},
	[productRpcMethods.remoteAccessDisable]: {
		input: emptyParamsSchema,
		output: remoteAccessMutationOutputSchema,
	},
	[productRpcMethods.remoteAccessRecreate]: {
		input: emptyParamsSchema,
		output: remoteAccessMutationOutputSchema,
	},
	[productRpcMethods.runtimeDiagnosticsGet]: {
		input: emptyParamsSchema,
		output: runtimeDiagnosticsOutputSchema,
	},
	[productRpcMethods.projectsPreviewPath]: {
		input: previewProjectPathInputSchema,
		output: previewProjectPathOutputSchema,
	},
	[productRpcMethods.projectsCreate]: {
		input: confirmCreateProjectInputSchema,
		output: confirmCreateProjectOutputSchema,
	},
	[productRpcMethods.projectsList]: {
		input: listProjectsInputSchema,
		output: listProjectsOutputSchema,
	},
	[productRpcMethods.projectsGet]: {
		input: getProjectInputSchema,
		output: getProjectOutputSchema,
	},
	[productRpcMethods.projectsCheckPath]: {
		input: checkProjectPathInputSchema,
		output: checkProjectPathOutputSchema,
	},
	[productRpcMethods.projectsUpdateName]: {
		input: updateProjectInputSchema,
		output: updateProjectOutputSchema,
	},
	[productRpcMethods.projectsUpdate]: {
		input: updateProjectInputSchema,
		output: updateProjectOutputSchema,
	},
	[productRpcMethods.projectsPreviewRelink]: {
		input: previewProjectRelinkInputSchema,
		output: previewProjectRelinkOutputSchema,
	},
	[productRpcMethods.projectsRelink]: {
		input: relinkProjectInputSchema,
		output: relinkProjectOutputSchema,
	},
	[productRpcMethods.projectsSetArchived]: {
		input: setProjectArchivedInputSchema,
		output: setProjectArchivedOutputSchema,
	},
	[productRpcMethods.projectsArchive]: {
		input: setProjectArchivedInputSchema,
		output: setProjectArchivedOutputSchema,
	},
	[productRpcMethods.projectsGetDeleteConfirmation]: {
		input: getProjectDeleteConfirmationInputSchema,
		output: getProjectDeleteConfirmationOutputSchema,
	},
	[productRpcMethods.projectsDelete]: {
		input: requestProjectDeletionInputSchema,
		output: requestProjectDeletionOutputSchema,
	},
	[productRpcMethods.projectsGetSidebar]: {
		input: getProjectSidebarInputSchema,
		output: getProjectSidebarOutputSchema,
	},
	[productRpcMethods.runtimeInventoryList]: {
		input: listRuntimeBoxInventoryInputSchema,
		output: listRuntimeBoxInventoryOutputSchema,
	},
	[productRpcMethods.mcpServersList]: {
		input: listRuntimeBoxMcpServersInputSchema,
		output: listRuntimeBoxMcpServerSummariesOutputSchema,
	},
	[productRpcMethods.mcpServersUpsert]: {
		input: upsertRuntimeBoxMcpServerInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.mcpServersSetEnabled]: {
		input: setRuntimeBoxMcpServerEnabledInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.mcpServersDelete]: {
		input: deleteRuntimeBoxMcpServerInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.mcpList]: {
		input: listMcpServersInputSchema,
		output: listMcpServersOutputSchema,
	},
	[productRpcMethods.mcpUpsert]: {
		input: upsertMcpServerInputSchema,
		output: mcpServerMutationResultSchema,
	},
	[productRpcMethods.mcpSetEnabled]: {
		input: setMcpServerEnabledInputSchema,
		output: mcpServerMutationResultSchema,
	},
	[productRpcMethods.mcpDelete]: {
		input: deleteMcpServerInputSchema,
		output: mcpServerMutationResultSchema,
	},
	[productRpcMethods.agentGlobalProfileGet]: {
		input: getAgentGlobalProfileInputSchema,
		output: getAgentGlobalProfileOutputSchema,
	},
	[productRpcMethods.agentGlobalProfileUpdate]: {
		input: updateAgentGlobalProfileInputSchema,
		output: updateAgentGlobalProfileOutputSchema,
	},
	[productRpcMethods.skillsList]: {
		input: listRuntimeBoxSkillsInputSchema,
		output: listRuntimeBoxSkillsOutputSchema,
	},
	[productRpcMethods.skillsInstall]: {
		input: installRuntimeBoxSkillInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.skillsDelete]: {
		input: deleteRuntimeBoxSkillInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.skillList]: {
		input: listSkillsInputSchema,
		output: listSkillsOutputSchema,
	},
	[productRpcMethods.skillUpsert]: {
		input: upsertSkillInputSchema,
		output: skillMutationResultSchema,
	},
	[productRpcMethods.skillSetEnabled]: {
		input: setSkillEnabledInputSchema,
		output: skillMutationResultSchema,
	},
	[productRpcMethods.skillDelete]: {
		input: deleteSkillInputSchema,
		output: skillMutationResultSchema,
	},
	[productRpcMethods.runtimeProfilesGet]: {
		input: getRuntimeProfileInputSchema,
		output: getRuntimeProfileOutputSchema,
	},
	[productRpcMethods.runtimeProfilesUpdate]: {
		input: updateRuntimeProfileInputSchema,
		output: updateRuntimeProfileOutputSchema,
	},
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
	[productRpcMethods.chatRetiredSessionsList]: {
		input: listRetiredChatSessionsInputSchema,
		output: listRetiredChatSessionsOutputSchema,
	},
	[productRpcMethods.runtimeBoxRegister]: {
		input: runtimeBoxRegisterInputSchema,
		output: runtimeBoxRegisterOutputSchema,
	},
	[productRpcMethods.runtimeBoxReady]: {
		input: emptyParamsSchema,
		output: runtimeBoxRegisterOutputSchema,
	},
	[productRpcMethods.runtimeBoxToolInvoke]: {
		input: runtimeBoxToolInvokeInputSchema,
		output: runtimeBoxToolInvokeOutputSchema,
	},
	[productRpcMethods.runtimeBoxMcpToolInvoke]: {
		input: runtimeBoxMcpToolInvokeInputSchema,
		output: runtimeBoxMcpToolInvokeOutputSchema,
	},
	[productRpcMethods.runtimeBoxProjectValidatePath]: {
		input: validateRuntimeBoxProjectPathInputSchema,
		output: validateRuntimeBoxProjectPathOutputSchema,
	},
	[productRpcMethods.runtimeBoxProjectReadRootAgents]: {
		input: readRuntimeBoxProjectRootAgentsInputSchema,
		output: readRuntimeBoxProjectRootAgentsOutputSchema,
	},
	[productRpcMethods.runtimeBoxInvocationsReconcile]: {
		input: reconcileRuntimeBoxInvocationsInputSchema,
		output: reconcileRuntimeBoxInvocationsOutputSchema,
	},
	[productRpcMethods.runtimeBoxInvocationsAck]: {
		input: acknowledgeRuntimeBoxInvocationsInputSchema,
		output: acknowledgeRuntimeBoxInvocationsOutputSchema,
	},
	[productRpcMethods.runtimeBoxInventoryGetSnapshot]: {
		input: emptyParamsSchema,
		output: runtimeBoxInventorySnapshotSchema,
	},
	[productRpcMethods.runtimeBoxInventoryGetChanges]: {
		input: getRuntimeBoxInventoryChangesInputSchema,
		output: runtimeBoxInventoryChangesPageSchema,
	},
	[productRpcMethods.runtimeBoxMcpServersList]: {
		input: listRuntimeBoxMcpServersInputSchema,
		output: listRuntimeBoxMcpServersOutputSchema,
	},
	[productRpcMethods.runtimeBoxMcpServersUpsert]: {
		input: upsertRuntimeBoxMcpServerInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxMcpServersSetEnabled]: {
		input: setRuntimeBoxMcpServerEnabledInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxMcpServersDelete]: {
		input: deleteRuntimeBoxMcpServerInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxSkillsList]: {
		input: listRuntimeBoxSkillsInputSchema,
		output: listRuntimeBoxSkillsOutputSchema,
	},
	[productRpcMethods.runtimeBoxSkillsInstall]: {
		input: installRuntimeBoxSkillInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxSkillsSetEnabled]: {
		input: setRuntimeBoxSkillEnabledInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxSkillsDelete]: {
		input: deleteRuntimeBoxSkillInputSchema,
		output: runtimeBoxResourceMutationResultSchema,
	},
	[productRpcMethods.runtimeBoxResourcesValidate]: {
		input: validateRuntimeBoxResourcesInputSchema,
		output: validateRuntimeBoxResourcesOutputSchema,
	},
	[productRpcMethods.runtimeBoxSkillGetContent]: {
		input: getRuntimeBoxSkillContentInputSchema,
		output: getRuntimeBoxSkillContentOutputSchema,
	},
} as const;

export const productRpcEventSchemas = {
	[productRpcEvents.chatEvent]: chatEventDeliverySchema,
	[productRpcEvents.runtimeBoxesChanged]: listRuntimeBoxesOutputSchema,
	[productRpcEvents.runtimeBoxToolProgress]: runtimeBoxToolProgressEventSchema,
	[productRpcEvents.runtimeBoxInventoryChanged]: runtimeBoxInventoryChangedHintSchema,
} as const;

export const clientProductRequestMethods = [
	productRpcMethods.runtimeGet,
	productRpcMethods.runtimeBoxesList,
	productRpcMethods.runtimeBoxesSwitch,
	productRpcMethods.runtimeBoxesPairingCreate,
	productRpcMethods.runtimeBoxesPairingListClaims,
	productRpcMethods.runtimeBoxesPairingApprove,
	productRpcMethods.runtimeBoxesPairingReject,
	productRpcMethods.runtimeBoxesDeviceRevoke,
	productRpcMethods.remoteAccessStatus,
	productRpcMethods.remoteAccessAuthStart,
	productRpcMethods.remoteAccessAuthGet,
	productRpcMethods.remoteAccessEnable,
	productRpcMethods.remoteAccessDisable,
	productRpcMethods.remoteAccessRecreate,
	productRpcMethods.runtimeDiagnosticsGet,
	productRpcMethods.projectsPreviewPath,
	productRpcMethods.projectsCreate,
	productRpcMethods.projectsList,
	productRpcMethods.projectsGet,
	productRpcMethods.projectsCheckPath,
	productRpcMethods.projectsUpdateName,
	productRpcMethods.projectsUpdate,
	productRpcMethods.projectsPreviewRelink,
	productRpcMethods.projectsRelink,
	productRpcMethods.projectsSetArchived,
	productRpcMethods.projectsArchive,
	productRpcMethods.projectsGetDeleteConfirmation,
	productRpcMethods.projectsDelete,
	productRpcMethods.projectsGetSidebar,
	productRpcMethods.runtimeInventoryList,
	productRpcMethods.mcpServersList,
	productRpcMethods.mcpServersUpsert,
	productRpcMethods.mcpServersSetEnabled,
	productRpcMethods.mcpServersDelete,
	productRpcMethods.mcpList,
	productRpcMethods.mcpUpsert,
	productRpcMethods.mcpSetEnabled,
	productRpcMethods.mcpDelete,
	productRpcMethods.agentGlobalProfileGet,
	productRpcMethods.agentGlobalProfileUpdate,
	productRpcMethods.skillsList,
	productRpcMethods.skillsInstall,
	productRpcMethods.skillsDelete,
	productRpcMethods.skillList,
	productRpcMethods.skillUpsert,
	productRpcMethods.skillSetEnabled,
	productRpcMethods.skillDelete,
	productRpcMethods.runtimeProfilesGet,
	productRpcMethods.runtimeProfilesUpdate,
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
	productRpcMethods.chatRetiredSessionsList,
] as const;

export const runtimeBoxProductRequestMethods = [
	productRpcMethods.runtimeBoxRegister,
	productRpcMethods.runtimeBoxReady,
	productRpcMethods.runtimeBoxInvocationsReconcile,
] as const;
export const agentsProductEventMethods = [
	productRpcEvents.chatEvent,
	productRpcEvents.chatSessionsRetired,
	productRpcEvents.runtimeBoxesChanged,
] as const;
export const agentsRuntimeBoxRequestMethods = [
	productRpcMethods.runtimeBoxToolInvoke,
	productRpcMethods.runtimeBoxMcpToolInvoke,
	productRpcMethods.runtimeBoxProjectValidatePath,
	productRpcMethods.runtimeBoxProjectReadRootAgents,
	productRpcMethods.runtimeBoxInvocationsAck,
	productRpcMethods.runtimeBoxInventoryGetSnapshot,
	productRpcMethods.runtimeBoxInventoryGetChanges,
	productRpcMethods.runtimeBoxMcpServersList,
	productRpcMethods.runtimeBoxMcpServersUpsert,
	productRpcMethods.runtimeBoxMcpServersSetEnabled,
	productRpcMethods.runtimeBoxMcpServersDelete,
	productRpcMethods.runtimeBoxSkillsList,
	productRpcMethods.runtimeBoxSkillsInstall,
	productRpcMethods.runtimeBoxSkillsSetEnabled,
	productRpcMethods.runtimeBoxSkillsDelete,
	productRpcMethods.runtimeBoxResourcesValidate,
	productRpcMethods.runtimeBoxSkillGetContent,
] as const;
export const runtimeBoxProductEventMethods = [
	productRpcEvents.runtimeBoxToolProgress,
	productRpcEvents.runtimeBoxInventoryChanged,
] as const;

export type SendAskChatMessageInput = z.infer<typeof sendAskChatMessageInputSchema>;
export type CreateProcessChatSessionInput = z.infer<typeof createProcessChatSessionInputSchema>;
export type RuntimeBoxRegisterInput = z.infer<typeof runtimeBoxRegisterInputSchema>;
export type RuntimeBoxRegisterOutput = z.infer<typeof runtimeBoxRegisterOutputSchema>;
export type ChatEventDelivery = z.infer<typeof chatEventDeliverySchema>;
export type ReplayChatEventsInput = z.infer<typeof replayChatEventsInputSchema>;
export type ReplayChatEventsOutput = z.infer<typeof replayChatEventsOutputSchema>;
export type ReplayCursorSupport = z.infer<typeof replayCursorSupportSchema>;
export type ListRetiredChatSessionsInput = z.infer<typeof listRetiredChatSessionsInputSchema>;
export type ListRetiredChatSessionsOutput = z.infer<typeof listRetiredChatSessionsOutputSchema>;
export type GetChatSessionPageInput = z.infer<typeof getChatSessionPageInputSchema>;
export type GetChatSessionPageOutput = z.infer<typeof getChatSessionPageOutputSchema>;
