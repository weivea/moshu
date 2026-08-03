import {
	type ApprovalEventDelivery,
	type ApproveMobilePairingInput,
	type ApproveRuntimeBoxPairingInput,
	approvalEventDeliverySchema,
	approveMobilePairingInputSchema,
	approveMobilePairingOutputSchema,
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	type ChatEventDelivery,
	type ConfirmCreateProjectInput,
	type CreateProviderInput,
	cancelChatRunOutputSchema,
	chatEventDeliverySchema,
	chatSendAcceptedOutputSchema,
	checkProjectPathInputSchema,
	checkProjectPathOutputSchema,
	confirmCreateProjectInputSchema,
	confirmCreateProjectOutputSchema,
	createChatSessionOutputSchema,
	createMobilePairingOutputSchema,
	createProviderInputSchema,
	createRuntimeBoxPairingOutputSchema,
	type DecideApprovalInput,
	type DeleteRuntimeBoxMcpServerInput,
	type DeleteRuntimeBoxSkillInput,
	decideApprovalInputSchema,
	decideApprovalOutputSchema,
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
	type GetApprovalInput,
	type GetSessionApprovalPolicyInput,
	getAgentGlobalProfileInputSchema,
	getAgentGlobalProfileOutputSchema,
	getApprovalInputSchema,
	getApprovalOutputSchema,
	getChatSessionInputSchema,
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
	getSessionApprovalPolicyInputSchema,
	getSessionApprovalPolicyOutputSchema,
	type InstallRuntimeBoxSkillInput,
	installRuntimeBoxSkillInputSchema,
	type ListApprovalsInput,
	type ListMobileDevicesInput,
	type ListProjectsInput,
	listApprovalsInputSchema,
	listApprovalsOutputSchema,
	listAvailableModelsOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	listMcpServersInputSchema,
	listMcpServersOutputSchema,
	listMobileDevicesInputSchema,
	listMobileDevicesOutputSchema,
	listMobilePairingClaimsOutputSchema,
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
	mobileAccessStatusOutputSchema,
	previewProjectPathInputSchema,
	previewProjectPathOutputSchema,
	previewProjectRelinkInputSchema,
	previewProjectRelinkOutputSchema,
	providerAuthAttemptInputSchema,
	providerAuthAttemptOutputSchema,
	providerMutationOutputSchema,
	type RejectMobilePairingInput,
	type RejectRuntimeBoxPairingInput,
	type RespondProviderAuthInput,
	type RevokeMobileDeviceInput,
	type RevokeRuntimeBoxDeviceInput,
	rejectMobilePairingInputSchema,
	rejectMobilePairingOutputSchema,
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
	revokeMobileDeviceInputSchema,
	revokeMobileDeviceOutputSchema,
	revokeRuntimeBoxDeviceInputSchema,
	revokeRuntimeBoxDeviceOutputSchema,
	runtimeBoxResourceMutationResultSchema,
	runtimeDiagnosticsOutputSchema,
	runtimeInfoSchema,
	type SessionListScope,
	type SessionModelSelection,
	type SetChatSessionModelInput,
	type SetDefaultModelInput,
	type SetProjectArchivedInput,
	type SetProviderModelsEnabledInput,
	type SetRuntimeBoxMcpServerEnabledInput,
	type StartProviderAuthInput,
	type SwitchRuntimeBoxInput,
	sessionApprovalPolicyEventSchema,
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
	type TestProviderInput,
	testProviderInputSchema,
	testProviderOutputSchema,
	type UpdateProjectInput,
	type UpdateProviderInput,
	type UpdateRuntimeProfileInput,
	type UpdateSessionApprovalPolicyInput,
	type UpsertRuntimeBoxMcpServerInput,
	updateAgentGlobalProfileInputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	updateProjectInputSchema,
	updateProjectOutputSchema,
	updateProviderInputSchema,
	updateRuntimeProfileInputSchema,
	updateSessionApprovalPolicyInputSchema,
	updateSessionApprovalPolicyOutputSchema,
	upsertMcpServerInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	upsertSkillInputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import { logChatRpcDiagnostic, traceChatRpcRequest } from "../../../shared/chat-rpc-diagnostics";
import {
	type ChatSessionInvalidation,
	chatSessionInvalidationSchema,
	type DesktopChatEvent,
	type DesktopRpc,
	openExternalUrlInputSchema,
	openExternalUrlOutputSchema,
	pickProjectDirectoryOutputSchema,
	toDesktopChatEvent,
} from "../../../shared/rpc";
import { normalizeDesktopRpcError } from "../../../shared/rpc-errors";
import { ChatSessionInvalidationBridge } from "./session-invalidation-bridge";

const invalidationListenerTimeoutMs = 10_000;
const maxPendingChatSessionInvalidations = 256;
const chatEventListeners = new Set<(event: DesktopChatEvent) => void>();
const agentsReadyListeners = new Set<() => void>();
const runtimeBoxesChangedListeners = new Set<
	(snapshot: ReturnType<typeof listRuntimeBoxesOutputSchema.parse>) => void
>();
const approvalEventListeners = new Set<(delivery: ApprovalEventDelivery) => void>();
const sessionApprovalPolicyChangedListeners = new Set<
	(event: ReturnType<typeof sessionApprovalPolicyEventSchema.parse>) => void
>();
const approvalActivityChangedListeners = new Set<() => void>();
const chatSessionInvalidationBridge = new ChatSessionInvalidationBridge({
	timeoutMs: invalidationListenerTimeoutMs,
	maxPending: maxPendingChatSessionInvalidations,
});
const rpc = Electroview.defineRPC<DesktopRpc>({
	maxRequestTime: 125_000,
	handlers: {
		requests: {},
		messages: {
			agentsReady: (payload) => {
				emptyParamsSchema.parse(payload);
				for (const listener of [...agentsReadyListeners]) {
					listener();
				}
			},
			chatEvent: (payload) => {
				const delivery: ChatEventDelivery = chatEventDeliverySchema.parse(payload);
				const event = toDesktopChatEvent(delivery);
				logChatRpcDiagnostic("web", "receive", "chatEvent", event);
				for (const listener of chatEventListeners) {
					listener(event);
				}
			},
			chatSessionInvalidated: (payload) => {
				const invalidation = chatSessionInvalidationSchema.parse(payload);
				void acknowledgeChatSessionInvalidation(invalidation);
			},
			runtimeBoxesChanged: (payload) => {
				const snapshot = listRuntimeBoxesOutputSchema.parse(payload);
				for (const listener of runtimeBoxesChangedListeners) {
					listener(snapshot);
				}
			},
			approvalEvent: (payload) => {
				const delivery = approvalEventDeliverySchema.parse(payload);
				for (const listener of approvalEventListeners) {
					listener(delivery);
				}
			},
			sessionApprovalPolicyChanged: (payload) => {
				const event = sessionApprovalPolicyEventSchema.parse(payload);
				for (const listener of sessionApprovalPolicyChangedListeners) {
					listener(event);
				}
			},
			approvalActivityChanged: (payload) => {
				emptyParamsSchema.parse(payload);
				for (const listener of approvalActivityChangedListeners) {
					listener();
				}
			},
		},
	},
});

const electroview = "__electrobun" in window ? new Electrobun.Electroview({ rpc }) : undefined;

if (electroview !== undefined && !electroview.rpc) {
	throw new Error("Electrobun RPC was not initialized.");
}

function getRequest() {
	if (!electroview?.rpc) {
		throw new Error("Electrobun RPC is unavailable outside the desktop runtime.");
	}
	return electroview.rpc.request;
}

export const desktopClient = {
	subscribeAgentsReady(listener: () => void) {
		agentsReadyListeners.add(listener);
		return () => {
			agentsReadyListeners.delete(listener);
		};
	},
	async getRuntimeInfo() {
		return runtimeInfoSchema.parse(await requestDesktop(() => getRequest().getRuntimeInfo({})));
	},
	subscribeRuntimeBoxesChanged(
		listener: (snapshot: ReturnType<typeof listRuntimeBoxesOutputSchema.parse>) => void,
	) {
		runtimeBoxesChangedListeners.add(listener);
		return () => runtimeBoxesChangedListeners.delete(listener);
	},
	async listRuntimeBoxes() {
		return listRuntimeBoxesOutputSchema.parse(
			await requestDesktop(() => getRequest().listRuntimeBoxes({})),
		);
	},
	subscribeApprovalEvents(listener: (delivery: ApprovalEventDelivery) => void) {
		approvalEventListeners.add(listener);
		return () => approvalEventListeners.delete(listener);
	},
	subscribeSessionApprovalPolicyChanged(
		listener: (event: ReturnType<typeof sessionApprovalPolicyEventSchema.parse>) => void,
	) {
		sessionApprovalPolicyChangedListeners.add(listener);
		return () => sessionApprovalPolicyChangedListeners.delete(listener);
	},
	subscribeApprovalActivityChanged(listener: () => void) {
		approvalActivityChangedListeners.add(listener);
		return () => approvalActivityChangedListeners.delete(listener);
	},
	async listApprovals(input: ListApprovalsInput) {
		const parsedInput = listApprovalsInputSchema.parse(input);
		return listApprovalsOutputSchema.parse(
			await requestDesktop(() => getRequest().listApprovals(parsedInput)),
		);
	},
	async getApproval(input: GetApprovalInput) {
		const parsedInput = getApprovalInputSchema.parse(input);
		return getApprovalOutputSchema.parse(
			await requestDesktop(() => getRequest().getApproval(parsedInput)),
		);
	},
	async decideApproval(input: DecideApprovalInput) {
		const parsedInput = decideApprovalInputSchema.parse(input);
		return decideApprovalOutputSchema.parse(
			await requestDesktop(() => getRequest().decideApproval(parsedInput)),
		);
	},
	async getSessionApprovalPolicy(input: GetSessionApprovalPolicyInput) {
		const parsedInput = getSessionApprovalPolicyInputSchema.parse(input);
		return getSessionApprovalPolicyOutputSchema.parse(
			await requestDesktop(() => getRequest().getSessionApprovalPolicy(parsedInput)),
		);
	},
	async updateSessionApprovalPolicy(input: UpdateSessionApprovalPolicyInput) {
		const parsedInput = updateSessionApprovalPolicyInputSchema.parse(input);
		return updateSessionApprovalPolicyOutputSchema.parse(
			await requestDesktop(() => getRequest().updateSessionApprovalPolicy(parsedInput)),
		);
	},
	async switchRuntimeBox(input: SwitchRuntimeBoxInput) {
		const parsedInput = switchRuntimeBoxInputSchema.parse(input);
		return switchRuntimeBoxOutputSchema.parse(
			await requestDesktop(() => getRequest().switchRuntimeBox(parsedInput)),
		);
	},
	async createRuntimeBoxPairing() {
		return createRuntimeBoxPairingOutputSchema.parse(
			await requestDesktop(() => getRequest().createRuntimeBoxPairing({})),
		);
	},
	async listRuntimeBoxPairingClaims() {
		return listRuntimeBoxPairingClaimsOutputSchema.parse(
			await requestDesktop(() => getRequest().listRuntimeBoxPairingClaims({})),
		);
	},
	async approveRuntimeBoxPairing(input: ApproveRuntimeBoxPairingInput) {
		const parsedInput = approveRuntimeBoxPairingInputSchema.parse(input);
		return approveRuntimeBoxPairingOutputSchema.parse(
			await requestDesktop(() => getRequest().approveRuntimeBoxPairing(parsedInput)),
		);
	},
	async rejectRuntimeBoxPairing(input: RejectRuntimeBoxPairingInput) {
		const parsedInput = rejectRuntimeBoxPairingInputSchema.parse(input);
		return rejectRuntimeBoxPairingOutputSchema.parse(
			await requestDesktop(() => getRequest().rejectRuntimeBoxPairing(parsedInput)),
		);
	},
	async revokeRuntimeBoxDevice(input: RevokeRuntimeBoxDeviceInput) {
		const parsedInput = revokeRuntimeBoxDeviceInputSchema.parse(input);
		return revokeRuntimeBoxDeviceOutputSchema.parse(
			await requestDesktop(() => getRequest().revokeRuntimeBoxDevice(parsedInput)),
		);
	},
	async getMobileAccessStatus() {
		return mobileAccessStatusOutputSchema.parse(
			await requestDesktop(() => getRequest().getMobileAccessStatus({})),
		);
	},
	async createMobilePairing() {
		return createMobilePairingOutputSchema.parse(
			await requestDesktop(() => getRequest().createMobilePairing({})),
		);
	},
	async listMobilePairingClaims() {
		return listMobilePairingClaimsOutputSchema.parse(
			await requestDesktop(() => getRequest().listMobilePairingClaims({})),
		);
	},
	async approveMobilePairing(input: ApproveMobilePairingInput) {
		const parsedInput = approveMobilePairingInputSchema.parse(input);
		return approveMobilePairingOutputSchema.parse(
			await requestDesktop(() => getRequest().approveMobilePairing(parsedInput)),
		);
	},
	async rejectMobilePairing(input: RejectMobilePairingInput) {
		const parsedInput = rejectMobilePairingInputSchema.parse(input);
		return rejectMobilePairingOutputSchema.parse(
			await requestDesktop(() => getRequest().rejectMobilePairing(parsedInput)),
		);
	},
	async listMobileDevices(input: ListMobileDevicesInput = {}) {
		const parsedInput = listMobileDevicesInputSchema.parse(input);
		return listMobileDevicesOutputSchema.parse(
			await requestDesktop(() => getRequest().listMobileDevices(parsedInput)),
		);
	},
	async revokeMobileDevice(input: RevokeMobileDeviceInput) {
		const parsedInput = revokeMobileDeviceInputSchema.parse(input);
		return revokeMobileDeviceOutputSchema.parse(
			await requestDesktop(() => getRequest().revokeMobileDevice(parsedInput)),
		);
	},
	async getRemoteAccessStatus() {
		return remoteAccessStatusOutputSchema.parse(
			await requestDesktop(() => getRequest().getRemoteAccessStatus({})),
		);
	},
	async startRemoteAccessAuthentication() {
		return remoteAccessAuthAttemptSchema.parse(
			await requestDesktop(() => getRequest().startRemoteAccessAuthentication({})),
		);
	},
	async getRemoteAccessAuthentication(attemptId: string) {
		const input = remoteAccessAuthAttemptInputSchema.parse({ attemptId });
		return remoteAccessAuthAttemptSchema.parse(
			await requestDesktop(() => getRequest().getRemoteAccessAuthentication(input)),
		);
	},
	async enableRemoteAccess() {
		return remoteAccessMutationOutputSchema.parse(
			await requestDesktop(() => getRequest().enableRemoteAccess({})),
		);
	},
	async disableRemoteAccess() {
		return remoteAccessMutationOutputSchema.parse(
			await requestDesktop(() => getRequest().disableRemoteAccess({})),
		);
	},
	async recreateRemoteAccess() {
		return remoteAccessMutationOutputSchema.parse(
			await requestDesktop(() => getRequest().recreateRemoteAccess({})),
		);
	},
	async getRuntimeDiagnostics() {
		return runtimeDiagnosticsOutputSchema.parse(
			await requestDesktop(() => getRequest().getRuntimeDiagnostics({})),
		);
	},
	async pickProjectDirectory() {
		return pickProjectDirectoryOutputSchema.parse(
			await requestDesktop(() => getRequest().pickProjectDirectory({})),
		);
	},
	async previewProjectPath(input: Parameters<typeof previewProjectPathInputSchema.parse>[0]) {
		const parsedInput = previewProjectPathInputSchema.parse(input);
		return previewProjectPathOutputSchema.parse(
			await requestDesktop(() => getRequest().previewProjectPath(parsedInput)),
		);
	},
	async confirmCreateProject(input: ConfirmCreateProjectInput) {
		const parsedInput = confirmCreateProjectInputSchema.parse(input);
		return confirmCreateProjectOutputSchema.parse(
			await requestDesktop(() => getRequest().confirmCreateProject(parsedInput)),
		);
	},
	async listProjects(input: ListProjectsInput = {}) {
		const parsedInput = listProjectsInputSchema.parse(input);
		return listProjectsOutputSchema.parse(
			await requestDesktop(() => getRequest().listProjects(parsedInput)),
		);
	},
	async getProject(projectId: string) {
		const input = getProjectInputSchema.parse({ projectId });
		return getProjectOutputSchema.parse(await requestDesktop(() => getRequest().getProject(input)));
	},
	async checkProjectPath(projectId: string) {
		const input = checkProjectPathInputSchema.parse({ projectId });
		return checkProjectPathOutputSchema.parse(
			await requestDesktop(() => getRequest().checkProjectPath(input)),
		);
	},
	async updateProject(input: UpdateProjectInput) {
		const parsedInput = updateProjectInputSchema.parse(input);
		return updateProjectOutputSchema.parse(
			await requestDesktop(() => getRequest().updateProject(parsedInput)),
		);
	},
	async setProjectArchived(input: SetProjectArchivedInput) {
		const parsedInput = setProjectArchivedInputSchema.parse(input);
		return setProjectArchivedOutputSchema.parse(
			await requestDesktop(() => getRequest().setProjectArchived(parsedInput)),
		);
	},
	async previewProjectRelink(input: Parameters<typeof previewProjectRelinkInputSchema.parse>[0]) {
		const parsedInput = previewProjectRelinkInputSchema.parse(input);
		return previewProjectRelinkOutputSchema.parse(
			await requestDesktop(() => getRequest().previewProjectRelink(parsedInput)),
		);
	},
	async relinkProject(input: Parameters<typeof relinkProjectInputSchema.parse>[0]) {
		const parsedInput = relinkProjectInputSchema.parse(input);
		return relinkProjectOutputSchema.parse(
			await requestDesktop(() => getRequest().relinkProject(parsedInput)),
		);
	},
	async getProjectDeleteConfirmation(projectId: string) {
		const input = getProjectDeleteConfirmationInputSchema.parse({ projectId });
		return getProjectDeleteConfirmationOutputSchema.parse(
			await requestDesktop(() => getRequest().getProjectDeleteConfirmation(input)),
		);
	},
	async requestProjectDeletion(
		input: Parameters<typeof requestProjectDeletionInputSchema.parse>[0],
	) {
		const parsedInput = requestProjectDeletionInputSchema.parse(input);
		return requestProjectDeletionOutputSchema.parse(
			await requestDesktop(() => getRequest().requestProjectDeletion(parsedInput)),
		);
	},
	async getProjectSidebar(runtimeBoxId?: string) {
		const input = getProjectSidebarInputSchema.parse({
			...(runtimeBoxId === undefined ? {} : { runtimeBoxId }),
		});
		return getProjectSidebarOutputSchema.parse(
			await requestDesktop(() => getRequest().getProjectSidebar(input)),
		);
	},
	async listRuntimeInventory(runtimeBoxId?: string) {
		const input = listRuntimeBoxInventoryInputSchema.parse({
			...(runtimeBoxId === undefined ? {} : { runtimeBoxId }),
		});
		return listRuntimeBoxInventoryOutputSchema.parse(
			await requestDesktop(() => getRequest().listRuntimeInventory(input)),
		);
	},
	async listMcpServers(runtimeBoxId?: string) {
		const input = listRuntimeBoxMcpServersInputSchema.parse({
			...(runtimeBoxId === undefined ? {} : { runtimeBoxId }),
		});
		return listRuntimeBoxMcpServerSummariesOutputSchema.parse(
			await requestDesktop(() => getRequest().listMcpServers(input)),
		);
	},
	async upsertMcpServer(input: UpsertRuntimeBoxMcpServerInput) {
		const parsed = upsertRuntimeBoxMcpServerInputSchema.parse(input);
		return runtimeBoxResourceMutationResultSchema.parse(
			await requestDesktop(() => getRequest().upsertMcpServer(parsed)),
		);
	},
	async setMcpServerEnabled(input: SetRuntimeBoxMcpServerEnabledInput) {
		const parsed = setRuntimeBoxMcpServerEnabledInputSchema.parse(input);
		return runtimeBoxResourceMutationResultSchema.parse(
			await requestDesktop(() => getRequest().setMcpServerEnabled(parsed)),
		);
	},
	async deleteMcpServer(input: DeleteRuntimeBoxMcpServerInput) {
		const parsed = deleteRuntimeBoxMcpServerInputSchema.parse(input);
		return runtimeBoxResourceMutationResultSchema.parse(
			await requestDesktop(() => getRequest().deleteMcpServer(parsed)),
		);
	},
	async listOwnedMcpServers(input: Parameters<typeof listMcpServersInputSchema.parse>[0]) {
		const parsed = listMcpServersInputSchema.parse(input);
		return listMcpServersOutputSchema.parse(
			await requestDesktop(() => getRequest().listOwnedMcpServers(parsed)),
		);
	},
	async upsertOwnedMcpServer(input: Parameters<typeof upsertMcpServerInputSchema.parse>[0]) {
		const parsed = upsertMcpServerInputSchema.parse(input);
		return mcpServerMutationResultSchema.parse(
			await requestDesktop(() => getRequest().upsertOwnedMcpServer(parsed)),
		);
	},
	async setOwnedMcpServerEnabled(
		input: Parameters<typeof setMcpServerEnabledInputSchema.parse>[0],
	) {
		const parsed = setMcpServerEnabledInputSchema.parse(input);
		return mcpServerMutationResultSchema.parse(
			await requestDesktop(() => getRequest().setOwnedMcpServerEnabled(parsed)),
		);
	},
	async deleteOwnedMcpServer(input: Parameters<typeof deleteMcpServerInputSchema.parse>[0]) {
		const parsed = deleteMcpServerInputSchema.parse(input);
		return mcpServerMutationResultSchema.parse(
			await requestDesktop(() => getRequest().deleteOwnedMcpServer(parsed)),
		);
	},
	async getAgentGlobalProfile(agentId = "moshu.default") {
		const input = getAgentGlobalProfileInputSchema.parse({ agentId });
		return getAgentGlobalProfileOutputSchema.parse(
			await requestDesktop(() => getRequest().getAgentGlobalProfile(input)),
		);
	},
	async updateAgentGlobalProfile(
		input: Parameters<typeof updateAgentGlobalProfileInputSchema.parse>[0],
	) {
		const parsed = updateAgentGlobalProfileInputSchema.parse(input);
		return getAgentGlobalProfileOutputSchema.parse(
			await requestDesktop(() => getRequest().updateAgentGlobalProfile(parsed)),
		);
	},
	async listSkills(runtimeBoxId?: string) {
		const input = listRuntimeBoxSkillsInputSchema.parse({
			...(runtimeBoxId === undefined ? {} : { runtimeBoxId }),
		});
		return listRuntimeBoxSkillsOutputSchema.parse(
			await requestDesktop(() => getRequest().listSkills(input)),
		);
	},
	async installSkill(input: InstallRuntimeBoxSkillInput) {
		const parsed = installRuntimeBoxSkillInputSchema.parse(input);
		return runtimeBoxResourceMutationResultSchema.parse(
			await requestDesktop(() => getRequest().installSkill(parsed)),
		);
	},
	async deleteSkill(input: DeleteRuntimeBoxSkillInput) {
		const parsed = deleteRuntimeBoxSkillInputSchema.parse(input);
		return runtimeBoxResourceMutationResultSchema.parse(
			await requestDesktop(() => getRequest().deleteSkill(parsed)),
		);
	},
	async listOwnedSkills(input: Parameters<typeof listSkillsInputSchema.parse>[0]) {
		const parsed = listSkillsInputSchema.parse(input);
		return listSkillsOutputSchema.parse(
			await requestDesktop(() => getRequest().listOwnedSkills(parsed)),
		);
	},
	async upsertOwnedSkill(input: Parameters<typeof upsertSkillInputSchema.parse>[0]) {
		const parsed = upsertSkillInputSchema.parse(input);
		return skillMutationResultSchema.parse(
			await requestDesktop(() => getRequest().upsertOwnedSkill(parsed)),
		);
	},
	async setOwnedSkillEnabled(input: Parameters<typeof setSkillEnabledInputSchema.parse>[0]) {
		const parsed = setSkillEnabledInputSchema.parse(input);
		return skillMutationResultSchema.parse(
			await requestDesktop(() => getRequest().setOwnedSkillEnabled(parsed)),
		);
	},
	async deleteOwnedSkill(input: Parameters<typeof deleteSkillInputSchema.parse>[0]) {
		const parsed = deleteSkillInputSchema.parse(input);
		return skillMutationResultSchema.parse(
			await requestDesktop(() => getRequest().deleteOwnedSkill(parsed)),
		);
	},
	async getRuntimeProfile(runtimeBoxId?: string) {
		const input = getRuntimeProfileInputSchema.parse({
			agentId: "moshu.default",
			...(runtimeBoxId === undefined ? {} : { runtimeBoxId }),
		});
		return getRuntimeProfileOutputSchema.parse(
			await requestDesktop(() => getRequest().getRuntimeProfile(input)),
		);
	},
	async updateRuntimeProfile(input: UpdateRuntimeProfileInput) {
		const parsed = updateRuntimeProfileInputSchema.parse(input);
		return getRuntimeProfileOutputSchema.parse(
			await requestDesktop(() => getRequest().updateRuntimeProfile(parsed)),
		);
	},
	async listProviders() {
		return listProvidersOutputSchema.parse(
			await requestDesktop(() => getRequest().listProviders({})),
		);
	},
	async createProvider(input: CreateProviderInput) {
		const parsedInput = createProviderInputSchema.parse(input);
		return providerMutationOutputSchema.parse(
			await requestDesktop(() => getRequest().createProvider(parsedInput)),
		);
	},
	async updateProvider(input: UpdateProviderInput) {
		const parsedInput = updateProviderInputSchema.parse(input);
		return providerMutationOutputSchema.parse(
			await requestDesktop(() => getRequest().updateProvider(parsedInput)),
		);
	},
	async deleteProvider(providerId: string) {
		const parsedInput = deleteProviderInputSchema.parse({ schemaVersion: 2, providerId });
		return deleteProviderOutputSchema.parse(
			await requestDesktop(() => getRequest().deleteProvider(parsedInput)),
		);
	},
	async testProvider(input: TestProviderInput) {
		const parsedInput = testProviderInputSchema.parse(input);
		return testProviderOutputSchema.parse(
			await requestDesktop(() => getRequest().testProvider(parsedInput)),
		);
	},
	async fetchProviderModels(providerId: string) {
		const parsedInput = fetchProviderModelsInputSchema.parse({ schemaVersion: 2, providerId });
		return fetchProviderModelsOutputSchema.parse(
			await requestDesktop(() => getRequest().fetchProviderModels(parsedInput)),
		);
	},
	async setProviderModelsEnabled(input: SetProviderModelsEnabledInput) {
		const parsedInput = setProviderModelsEnabledInputSchema.parse(input);
		return setProviderModelsEnabledOutputSchema.parse(
			await requestDesktop(() => getRequest().setProviderModelsEnabled(parsedInput)),
		);
	},
	async providerAuthStart(input: StartProviderAuthInput) {
		const parsedInput = startProviderAuthInputSchema.parse(input);
		return providerAuthAttemptOutputSchema.parse(
			await requestDesktop(() => getRequest().providerAuthStart(parsedInput)),
		);
	},
	async providerAuthGet(attemptId: string) {
		const parsedInput = providerAuthAttemptInputSchema.parse({ attemptId });
		return providerAuthAttemptOutputSchema.parse(
			await requestDesktop(() => getRequest().providerAuthGet(parsedInput)),
		);
	},
	async providerAuthRespond(input: RespondProviderAuthInput) {
		const parsedInput = respondProviderAuthInputSchema.parse(input);
		return providerAuthAttemptOutputSchema.parse(
			await requestDesktop(() => getRequest().providerAuthRespond(parsedInput)),
		);
	},
	async providerAuthCancel(attemptId: string) {
		const parsedInput = providerAuthAttemptInputSchema.parse({ attemptId });
		return providerAuthAttemptOutputSchema.parse(
			await requestDesktop(() => getRequest().providerAuthCancel(parsedInput)),
		);
	},
	async providerLogout(providerId: string) {
		const parsedInput = logoutProviderInputSchema.parse({ schemaVersion: 2, providerId });
		return logoutProviderOutputSchema.parse(
			await requestDesktop(() => getRequest().providerLogout(parsedInput)),
		);
	},
	async openExternalUrl(url: string) {
		const input = openExternalUrlInputSchema.parse({ url });
		return openExternalUrlOutputSchema.parse(
			await requestDesktop(() => getRequest().openExternalUrl(input)),
		);
	},
	async listAvailableModels() {
		return listAvailableModelsOutputSchema.parse(
			await requestDesktop(() => getRequest().listAvailableModels({})),
		);
	},
	async getDefaultModel() {
		return getDefaultModelOutputSchema.parse(
			await requestDesktop(() => getRequest().getDefaultModel({})),
		);
	},
	async setDefaultModel(input: SetDefaultModelInput) {
		const parsedInput = setDefaultModelInputSchema.parse(input);
		return setDefaultModelOutputSchema.parse(
			await requestDesktop(() => getRequest().setDefaultModel(parsedInput)),
		);
	},
	async setChatSessionModel(input: SetChatSessionModelInput) {
		const parsedInput = setChatSessionModelInputSchema.parse(input);
		return setChatSessionModelOutputSchema.parse(
			await requestDesktop(() => getRequest().setChatSessionModel(parsedInput)),
		);
	},
	async createChatSession(model?: SessionModelSelection, projectId?: string) {
		const input = {
			...(model === undefined ? {} : { model }),
			...(projectId === undefined ? {} : { projectId }),
		};
		return traceChatRpcRequest({
			side: "web",
			operation: "createChatSession",
			input,
			execute: async () =>
				createChatSessionOutputSchema.parse(
					await requestDesktop(() => getRequest().createChatSession(input)),
				),
		});
	},
	async getChatSession(sessionId: string) {
		const input = getChatSessionInputSchema.parse({ sessionId });
		return traceChatRpcRequest({
			side: "web",
			operation: "getChatSession",
			input,
			execute: async () =>
				getChatSessionSnapshotOutputSchema.parse(
					await requestDesktop(() => getRequest().getChatSession(input)),
				),
		});
	},
	async listChatSessions(
		input: {
			query?: string;
			archived?: boolean;
			limit?: number;
			runtimeBoxId?: string;
			scope?: SessionListScope;
		} = {},
	) {
		const parsedInput = listChatSessionsInputSchema.parse(input);
		return listChatSessionsOutputSchema.parse(
			await requestDesktop(() => getRequest().listChatSessions(parsedInput)),
		);
	},
	async updateChatSession(sessionId: string, title: string) {
		const input = updateChatSessionInputSchema.parse({ sessionId, title });
		return updateChatSessionOutputSchema.parse(
			await requestDesktop(() => getRequest().updateChatSession(input)),
		);
	},
	async setChatSessionArchived(sessionId: string, archived: boolean) {
		const input = setChatSessionArchivedInputSchema.parse({
			sessionId,
			archived,
		});
		return setChatSessionArchivedOutputSchema.parse(
			await requestDesktop(() => getRequest().setChatSessionArchived(input)),
		);
	},
	async deleteChatSession(sessionId: string) {
		const input = deleteChatSessionInputSchema.parse({ sessionId });
		return deleteChatSessionOutputSchema.parse(
			await requestDesktop(() => getRequest().deleteChatSession(input)),
		);
	},
	async sendChatMessage(input: { requestId?: string; sessionId: string; content: string }) {
		return traceChatRpcRequest({
			side: "web",
			operation: "sendChatMessage",
			input,
			execute: async () =>
				chatSendAcceptedOutputSchema.parse(
					await requestDesktop(() => getRequest().sendChatMessage(input)),
				),
		});
	},
	async cancelChatRun(sessionId: string, runId: string, reason?: string) {
		const input = {
			sessionId: uuidV7Schema.parse(sessionId),
			runId,
			reason,
		};
		return traceChatRpcRequest({
			side: "web",
			operation: "cancelChatRun",
			input,
			execute: async () =>
				cancelChatRunOutputSchema.parse(
					await requestDesktop(() =>
						getRequest().cancelChatRun({
							sessionId: input.sessionId,
							runId,
							reason,
						}),
					),
				),
		});
	},
	subscribeChatEvents(listener: (event: DesktopChatEvent) => void) {
		chatEventListeners.add(listener);
		return () => {
			chatEventListeners.delete(listener);
		};
	},
	subscribeChatSessionInvalidations(
		listener: (invalidation: ChatSessionInvalidation) => void | PromiseLike<void>,
		options: { authoritative?: boolean } = {},
	) {
		return chatSessionInvalidationBridge.subscribe(listener, options);
	},
};

async function acknowledgeChatSessionInvalidation(
	invalidation: ChatSessionInvalidation,
): Promise<void> {
	const accepted = await chatSessionInvalidationBridge.handle(invalidation);
	try {
		await getRequest().acknowledgeChatSessionInvalidation({
			schemaVersion: 1,
			invalidationId: invalidation.invalidationId,
			sessionId: invalidation.sessionId,
			accepted,
		});
	} catch (error) {
		console.error("Failed to acknowledge a chat Session invalidation.", error);
	}
}

async function requestDesktop<T>(execute: () => Promise<T>): Promise<T> {
	try {
		return await execute();
	} catch (error) {
		throw normalizeDesktopRpcError(error);
	}
}

window.addEventListener("beforeunload", () => {
	chatSessionInvalidationBridge.shutdown();
});
