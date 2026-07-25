import type {
	CancelChatRunInput,
	CancelChatRunOutput,
	ChatProviderStatus,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ConfigureChatProviderInput,
	CreateChatSessionOutput,
	EmptyParams,
	GetChatSessionInput,
	GetChatSessionSnapshotOutput,
	RuntimeInfo,
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
			createChatSession: {
				params: EmptyParams;
				response: CreateChatSessionOutput;
			};
			getChatSession: {
				params: GetChatSessionInput;
				response: GetChatSessionSnapshotOutput;
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
