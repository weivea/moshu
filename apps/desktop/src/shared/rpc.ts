import type {
	CancelChatRunInput,
	CancelChatRunOutput,
	ChatProviderStatus,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ConfigureChatProviderInput,
	CreateChatSessionOutput,
	DeleteChatSessionInput,
	DeleteChatSessionOutput,
	EmptyParams,
	GetChatSessionInput,
	GetChatSessionSnapshotOutput,
	ListChatSessionsInput,
	ListChatSessionsOutput,
	RuntimeInfo,
	SetChatSessionArchivedInput,
	SetChatSessionArchivedOutput,
	TestChatProviderInput,
	TestChatProviderOutput,
	UpdateChatSessionInput,
	UpdateChatSessionOutput,
} from "@moshu/contracts";
import type { RPCSchema } from "electrobun/bun";

type EmptyRpcMap = Record<never, never>;

export interface SendDesktopChatMessageInput {
	sessionId: string;
	content: string;
}

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
				params: CancelChatRunInput;
				response: CancelChatRunOutput;
			};
		};
		messages: EmptyRpcMap;
	}>;
	webview: RPCSchema<{
		requests: EmptyRpcMap;
		messages: {
			chatEvent: ChatRunEvent;
		};
	}>;
};
