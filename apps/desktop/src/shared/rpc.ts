import {
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatProviderStatus,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type ConfigureChatProviderInput,
	type CreateChatSessionOutput,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	type EmptyParams,
	type GetChatSessionInput,
	type GetChatSessionSnapshotOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type RuntimeInfo,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type TestChatProviderInput,
	type TestChatProviderOutput,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	uuidV7Schema,
} from "@moshu/contracts";
import type { RPCSchema } from "electrobun/bun";
import { z } from "zod";

type EmptyRpcMap = Record<never, never>;

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
			getChatProviderStatus: {
				params: EmptyParams;
				response: ChatProviderStatus;
			};
			configureChatProvider: {
				params: ConfigureChatProviderInput;
				response: ChatProviderStatus;
			};
			testChatProvider: {
				params: TestChatProviderInput;
				response: TestChatProviderOutput;
			};
			deleteChatProvider: {
				params: EmptyParams;
				response: ChatProviderStatus;
			};
			createChatSession: {
				params: EmptyParams;
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
