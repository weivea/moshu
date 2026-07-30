import {
	agentsRuntimeInfoSchema,
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatSendAcceptedOutputSchema,
	checkProjectPathInputSchema,
	checkProjectPathOutputSchema,
	confirmCreateProjectInputSchema,
	confirmCreateProjectOutputSchema,
	createProviderInputSchema,
	createRuntimeBoxPairingOutputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	deleteMcpServerInputSchema,
	deleteProviderInputSchema,
	deleteProviderOutputSchema,
	deleteRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	deleteSkillInputSchema,
	emptyParamsSchema,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	type GetChatSessionPageOutput,
	getAgentGlobalProfileInputSchema,
	getAgentGlobalProfileOutputSchema,
	getChatSessionInputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	getChatSessionSnapshotOutputSchema,
	getDefaultModelOutputSchema,
	getProjectDeleteConfirmationInputSchema,
	getProjectDeleteConfirmationOutputSchema,
	getProjectInputSchema,
	getProjectOutputSchema,
	getProjectSidebarInputSchema,
	getProjectSidebarOutputSchema,
	getRuntimeProfileInputSchema,
	getRuntimeProfileOutputSchema,
	installRuntimeBoxSkillInputSchema,
	listAvailableModelsOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	listMcpServersInputSchema,
	listMcpServersOutputSchema,
	listProjectsInputSchema,
	listProjectsOutputSchema,
	listProvidersOutputSchema,
	listRuntimeBoxesOutputSchema,
	listRuntimeBoxInventoryInputSchema,
	listRuntimeBoxInventoryOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	listRuntimeBoxMcpServersInputSchema,
	listRuntimeBoxPairingClaimsOutputSchema,
	listRuntimeBoxSkillsInputSchema,
	listRuntimeBoxSkillsOutputSchema,
	listSkillsInputSchema,
	listSkillsOutputSchema,
	logoutProviderInputSchema,
	logoutProviderOutputSchema,
	mcpServerMutationResultSchema,
	previewProjectPathInputSchema,
	previewProjectPathOutputSchema,
	previewProjectRelinkInputSchema,
	previewProjectRelinkOutputSchema,
	productRpcMethods,
	providerAuthAttemptInputSchema,
	providerAuthAttemptOutputSchema,
	providerMutationOutputSchema,
	rejectRuntimeBoxPairingInputSchema,
	rejectRuntimeBoxPairingOutputSchema,
	relinkProjectInputSchema,
	relinkProjectOutputSchema,
	remoteAccessAuthAttemptInputSchema,
	remoteAccessAuthAttemptSchema,
	remoteAccessMutationOutputSchema,
	remoteAccessStatusOutputSchema,
	requestProjectDeletionInputSchema,
	requestProjectDeletionOutputSchema,
	respondProviderAuthInputSchema,
	revokeRuntimeBoxDeviceInputSchema,
	revokeRuntimeBoxDeviceOutputSchema,
	runtimeBoxResourceMutationResultSchema,
	runtimeDiagnosticsOutputSchema,
	runtimeInfoSchema,
	sendAskChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	setChatSessionModelInputSchema,
	setChatSessionModelOutputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setMcpServerEnabledInputSchema,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
	setRuntimeBoxMcpServerEnabledInputSchema,
	setSkillEnabledInputSchema,
	skillMutationResultSchema,
	startProviderAuthInputSchema,
	switchRuntimeBoxInputSchema,
	switchRuntimeBoxOutputSchema,
	testProviderInputSchema,
	testProviderOutputSchema,
	updateAgentGlobalProfileInputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	updateProjectInputSchema,
	updateProjectOutputSchema,
	updateProviderInputSchema,
	updateRuntimeProfileInputSchema,
	upsertMcpServerInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	upsertSkillInputSchema,
} from "@moshu/contracts";
import { BrowserView, Updater, Utils } from "electrobun/bun";
import { traceChatRpcRequest } from "../shared/chat-rpc-diagnostics";
import {
	acknowledgeChatSessionInvalidationInputSchema,
	type DesktopRpc,
	openExternalUrlInputSchema,
	openExternalUrlOutputSchema,
	pickProjectDirectoryOutputSchema,
	type SendDesktopChatMessageInput,
} from "../shared/rpc";
import type { DesktopAgentsClient } from "./desktop-agents-client";

