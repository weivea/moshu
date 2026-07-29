import {
	type ChatRunEvent,
	type CreateProviderInput,
	cancelChatRunOutputSchema,
	chatRunEventSchema,
	chatSendAcceptedOutputSchema,
	createChatSessionOutputSchema,
	createProviderInputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	deleteProviderInputSchema,
	deleteProviderOutputSchema,
	emptyParamsSchema,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	getChatSessionInputSchema,
	getChatSessionSnapshotOutputSchema,
	getDefaultModelOutputSchema,
	type ApproveRuntimeBoxPairingInput,
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	createRuntimeBoxPairingOutputSchema,
	listRuntimeBoxPairingClaimsOutputSchema,
	listRuntimeBoxesOutputSchema,
	type RejectRuntimeBoxPairingInput,
	rejectRuntimeBoxPairingInputSchema,
	rejectRuntimeBoxPairingOutputSchema,
	remoteAccessAuthAttemptInputSchema,
	remoteAccessAuthAttemptSchema,
	remoteAccessMutationOutputSchema,
	runtimeDiagnosticsOutputSchema,
	remoteAccessStatusOutputSchema,
	type CreateProjectInput,
	createProjectInputSchema,
	createProjectOutputSchema,
	type ListProjectsInput,
	listProjectsInputSchema,
	listProjectsOutputSchema,
	getProjectInputSchema,
	getProjectOutputSchema,
	type UpdateProjectInput,
	updateProjectInputSchema,
	updateProjectOutputSchema,
	type SetProjectArchivedInput,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	deleteProjectInputSchema,
	deleteProjectOutputSchema,
	type UpsertRuntimeBoxMcpServerInput,
	type SetRuntimeBoxMcpServerEnabledInput,
	type DeleteRuntimeBoxMcpServerInput,
	type InstallRuntimeBoxSkillInput,
	type DeleteRuntimeBoxSkillInput,
	type UpdateRuntimeProfileInput,
	listRuntimeBoxInventoryInputSchema,
	listRuntimeBoxInventoryOutputSchema,
	listRuntimeBoxMcpServersInputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	setRuntimeBoxMcpServerEnabledInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxMcpServerInputSchema,
	runtimeBoxResourceMutationResultSchema,
	listRuntimeBoxSkillsInputSchema,
	listRuntimeBoxSkillsOutputSchema,
	installRuntimeBoxSkillInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	getRuntimeProfileInputSchema,
	getRuntimeProfileOutputSchema,
	updateRuntimeProfileInputSchema,
	type RevokeRuntimeBoxDeviceInput,
	revokeRuntimeBoxDeviceInputSchema,
	revokeRuntimeBoxDeviceOutputSchema,
	type SwitchRuntimeBoxInput,
	switchRuntimeBoxInputSchema,
	switchRuntimeBoxOutputSchema,
	listAvailableModelsOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	listProvidersOutputSchema,
	logoutProviderInputSchema,
	logoutProviderOutputSchema,
	providerMutationOutputSchema,
	providerAuthAttemptInputSchema,
	providerAuthAttemptOutputSchema,
	respondProviderAuthInputSchema,
	runtimeInfoSchema,
	startProviderAuthInputSchema,
	type StartProviderAuthInput,
	type RespondProviderAuthInput,
	type SessionModelSelection,
	type SetChatSessionModelInput,
	type SetDefaultModelInput,
	type SetProviderModelsEnabledInput,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	setChatSessionModelInputSchema,
	setChatSessionModelOutputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
	type TestProviderInput,
	testProviderInputSchema,
	testProviderOutputSchema,
	type UpdateProviderInput,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	updateProviderInputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import { logChatRpcDiagnostic, traceChatRpcRequest } from "../../../shared/chat-rpc-diagnostics";
import {
	type ChatSessionInvalidation,
	chatSessionInvalidationSchema,
	type DesktopRpc,
	openExternalUrlInputSchema,
	openExternalUrlOutputSchema,
} from "../../../shared/rpc";
import { normalizeDesktopRpcError } from "../../../shared/rpc-errors";
import { ChatSessionInvalidationBridge } from "./session-invalidation-bridge";

const invalidationListenerTimeoutMs = 10_000;
const maxPendingChatSessionInvalidations = 256;
const chatEventListeners = new Set<(event: ChatRunEvent) => void>();
const agentsReadyListeners = new Set<() => void>();
const runtimeBoxesChangedListeners = new Set<
	(snapshot: ReturnType<typeof listRuntimeBoxesOutputSchema.parse>) => void
>();
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
				const event = chatRunEventSchema.parse(payload);
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
	async createProject(input: CreateProjectInput) {
		const parsedInput = createProjectInputSchema.parse(input);
		return createProjectOutputSchema.parse(
			await requestDesktop(() => getRequest().createProject(parsedInput)),
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
	async deleteProject(projectId: string) {
		const input = deleteProjectInputSchema.parse({ projectId });
		return deleteProjectOutputSchema.parse(
			await requestDesktop(() => getRequest().deleteProject(input)),
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
	async createChatSession(model?: SessionModelSelection) {
		const input = model === undefined ? {} : { model };
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
	async listChatSessions(input: { query?: string; archived?: boolean; limit?: number } = {}) {
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
	subscribeChatEvents(listener: (event: ChatRunEvent) => void) {
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
