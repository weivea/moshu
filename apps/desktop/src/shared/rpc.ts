import {
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type CreateChatSessionOutput,
	type CreateProviderInput,
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
	type ListAvailableModelsOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type ListProvidersOutput,
	type ProviderMutationOutput,
	type RuntimeInfo,
	type SessionModelSelection,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type SetChatSessionModelInput,
	type SetChatSessionModelOutput,
	type SetDefaultModelInput,
	type SetDefaultModelOutput,
	type SetProviderModelsEnabledInput,
	type SetProviderModelsEnabledOutput,
	type TestProviderInput,
	type TestProviderOutput,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	type UpdateProviderInput,
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

export type DesktopRpc = {
	bun: RPCSchema<{
		requests: {
			getRuntimeInfo: {
				params: EmptyParams;
				response: RuntimeInfo;
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
		};
	}>;
};
