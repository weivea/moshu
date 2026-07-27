import {
	agentsRuntimeInfoSchema,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatSendAcceptedOutputSchema,
	createProviderInputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	deleteProviderInputSchema,
	deleteProviderOutputSchema,
	emptyParamsSchema,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	type GetChatSessionPageOutput,
	getChatSessionInputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	getChatSessionSnapshotOutputSchema,
	getDefaultModelOutputSchema,
	listAvailableModelsOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	listProvidersOutputSchema,
	productRpcMethods,
	providerMutationOutputSchema,
	runtimeInfoSchema,
	sendAskChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	setChatSessionModelInputSchema,
	setChatSessionModelOutputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
	testProviderInputSchema,
	testProviderOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	updateProviderInputSchema,
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
				listProviders: (params) =>
					agentsClient.request(
						productRpcMethods.providersList,
						params,
						emptyParamsSchema,
						listProvidersOutputSchema,
					),
				createProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersCreate,
						params,
						createProviderInputSchema,
						providerMutationOutputSchema,
					),
				updateProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersUpdate,
						params,
						updateProviderInputSchema,
						providerMutationOutputSchema,
					),
				deleteProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersDelete,
						params,
						deleteProviderInputSchema,
						deleteProviderOutputSchema,
					),
				testProvider: (params) =>
					agentsClient.request(
						productRpcMethods.providersTest,
						params,
						testProviderInputSchema,
						testProviderOutputSchema,
					),
				fetchProviderModels: (params) =>
					agentsClient.request(
						productRpcMethods.providersFetchModels,
						params,
						fetchProviderModelsInputSchema,
						fetchProviderModelsOutputSchema,
					),
				setProviderModelsEnabled: (params) =>
					agentsClient.request(
						productRpcMethods.providersSetModelsEnabled,
						params,
						setProviderModelsEnabledInputSchema,
						setProviderModelsEnabledOutputSchema,
					),
				listAvailableModels: (params) =>
					agentsClient.request(
						productRpcMethods.modelsListAvailable,
						params,
						emptyParamsSchema,
						listAvailableModelsOutputSchema,
					),
				getDefaultModel: (params) =>
					agentsClient.request(
						productRpcMethods.defaultModelGet,
						params,
						emptyParamsSchema,
						getDefaultModelOutputSchema,
					),
				setDefaultModel: (params) =>
					agentsClient.request(
						productRpcMethods.defaultModelSet,
						params,
						setDefaultModelInputSchema,
						setDefaultModelOutputSchema,
					),
				createChatSession: (params) =>
					traceChatRpcRequest({
						side: "bun",
						operation: "createChatSession",
						input: params,
						execute: () => agentsClient.createSession(undefined, params.model),
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
				setChatSessionModel: (params) =>
					agentsClient.request(
						productRpcMethods.sessionSetModel,
						params,
						setChatSessionModelInputSchema,
						setChatSessionModelOutputSchema,
						params.sessionId,
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
