import {
	type ApprovalEventDelivery,
	type ApproveMobilePairingInput,
	type ApproveMobilePairingOutput,
	type ApproveRuntimeBoxPairingInput,
	type ApproveRuntimeBoxPairingOutput,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatEventDelivery,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type CheckProjectPathInput,
	type CheckProjectPathOutput,
	type ConfirmCreateProjectInput,
	type ConfirmCreateProjectOutput,
	type CreateChatSessionOutput,
	type CreateMobilePairingOutput,
	type CreateProviderInput,
	type CreateRuntimeBoxPairingOutput,
	type DecideApprovalInput,
	type DecideApprovalOutput,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	type DeleteMcpServerInput,
	type DeleteProviderInput,
	type DeleteProviderOutput,
	type DeleteRuntimeBoxMcpServerInput,
	type DeleteRuntimeBoxSkillInput,
	type DeleteSkillInput,
	type EmptyParams,
	type FetchProviderModelsInput,
	type FetchProviderModelsOutput,
	type GetAgentGlobalProfileInput,
	type GetAgentGlobalProfileOutput,
	type GetApprovalInput,
	type GetApprovalOutput,
	type GetChatSessionInput,
	type GetChatSessionSnapshotOutput,
	type GetDefaultModelOutput,
	type GetProjectDeleteConfirmationInput,
	type GetProjectDeleteConfirmationOutput,
	type GetProjectInput,
	type GetProjectOutput,
	type GetProjectSidebarInput,
	type GetProjectSidebarOutput,
	type GetRuntimeProfileInput,
	type GetRuntimeProfileOutput,
	type GetSessionApprovalPolicyInput,
	type GetSessionApprovalPolicyOutput,
	type InstallRuntimeBoxSkillInput,
	type ListApprovalsInput,
	type ListApprovalsOutput,
	type ListAvailableModelsOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type ListMcpServersInput,
	type ListMcpServersOutput,
	type ListMobileDevicesInput,
	type ListMobileDevicesOutput,
	type ListMobilePairingClaimsOutput,
	type ListProjectsInput,
	type ListProjectsOutput,
	type ListProvidersOutput,
	type ListRuntimeBoxesOutput,
	type ListRuntimeBoxInventoryOutput,
	type ListRuntimeBoxMcpServerSummariesOutput,
	type ListRuntimeBoxMcpServersInput,
	type ListRuntimeBoxPairingClaimsOutput,
	type ListRuntimeBoxSkillsInput,
	type ListRuntimeBoxSkillsOutput,
	type ListSkillsInput,
	type ListSkillsOutput,
	type McpServerMutationResult,
	type MobileAccessStatusOutput,
	type PreviewProjectPathInput,
	type PreviewProjectPathOutput,
	type PreviewProjectRelinkInput,
	type PreviewProjectRelinkOutput,
	type ProviderAuthAttemptOutput,
	type ProviderMutationOutput,
	type RejectMobilePairingInput,
	type RejectMobilePairingOutput,
	type RejectRuntimeBoxPairingInput,
	type RejectRuntimeBoxPairingOutput,
	type RelinkProjectInput,
	type RelinkProjectOutput,
	type RemoteAccessAuthAttempt,
	type RemoteAccessMutationOutput,
	type RemoteAccessStatusOutput,
	type RequestProjectDeletionInput,
	type RequestProjectDeletionOutput,
	type RespondProviderAuthInput,
	type RevokeMobileDeviceInput,
	type RevokeMobileDeviceOutput,
	type RevokeRuntimeBoxDeviceInput,
	type RevokeRuntimeBoxDeviceOutput,
	type RuntimeBoxResourceMutationResult,
	type RuntimeDiagnosticsOutput,
	type RuntimeInfo,
	type SessionApprovalPolicyEvent,
	type SessionModelSelection,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type SetChatSessionModelInput,
	type SetChatSessionModelOutput,
	type SetDefaultModelInput,
	type SetDefaultModelOutput,
	type SetMcpServerEnabledInput,
	type SetProjectArchivedInput,
	type SetProjectArchivedOutput,
	type SetProviderModelsEnabledInput,
	type SetProviderModelsEnabledOutput,
	type SetRuntimeBoxMcpServerEnabledInput,
	type SetSkillEnabledInput,
	type SkillMutationResult,
	type StartProviderAuthInput,
	type SwitchRuntimeBoxInput,
	type SwitchRuntimeBoxOutput,
	type TestProviderInput,
	type TestProviderOutput,
	type UpdateAgentGlobalProfileInput,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	type UpdateProjectInput,
	type UpdateProjectOutput,
	type UpdateProviderInput,
	chatEventDeliverySchema,
	type UpdateRuntimeProfileInput,
	type UpdateSessionApprovalPolicyInput,
	type UpdateSessionApprovalPolicyOutput,
	type UpsertMcpServerInput,
	type UpsertRuntimeBoxMcpServerInput,
	type UpsertSkillInput,
	uuidV7Schema,
} from "@moshu/contracts";
import type { RPCSchema } from "electrobun/bun";
import { z } from "zod";

