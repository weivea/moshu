import { probeAgentRuntime } from "@moshu/agent-runtime";
import {
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatProviderStatusSchema,
	chatSendAcceptedOutputSchema,
	configureChatProviderInputSchema,
	createChatSessionOutputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	emptyParamsSchema,
	getChatSessionInputSchema,
	getChatSessionSnapshotOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	runtimeInfoSchema,
	sendChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	testChatProviderInputSchema,
	testChatProviderOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
} from "@moshu/contracts";
import { BrowserView, Updater } from "electrobun/bun";
import { traceChatRpcRequest } from "../shared/chat-rpc-diagnostics";
import type { DesktopRpc, SendDesktopChatMessageInput } from "../shared/rpc";
import type { DesktopChatService } from "./chat-service";

const sendDesktopChatMessageInputSchema = sendChatMessageInputSchema.pick({
	sessionId: true,
	content: true,
});

export interface DesktopRpcDependencies {
	chatService: DesktopChatService;
}

export function createDesktopRpc({ chatService }: DesktopRpcDependencies) {
	return BrowserView.defineRPC<DesktopRpc>({
		maxRequestTime: 15_000,
		handlers: {
			requests: {
				getRuntimeInfo: async (params) => {
					emptyParamsSchema.parse(params);

					return runtimeInfoSchema.parse({
						apiVersion: 1,
						appName: "墨枢",
						appVersion: "0.0.1",
						channel: await Updater.localInfo.channel(),
						electrobunVersion: "1.18.1",
						bunVersion: Bun.version,
						platform: process.platform,
						arch: process.arch,
						deepAgents: probeAgentRuntime(),
					});
				},
				getChatProviderStatus: async (params) => {
					emptyParamsSchema.parse(params);
					return chatProviderStatusSchema.parse(chatService.getProviderStatus());
				},
				configureChatProvider: async (params) =>
					chatProviderStatusSchema.parse(
						chatService.configureProvider(configureChatProviderInputSchema.parse(params)),
					),
				testChatProvider: async (params) =>
					testChatProviderOutputSchema.parse(
						await chatService.testProvider(testChatProviderInputSchema.parse(params)),
					),
				deleteChatProvider: async (params) => {
					emptyParamsSchema.parse(params);
					return chatProviderStatusSchema.parse(chatService.deleteProvider());
				},
				createChatSession: async (params) => {
					return traceChatRpcRequest({
						side: "bun",
						operation: "createChatSession",
						input: params,
						execute: () => {
							emptyParamsSchema.parse(params);
							return createChatSessionOutputSchema.parse(chatService.createSession());
						},
					});
				},
				getChatSession: async (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "getChatSession",
						input: params,
						execute: () =>
							getChatSessionSnapshotOutputSchema.parse(
								chatService.getSessionSnapshot(getChatSessionInputSchema.parse(params)),
							),
					}),
				listChatSessions: async (params) =>
					listChatSessionsOutputSchema.parse(
						chatService.listSessions(listChatSessionsInputSchema.parse(params)),
					),
				updateChatSession: async (params) =>
					updateChatSessionOutputSchema.parse(
						chatService.updateSession(updateChatSessionInputSchema.parse(params)),
					),
				setChatSessionArchived: async (params) =>
					setChatSessionArchivedOutputSchema.parse(
						chatService.setSessionArchived(setChatSessionArchivedInputSchema.parse(params)),
					),
				deleteChatSession: async (params) =>
					deleteChatSessionOutputSchema.parse(
						chatService.deleteSession(deleteChatSessionInputSchema.parse(params)),
					),
				sendChatMessage: async (params: SendDesktopChatMessageInput) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "sendChatMessage",
						input: params,
						execute: () =>
							chatSendAcceptedOutputSchema.parse(
								chatService.sendMessage(sendDesktopChatMessageInputSchema.parse(params)),
							),
					}),
				cancelChatRun: async (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "cancelChatRun",
						input: params,
						execute: () =>
							cancelChatRunOutputSchema.parse(
								chatService.cancel(cancelChatRunInputSchema.parse(params)),
							),
					}),
			},
			messages: {},
		},
	});
}
