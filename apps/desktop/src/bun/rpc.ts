import {
	agentsRuntimeInfoSchema,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatProviderStatusSchema,
	chatSendAcceptedOutputSchema,
	configureChatProviderInputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	emptyParamsSchema,
	type GetChatSessionPageOutput,
	getChatSessionInputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	getChatSessionSnapshotOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	productRpcMethods,
	runtimeInfoSchema,
	sendAskChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	testChatProviderInputSchema,
	testChatProviderOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
} from "@moshu/contracts";
import { BrowserView, Updater } from "electrobun/bun";
import { traceChatRpcRequest } from "../shared/chat-rpc-diagnostics";
import {
	acknowledgeChatSessionInvalidationInputSchema,
	type DesktopRpc,
	type SendDesktopChatMessageInput,
} from "../shared/rpc";
import type { DesktopAgentsClient } from "./desktop-agents-client";

export interface DesktopRpcDependencies {
	agentsClient: DesktopAgentsClient;
}

export function createDesktopRpc({ agentsClient }: DesktopRpcDependencies) {
	return BrowserView.defineRPC<DesktopRpc>({
		maxRequestTime: 15_000,
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
						deepAgents: server.deepAgents,
					});
				},
				getChatProviderStatus: (params) =>
					agentsClient.request(
						productRpcMethods.providerStatus,
						params,
						emptyParamsSchema,
						chatProviderStatusSchema,
					),
				configureChatProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providerConfigure,
						params,
						configureChatProviderInputSchema,
						chatProviderStatusSchema,
					),
				testChatProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providerTest,
						params,
						testChatProviderInputSchema,
						testChatProviderOutputSchema,
					),
				deleteChatProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providerDelete,
						params,
						emptyParamsSchema,
						chatProviderStatusSchema,
					),
				createChatSession: (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "createChatSession",
						input: params,
						execute: () => agentsClient.createSession(),
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
