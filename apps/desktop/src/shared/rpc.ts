import {
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type CreateChatSessionOutput,
	type CreateProviderInput,
	type CreateProjectInput,
	type CreateProjectOutput,
	type DeleteProjectInput,
	type DeleteProjectOutput,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	type DeleteProviderInput,
	type DeleteProviderOutput,
	type EmptyParams,
	type FetchProviderModelsInput,
	type FetchProviderModelsOutput,
	type GetChatSessionInput,
	type GetChatSessionSnapshotOutput,
	type GetDefaultModelOutput,
	type GetProjectInput,
	type GetProjectOutput,
	type ListAvailableModelsOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type ListProvidersOutput,
	type ListProjectsInput,
	type ListProjectsOutput,
	type ListRuntimeBoxPairingClaimsOutput,
	type ListRuntimeBoxesOutput,
	type CreateRuntimeBoxPairingOutput,
	type ApproveRuntimeBoxPairingInput,
	type ApproveRuntimeBoxPairingOutput,
	type RejectRuntimeBoxPairingInput,
	type RejectRuntimeBoxPairingOutput,
	type RevokeRuntimeBoxDeviceInput,
	type RevokeRuntimeBoxDeviceOutput,
	type RemoteAccessAuthAttempt,
	type RemoteAccessMutationOutput,
	type RemoteAccessStatusOutput,
	type ProviderMutationOutput,
	type ProviderAuthAttemptOutput,
	type RespondProviderAuthInput,
	type RuntimeInfo,
	type StartProviderAuthInput,
	type SessionModelSelection,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type SetChatSessionModelInput,
	type SetChatSessionModelOutput,
	type SetDefaultModelInput,
	type SetDefaultModelOutput,
	type SetProviderModelsEnabledInput,
	type SetProviderModelsEnabledOutput,
	type SetProjectArchivedInput,
	type SetProjectArchivedOutput,
	type TestProviderInput,
	type TestProviderOutput,
	type SwitchRuntimeBoxInput,
	type SwitchRuntimeBoxOutput,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	type UpdateProviderInput,
	type UpdateProjectInput,
	type UpdateProjectOutput,
	uuidV7Schema,
} from "@moshu/contracts";
import type { RPCSchema } from "electrobun/bun";
import { z } from "zod";

type EmptyRpcMap = Record<never, never>;

export interface CreateDesktopChatSessionInput {
	model?: SessionModelSelection;
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
			createProject: {
				params: CreateProjectInput;
				response: CreateProjectOutput;
			};
			listProjects: {
				params: ListProjectsInput;
				response: ListProjectsOutput;
			};
			getProject: {
				params: GetProjectInput;
				response: GetProjectOutput;
			};
			updateProject: {
				params: UpdateProjectInput;
				response: UpdateProjectOutput;
			};
			setProjectArchived: {
				params: SetProjectArchivedInput;
				response: SetProjectArchivedOutput;
			};
			deleteProject: {
				params: DeleteProjectInput;
				response: DeleteProjectOutput;
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
		};
		messages: EmptyRpcMap;
	}>;
	webview: RPCSchema<{
		requests: EmptyRpcMap;
		messages: {
			agentsReady: EmptyParams;
			chatEvent: ChatRunEvent;
			chatSessionInvalidated: ChatSessionInvalidation;
			runtimeBoxesChanged: ListRuntimeBoxesOutput;
		};
	}>;
};