type EmptyRpcMap = Record<never, never>;

export type DesktopChatEvent = ChatRunEvent & {
	clientRequestId?: string;
};

export function toDesktopChatEvent(delivery: ChatEventDelivery): DesktopChatEvent {
	return delivery.clientRequestId === undefined
		? delivery.event
		: { ...delivery.event, clientRequestId: delivery.clientRequestId };
}

export function toChatEventDelivery(event: DesktopChatEvent): ChatEventDelivery {
	const eventValue: Record<string, unknown> = { ...event };
	delete eventValue.clientRequestId;
	return chatEventDeliverySchema.parse({
		event: eventValue,
		...(event.clientRequestId === undefined ? {} : { clientRequestId: event.clientRequestId }),
	});
}

export interface CreateDesktopChatSessionInput {
	model?: SessionModelSelection;
	projectId?: string;
}

export interface SendDesktopChatMessageInput {
	requestId?: string;
	sessionId: string;
	content: string;
}

export interface CancelDesktopChatRunInput extends CancelChatRunInput {
	sessionId: string;
}

export const chatSessionInvalidationSchema = z
	.object({
		schemaVersion: z.literal(1),
		invalidationId: z.string().uuid(),
		sessionId: uuidV7Schema,
		reason: z.enum(["session_retired", "history_expired"]),
	})
	.strict();

export const acknowledgeChatSessionInvalidationInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		invalidationId: z.string().uuid(),
		sessionId: uuidV7Schema,
		accepted: z.boolean(),
	})
	.strict();

export type ChatSessionInvalidation = z.infer<typeof chatSessionInvalidationSchema>;
export type AcknowledgeChatSessionInvalidationInput = z.infer<
	typeof acknowledgeChatSessionInvalidationInputSchema
>;
export const openExternalUrlInputSchema = z.object({ url: z.string().url() }).strict();
export const openExternalUrlOutputSchema = z.object({ opened: z.boolean() }).strict();
export const pickProjectDirectoryOutputSchema = z.discriminatedUnion("cancelled", [
	z.object({ cancelled: z.literal(true) }).strict(),
	z.object({ cancelled: z.literal(false), path: z.string().trim().min(1).max(4_096) }).strict(),
]);
export type PickProjectDirectoryOutput = z.infer<typeof pickProjectDirectoryOutputSchema>;