export interface DesktopRpcDependencies {
	agentsClient: DesktopAgentsClient;
}

export async function pickProjectDirectory(
	openDialog: typeof Utils.openFileDialog = Utils.openFileDialog,
) {
	const selectedPaths = await openDialog({
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	const path = selectedPaths.find((candidate) => candidate.trim().length > 0);
	return pickProjectDirectoryOutputSchema.parse(
		path === undefined ? { cancelled: true } : { cancelled: false, path },
	);
}

export function createDesktopRpc({ agentsClient }: DesktopRpcDependencies) {
	return BrowserView.defineRPC<DesktopRpc>({
		maxRequestTime: 125_000,
		handlers: {
			requests: {
				getRuntimeInfo: async (params) => {
					const server = await agentsClient.request(
						productRpcMethods.runtimeGet,
						params,
						emptyParamsSchema,
						agentsRuntimeInfoSchema,
					);
					return runtimeInfoSchema.parse({
						apiVersion: 1,
						appName: "墨枢",
						appVersion: "0.0.1",
						channel: await Updater.localInfo.channel(),
						electrobunVersion: "1.18.1",
						bunVersion: server.bunVersion,
						platform: server.platform,
						arch: server.arch,
						agentRuntime: server.agentRuntime,
					});
				},
				listRuntimeBoxes: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesList,
						params,
						emptyParamsSchema,
						listRuntimeBoxesOutputSchema,
					),
				switchRuntimeBox: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesSwitch,
						params,
						switchRuntimeBoxInputSchema,
						switchRuntimeBoxOutputSchema,
					),
				createRuntimeBoxPairing: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesPairingCreate,
						params,
						emptyParamsSchema,
						createRuntimeBoxPairingOutputSchema,
					),
				listRuntimeBoxPairingClaims: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesPairingListClaims,
						params,
						emptyParamsSchema,
						listRuntimeBoxPairingClaimsOutputSchema,
					),
				approveRuntimeBoxPairing: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesPairingApprove,
						params,
						approveRuntimeBoxPairingInputSchema,
						approveRuntimeBoxPairingOutputSchema,
					),
				rejectRuntimeBoxPairing: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesPairingReject,
						params,
						rejectRuntimeBoxPairingInputSchema,
						rejectRuntimeBoxPairingOutputSchema,
					),
				revokeRuntimeBoxDevice: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeBoxesDeviceRevoke,
						params,
						revokeRuntimeBoxDeviceInputSchema,
						revokeRuntimeBoxDeviceOutputSchema,
					),
				getRemoteAccessStatus: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessStatus,
						params,
						emptyParamsSchema,
						remoteAccessStatusOutputSchema,
					),
				startRemoteAccessAuthentication: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessAuthStart,
						params,
						emptyParamsSchema,
						remoteAccessAuthAttemptSchema,
					),
				getRemoteAccessAuthentication: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessAuthGet,
						params,
						remoteAccessAuthAttemptInputSchema,
						remoteAccessAuthAttemptSchema,
					),
				enableRemoteAccess: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessEnable,
						params,
						emptyParamsSchema,
						remoteAccessMutationOutputSchema,
					),
				disableRemoteAccess: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessDisable,
						params,
						emptyParamsSchema,
						remoteAccessMutationOutputSchema,
					),
				recreateRemoteAccess: (params) =>
					agentsClient.request(
						productRpcMethods.remoteAccessRecreate,
						params,
						emptyParamsSchema,
						remoteAccessMutationOutputSchema,
					),
				getRuntimeDiagnostics: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeDiagnosticsGet,
						params,
						emptyParamsSchema,
						runtimeDiagnosticsOutputSchema,
					),
				pickProjectDirectory: async (params) => {
					emptyParamsSchema.parse(params);
					return pickProjectDirectory();
				},
				previewProjectPath: (params) =>
					agentsClient.request(
						productRpcMethods.projectsPreviewPath,
						params,
						previewProjectPathInputSchema,
						previewProjectPathOutputSchema,
					),
				confirmCreateProject: (params) =>
					agentsClient.request(
						productRpcMethods.projectsCreate,
						params,
						confirmCreateProjectInputSchema,
						confirmCreateProjectOutputSchema,
					),
				listProjects: (params) =>
					agentsClient.request(
						productRpcMethods.projectsList,
						params,
						listProjectsInputSchema,
						listProjectsOutputSchema,
					),
				getProject: (params) =>
					agentsClient.request(
						productRpcMethods.projectsGet,
						params,
						getProjectInputSchema,
						getProjectOutputSchema,
					),
				checkProjectPath: (params) =>
					agentsClient.request(
						productRpcMethods.projectsCheckPath,
						params,
						checkProjectPathInputSchema,
						checkProjectPathOutputSchema,
					),
				updateProject: (params) =>
					agentsClient.request(
						productRpcMethods.projectsUpdate,
						params,
						updateProjectInputSchema,
						updateProjectOutputSchema,
					),
				setProjectArchived: (params) =>
					agentsClient.request(
						productRpcMethods.projectsArchive,
						params,
						setProjectArchivedInputSchema,
						setProjectArchivedOutputSchema,
					),
				previewProjectRelink: (params) =>
					agentsClient.request(
						productRpcMethods.projectsPreviewRelink,
						params,
						previewProjectRelinkInputSchema,
						previewProjectRelinkOutputSchema,
					),
				relinkProject: (params) =>
					agentsClient.request(
						productRpcMethods.projectsRelink,
						params,
						relinkProjectInputSchema,
						relinkProjectOutputSchema,
					),
				getProjectDeleteConfirmation: (params) =>
					agentsClient.request(
						productRpcMethods.projectsGetDeleteConfirmation,
						params,
						getProjectDeleteConfirmationInputSchema,
						getProjectDeleteConfirmationOutputSchema,
					),
				requestProjectDeletion: (params) =>
					agentsClient.request(
						productRpcMethods.projectsDelete,
						params,
						requestProjectDeletionInputSchema,
						requestProjectDeletionOutputSchema,
					),
				getProjectSidebar: (params) =>
					agentsClient.request(
						productRpcMethods.projectsGetSidebar,
						params,
						getProjectSidebarInputSchema,
						getProjectSidebarOutputSchema,
					),
				listRuntimeInventory: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeInventoryList,
						params,
						listRuntimeBoxInventoryInputSchema,
						listRuntimeBoxInventoryOutputSchema,
					),
				listMcpServers: (params) =>
					agentsClient.request(
						productRpcMethods.mcpServersList,
						params,
						listRuntimeBoxMcpServersInputSchema,
						listRuntimeBoxMcpServerSummariesOutputSchema,
					),
				upsertMcpServer: (params) =>
					agentsClient.request(
						productRpcMethods.mcpServersUpsert,
						params,
						upsertRuntimeBoxMcpServerInputSchema,
						runtimeBoxResourceMutationResultSchema,
					),
				setMcpServerEnabled: (params) =>
					agentsClient.request(
						productRpcMethods.mcpServersSetEnabled,
						params,
						setRuntimeBoxMcpServerEnabledInputSchema,
						runtimeBoxResourceMutationResultSchema,
					),
				deleteMcpServer: (params) =>
					agentsClient.request(
						productRpcMethods.mcpServersDelete,
						params,
						deleteRuntimeBoxMcpServerInputSchema,
						runtimeBoxResourceMutationResultSchema,
					),
				listOwnedMcpServers: (params) =>
					agentsClient.request(
						productRpcMethods.mcpList,
						params,
						listMcpServersInputSchema,
						listMcpServersOutputSchema,
					),
				upsertOwnedMcpServer: (params) =>
					agentsClient.request(
						productRpcMethods.mcpUpsert,
						params,
						upsertMcpServerInputSchema,
						mcpServerMutationResultSchema,
					),
				setOwnedMcpServerEnabled: (params) =>
					agentsClient.request(
						productRpcMethods.mcpSetEnabled,
						params,
						setMcpServerEnabledInputSchema,
						mcpServerMutationResultSchema,
					),
				deleteOwnedMcpServer: (params) =>
					agentsClient.request(
						productRpcMethods.mcpDelete,
						params,
						deleteMcpServerInputSchema,
						mcpServerMutationResultSchema,
					),
				getAgentGlobalProfile: (params) =>
					agentsClient.request(
						productRpcMethods.agentGlobalProfileGet,
						params,
						getAgentGlobalProfileInputSchema,
						getAgentGlobalProfileOutputSchema,
					),
				updateAgentGlobalProfile: (params) =>
					agentsClient.request(
						productRpcMethods.agentGlobalProfileUpdate,
						params,
						updateAgentGlobalProfileInputSchema,
						getAgentGlobalProfileOutputSchema,
					),
				listSkills: (params) =>
					agentsClient.request(
						productRpcMethods.skillsList,
						params,
						listRuntimeBoxSkillsInputSchema,
						listRuntimeBoxSkillsOutputSchema,
					),
				installSkill: (params) =>
					agentsClient.request(
						productRpcMethods.skillsInstall,
						params,
						installRuntimeBoxSkillInputSchema,
						runtimeBoxResourceMutationResultSchema,
					),
				deleteSkill: (params) =>
					agentsClient.request(
						productRpcMethods.skillsDelete,
						params,
						deleteRuntimeBoxSkillInputSchema,
						runtimeBoxResourceMutationResultSchema,
					),
				listOwnedSkills: (params) =>
					agentsClient.request(
						productRpcMethods.skillList,
						params,
						listSkillsInputSchema,
						listSkillsOutputSchema,
					),
				upsertOwnedSkill: (params) =>
					agentsClient.request(
						productRpcMethods.skillUpsert,
						params,
						upsertSkillInputSchema,
						skillMutationResultSchema,
					),
				setOwnedSkillEnabled: (params) =>
					agentsClient.request(
						productRpcMethods.skillSetEnabled,
						params,
						setSkillEnabledInputSchema,
						skillMutationResultSchema,
					),
				deleteOwnedSkill: (params) =>
					agentsClient.request(
						productRpcMethods.skillDelete,
						params,
						deleteSkillInputSchema,
						skillMutationResultSchema,
					),
				getRuntimeProfile: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeProfilesGet,
						params,
						getRuntimeProfileInputSchema,
						getRuntimeProfileOutputSchema,
					),
				updateRuntimeProfile: (params) =>
					agentsClient.request(
						productRpcMethods.runtimeProfilesUpdate,
						params,
						updateRuntimeProfileInputSchema,
						getRuntimeProfileOutputSchema,
					),
				listProviders: (params) =>
					agentsClient.request(
						productRpcMethods.providersList,
						params,
						emptyParamsSchema,
						listProvidersOutputSchema,
					),
				createProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersCreate,
						params,
						createProviderInputSchema,
						providerMutationOutputSchema,
					),
				updateProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersUpdate,
						params,
						updateProviderInputSchema,
						providerMutationOutputSchema,
					),
				deleteProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersDelete,
						params,
						deleteProviderInputSchema,
						deleteProviderOutputSchema,
					),
				testProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersTest,
						params,
						testProviderInputSchema,
						testProviderOutputSchema,
					),
				fetchProviderModels: (params) =>
					agentsClient.request(
						productRpcMethods.providersFetchModels,
						params,
						fetchProviderModelsInputSchema,
						fetchProviderModelsOutputSchema,
					),
				setProviderModelsEnabled: (params) =>
					agentsClient.request(
						productRpcMethods.providersSetModelsEnabled,
						params,
						setProviderModelsEnabledInputSchema,
						setProviderModelsEnabledOutputSchema,
					),
				providerAuthStart: (params) =>
					agentsClient.request(
						productRpcMethods.providerAuthStart,
						params,
						startProviderAuthInputSchema,
						providerAuthAttemptOutputSchema,
					),
				providerAuthGet: (params) =>
					agentsClient.request(
						productRpcMethods.providerAuthGet,
						params,
						providerAuthAttemptInputSchema,
						providerAuthAttemptOutputSchema,
					),
				providerAuthRespond: (params) =>
					agentsClient.request(
						productRpcMethods.providerAuthRespond,
						params,
						respondProviderAuthInputSchema,
						providerAuthAttemptOutputSchema,
					),
				providerAuthCancel: (params) =>
					agentsClient.request(
						productRpcMethods.providerAuthCancel,
						params,
						providerAuthAttemptInputSchema,
						providerAuthAttemptOutputSchema,
					),
				providerLogout: (params) =>
					agentsClient.request(
						productRpcMethods.providerLogout,
						params,
						logoutProviderInputSchema,
						logoutProviderOutputSchema,
					),
				openExternalUrl: (params) => {
					const input = openExternalUrlInputSchema.parse(params);
					return openExternalUrlOutputSchema.parse({ opened: Utils.openExternal(input.url) });
				},
				listAvailableModels: (params) =>
					agentsClient.request(
						productRpcMethods.modelsListAvailable,
						params,
						emptyParamsSchema,
						listAvailableModelsOutputSchema,
					),
				getDefaultModel: (params) =>
					agentsClient.request(
						productRpcMethods.defaultModelGet,
						params,
						emptyParamsSchema,
						getDefaultModelOutputSchema,
					),
				setDefaultModel: (params) =>
					agentsClient.request(
						productRpcMethods.defaultModelSet,
						params,
						setDefaultModelInputSchema,
						setDefaultModelOutputSchema,
					),
				createChatSession: (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "createChatSession",
						input: params,
						execute: () => agentsClient.createSession(undefined, params.model, params.projectId),
					}),
				getChatSession: (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "getChatSession",
						input: params,
						execute: () => getCompleteSessionSnapshot(agentsClient, params),
					}),
				listChatSessions: (params) =>
					agentsClient.request(
						productRpcMethods.sessionList,
						params,
						listChatSessionsInputSchema,
						listChatSessionsOutputSchema,
					),
				updateChatSession: (params) =>
					agentsClient.request(
						productRpcMethods.sessionUpdate,
						params,
						updateChatSessionInputSchema,
						updateChatSessionOutputSchema,
					),
				setChatSessionArchived: (params) =>
					agentsClient.request(
						productRpcMethods.sessionArchive,
						params,
						setChatSessionArchivedInputSchema,
						setChatSessionArchivedOutputSchema,
					),
				setChatSessionModel: (params) =>
					agentsClient.request(
						productRpcMethods.sessionSetModel,
						params,
						setChatSessionModelInputSchema,
						setChatSessionModelOutputSchema,
						params.sessionId,
					),
				deleteChatSession: (params) =>
					agentsClient.request(
						productRpcMethods.sessionDelete,
						params,
						deleteChatSessionInputSchema,
						deleteChatSessionOutputSchema,
					),
				sendChatMessage: (params: SendDesktopChatMessageInput) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "sendChatMessage",
						input: params,
						execute: () => forwardChatSend(agentsClient, params),
					}),
				cancelChatRun: (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "cancelChatRun",
						input: params,
						execute: () =>
							agentsClient.request(
								productRpcMethods.chatCancel,
								{
									runId: params.runId,
									...(params.reason === undefined ? {} : { reason: params.reason }),
								},
								cancelChatRunInputSchema,
								cancelChatRunOutputSchema,
								params.sessionId,
							),
					}),
				acknowledgeChatSessionInvalidation: (params) => {
					agentsClient.acknowledgeChatSessionInvalidation(
						acknowledgeChatSessionInvalidationInputSchema.parse(params),
					);
					return {};
				},
			},
			messages: {},
		},
	});
}

async function forwardChatSend(
	agentsClient: DesktopAgentsClient,
	input: SendDesktopChatMessageInput,
) {
	return agentsClient.request(
		productRpcMethods.chatSend,
		{ ...input, requestId: input.requestId ?? crypto.randomUUID() },
		sendAskChatMessageInputSchema,
		chatSendAcceptedOutputSchema,
	);
}

async function getCompleteSessionSnapshot(agentsClient: DesktopAgentsClient, input: unknown) {
	const parsedInput = getChatSessionInputSchema.parse(input);
	let cursor: string | undefined;
	let session: GetChatSessionPageOutput["session"] | undefined;
	const messages: GetChatSessionPageOutput["messages"] = [];
	const chronologicalRuns: GetChatSessionPageOutput["runs"] = [];
	const eventCursors: GetChatSessionPageOutput["eventCursors"] = [];

	while (true) {
		const page = await agentsClient.request(
			productRpcMethods.sessionGet,
			{
				sessionId: parsedInput.sessionId,
				...(cursor === undefined ? {} : { cursor }),
				limit: 2,
			},
			getChatSessionPageInputSchema,
			getChatSessionPageOutputSchema,
		);
		session = page.session;
		messages.push(...page.messages);
		chronologicalRuns.push(...page.runs);
		eventCursors.push(...page.eventCursors);
		if (page.nextCursor === undefined) {
			break;
		}
		cursor = page.nextCursor;
	}

	return getChatSessionSnapshotOutputSchema.parse({
		session,
		messages: messages.map((message, index) => ({ ...message, sequence: index + 1 })),
		runs: chronologicalRuns.reverse(),
		eventCursors,
	});
}