export type DesktopRpc = {
	bun: RPCSchema<{
		requests: {
			getRuntimeInfo: {
				params: EmptyParams;
				response: RuntimeInfo;
			};
			listRuntimeBoxes: {
				params: EmptyParams;
				response: ListRuntimeBoxesOutput;
			};
			switchRuntimeBox: {
				params: SwitchRuntimeBoxInput;
				response: SwitchRuntimeBoxOutput;
			};
			createRuntimeBoxPairing: {
				params: EmptyParams;
				response: CreateRuntimeBoxPairingOutput;
			};
			listRuntimeBoxPairingClaims: {
				params: EmptyParams;
				response: ListRuntimeBoxPairingClaimsOutput;
			};
			approveRuntimeBoxPairing: {
				params: ApproveRuntimeBoxPairingInput;
				response: ApproveRuntimeBoxPairingOutput;
			};
			rejectRuntimeBoxPairing: {
				params: RejectRuntimeBoxPairingInput;
				response: RejectRuntimeBoxPairingOutput;
			};
			revokeRuntimeBoxDevice: {
				params: RevokeRuntimeBoxDeviceInput;
				response: RevokeRuntimeBoxDeviceOutput;
			};
			getMobileAccessStatus: {
				params: EmptyParams;
				response: MobileAccessStatusOutput;
			};
			createMobilePairing: {
				params: EmptyParams;
				response: CreateMobilePairingOutput;
			};
			listMobilePairingClaims: {
				params: EmptyParams;
				response: ListMobilePairingClaimsOutput;
			};
			approveMobilePairing: {
				params: ApproveMobilePairingInput;
				response: ApproveMobilePairingOutput;
			};
			rejectMobilePairing: {
				params: RejectMobilePairingInput;
				response: RejectMobilePairingOutput;
			};
			listMobileDevices: {
				params: ListMobileDevicesInput;
				response: ListMobileDevicesOutput;
			};
			revokeMobileDevice: {
				params: RevokeMobileDeviceInput;
				response: RevokeMobileDeviceOutput;
			};
			getRemoteAccessStatus: {
				params: EmptyParams;
				response: RemoteAccessStatusOutput;
			};
			startRemoteAccessAuthentication: {
				params: EmptyParams;
				response: RemoteAccessAuthAttempt;
			};
			getRemoteAccessAuthentication: {
				params: { attemptId: string };
				response: RemoteAccessAuthAttempt;
			};
			enableRemoteAccess: {
				params: EmptyParams;
				response: RemoteAccessMutationOutput;
			};
			disableRemoteAccess: {
				params: EmptyParams;
				response: RemoteAccessMutationOutput;
			};
			recreateRemoteAccess: {
				params: EmptyParams;
				response: RemoteAccessMutationOutput;
			};
			getRuntimeDiagnostics: {
				params: EmptyParams;
				response: RuntimeDiagnosticsOutput;
			};
			pickProjectDirectory: {
				params: EmptyParams;
				response: PickProjectDirectoryOutput;
			};
			previewProjectPath: {
				params: PreviewProjectPathInput;
				response: PreviewProjectPathOutput;
			};
			confirmCreateProject: {
				params: ConfirmCreateProjectInput;
				response: ConfirmCreateProjectOutput;
			};
			listProjects: {
				params: ListProjectsInput;
				response: ListProjectsOutput;
			};
			getProject: {
				params: GetProjectInput;
				response: GetProjectOutput;
			};
			checkProjectPath: {
				params: CheckProjectPathInput;
				response: CheckProjectPathOutput;
			};
			updateProject: {
				params: UpdateProjectInput;
				response: UpdateProjectOutput;
			};
			setProjectArchived: {
				params: SetProjectArchivedInput;
				response: SetProjectArchivedOutput;
			};
			previewProjectRelink: {
				params: PreviewProjectRelinkInput;
				response: PreviewProjectRelinkOutput;
			};
			relinkProject: {
				params: RelinkProjectInput;
				response: RelinkProjectOutput;
			};
			getProjectDeleteConfirmation: {
				params: GetProjectDeleteConfirmationInput;
				response: GetProjectDeleteConfirmationOutput;
			};
			requestProjectDeletion: {
				params: RequestProjectDeletionInput;
				response: RequestProjectDeletionOutput;
			};
			getProjectSidebar: {
				params: GetProjectSidebarInput;
				response: GetProjectSidebarOutput;
			};
			listRuntimeInventory: {
				params: { runtimeBoxId?: string };
				response: ListRuntimeBoxInventoryOutput;
			};
			listMcpServers: {
				params: ListRuntimeBoxMcpServersInput;
				response: ListRuntimeBoxMcpServerSummariesOutput;
			};
			upsertMcpServer: {
				params: UpsertRuntimeBoxMcpServerInput;
				response: RuntimeBoxResourceMutationResult;
			};
			setMcpServerEnabled: {
				params: SetRuntimeBoxMcpServerEnabledInput;
				response: RuntimeBoxResourceMutationResult;
			};
			deleteMcpServer: {
				params: DeleteRuntimeBoxMcpServerInput;
				response: RuntimeBoxResourceMutationResult;
			};
			listOwnedMcpServers: {
				params: ListMcpServersInput;
				response: ListMcpServersOutput;
			};
			upsertOwnedMcpServer: {
				params: UpsertMcpServerInput;
				response: McpServerMutationResult;
			};
			setOwnedMcpServerEnabled: {
				params: SetMcpServerEnabledInput;
				response: McpServerMutationResult;
			};
			deleteOwnedMcpServer: {
				params: DeleteMcpServerInput;
				response: McpServerMutationResult;
			};
			getAgentGlobalProfile: {
				params: GetAgentGlobalProfileInput;
				response: GetAgentGlobalProfileOutput;
			};
			updateAgentGlobalProfile: {
				params: UpdateAgentGlobalProfileInput;
				response: GetAgentGlobalProfileOutput;
			};
			listSkills: {
				params: ListRuntimeBoxSkillsInput;
				response: ListRuntimeBoxSkillsOutput;
			};
			installSkill: {
				params: InstallRuntimeBoxSkillInput;
				response: RuntimeBoxResourceMutationResult;
			};
			deleteSkill: {
				params: DeleteRuntimeBoxSkillInput;
				response: RuntimeBoxResourceMutationResult;
			};
			listOwnedSkills: {
				params: ListSkillsInput;
				response: ListSkillsOutput;
			};
			upsertOwnedSkill: {
				params: UpsertSkillInput;
				response: SkillMutationResult;
			};
			setOwnedSkillEnabled: {
				params: SetSkillEnabledInput;
				response: SkillMutationResult;
			};
			deleteOwnedSkill: {
				params: DeleteSkillInput;
				response: SkillMutationResult;
			};
			getRuntimeProfile: {
				params: GetRuntimeProfileInput;
				response: GetRuntimeProfileOutput;
			};
			updateRuntimeProfile: {
				params: UpdateRuntimeProfileInput;
				response: GetRuntimeProfileOutput;
			};
			listProviders: {
				params: EmptyParams;
				response: ListProvidersOutput;
			};
			createProvider: {
				params: CreateProviderInput;
				response: ProviderMutationOutput;
			};
			updateProvider: {
				params: UpdateProviderInput;
				response: ProviderMutationOutput;
			};
			deleteProvider: {
				params: DeleteProviderInput;
				response: DeleteProviderOutput;
			};
			testProvider: {
				params: TestProviderInput;
				response: TestProviderOutput;
			};
			fetchProviderModels: {
				params: FetchProviderModelsInput;
				response: FetchProviderModelsOutput;
			};
			setProviderModelsEnabled: {
				params: SetProviderModelsEnabledInput;
				response: SetProviderModelsEnabledOutput;
			};
			providerAuthStart: {
				params: StartProviderAuthInput;
				response: ProviderAuthAttemptOutput;
			};
			providerAuthGet: {
				params: { attemptId: string };
				response: ProviderAuthAttemptOutput;
			};
			providerAuthRespond: {
				params: RespondProviderAuthInput;
				response: ProviderAuthAttemptOutput;
			};
			providerAuthCancel: {
				params: { attemptId: string };
				response: ProviderAuthAttemptOutput;
			};
			providerLogout: {
				params: { schemaVersion: 2; providerId: string };
				response: { schemaVersion: 2; providerId: string; configured: false };
			};
			openExternalUrl: {
				params: { url: string };
				response: { opened: boolean };
			};
			listAvailableModels: {
				params: EmptyParams;
				response: ListAvailableModelsOutput;
			};
			getDefaultModel: {
				params: EmptyParams;
				response: GetDefaultModelOutput;
			};
			setDefaultModel: {
				params: SetDefaultModelInput;
				response: SetDefaultModelOutput;
			};
			createChatSession: {
				params: CreateDesktopChatSessionInput;
				response: CreateChatSessionOutput;
			};
			getChatSession: {
				params: GetChatSessionInput;
				response: GetChatSessionSnapshotOutput;
			};
			listChatSessions: {
				params: ListChatSessionsInput;
				response: ListChatSessionsOutput;
			};
			updateChatSession: {
				params: UpdateChatSessionInput;
				response: UpdateChatSessionOutput;
			};
			setChatSessionArchived: {
				params: SetChatSessionArchivedInput;
				response: SetChatSessionArchivedOutput;
			};
			setChatSessionModel: {
				params: SetChatSessionModelInput;
				response: SetChatSessionModelOutput;
			};
			deleteChatSession: {
				params: DeleteChatSessionInput;
				response: DeleteChatSessionOutput;
			};
			sendChatMessage: {
				params: SendDesktopChatMessageInput;
				response: ChatSendAcceptedOutput;
			};
			cancelChatRun: {
				params: CancelDesktopChatRunInput;
				response: CancelChatRunOutput;
			};
			acknowledgeChatSessionInvalidation: {
				params: AcknowledgeChatSessionInvalidationInput;
				response: EmptyParams;
			};
			listApprovals: {
				params: ListApprovalsInput;
				response: ListApprovalsOutput;
			};
			getApproval: {
				params: GetApprovalInput;
				response: GetApprovalOutput;
			};
			decideApproval: {
				params: DecideApprovalInput;
				response: DecideApprovalOutput;
			};
			getSessionApprovalPolicy: {
				params: GetSessionApprovalPolicyInput;
				response: GetSessionApprovalPolicyOutput;
			};
			updateSessionApprovalPolicy: {
				params: UpdateSessionApprovalPolicyInput;
				response: UpdateSessionApprovalPolicyOutput;
			};
		};
		messages: EmptyRpcMap;
	}>;
	webview: RPCSchema<{
		requests: EmptyRpcMap;
		messages: {
			agentsReady: EmptyParams;
			chatEvent: ChatEventDelivery;
			chatSessionInvalidated: ChatSessionInvalidation;
			runtimeBoxesChanged: ListRuntimeBoxesOutput;
			approvalEvent: ApprovalEventDelivery;
			sessionApprovalPolicyChanged: SessionApprovalPolicyEvent;
			approvalActivityChanged: EmptyParams;
		};
	}>;
};
