import {
	cancelChatRunOutputSchema,
	chatProviderStatusSchema,
	chatRunEventSchema,
	chatSendAcceptedOutputSchema,
	configureChatProviderInputSchema,
	createChatSessionOutputSchema,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	getChatSessionInputSchema,
	getChatSessionSnapshotOutputSchema,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	runtimeInfoSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	testChatProviderInputSchema,
	testChatProviderOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	type ChatRunEvent,
	type ConfigureChatProviderInput,
	type TestChatProviderInput,
} from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import { logChatRpcDiagnostic, traceChatRpcRequest } from "../../../shared/chat-rpc-diagnostics";
import type { DesktopRpc } from "../../../shared/rpc";

const chatEventListeners = new Set<(event: ChatRunEvent) => void>();

const rpc = Electroview.defineRPC<DesktopRpc>({
	maxRequestTime: 15_000,
	handlers: {
		requests: {},
		messages: {
			chatEvent: (payload) => {
				const event = chatRunEventSchema.parse(payload);
				logChatRpcDiagnostic("web", "receive", "chatEvent", event);
				for (const listener of chatEventListeners) {
					listener(event);
				}
			},
		},
	},
});

const electroview = new Electrobun.Electroview({ rpc });

if (!electroview.rpc) {
	throw new Error("Electrobun RPC was not initialized.");
}

const request = electroview.rpc.request;

export const desktopClient = {
	async getRuntimeInfo() {
		return runtimeInfoSchema.parse(await request.getRuntimeInfo({}));
	},
	async getChatProviderStatus() {
		return chatProviderStatusSchema.parse(await request.getChatProviderStatus({}));
	},
	async configureChatProvider(input: ConfigureChatProviderInput) {
		const parsedInput = configureChatProviderInputSchema.parse(input);
		return chatProviderStatusSchema.parse(await request.configureChatProvider(parsedInput));
	},
	async testChatProvider(input: TestChatProviderInput) {
		const parsedInput = testChatProviderInputSchema.parse(input);
		return testChatProviderOutputSchema.parse(await request.testChatProvider(parsedInput));
	},
	async deleteChatProvider() {
		return chatProviderStatusSchema.parse(await request.deleteChatProvider({}));
	},
	async createChatSession() {
		return traceChatRpcRequest({
			side: "web",
			operation: "createChatSession",
			input: {},
			execute: async () => createChatSessionOutputSchema.parse(await request.createChatSession({})),
		});
	},
	async getChatSession(sessionId: string) {
		const input = getChatSessionInputSchema.parse({ sessionId });
		return traceChatRpcRequest({
			side: "web",
			operation: "getChatSession",
			input,
			execute: async () =>
				getChatSessionSnapshotOutputSchema.parse(await request.getChatSession(input)),
		});
	},
	async listChatSessions(input: { query?: string; archived?: boolean; limit?: number } = {}) {
		const parsedInput = listChatSessionsInputSchema.parse(input);
		return listChatSessionsOutputSchema.parse(await request.listChatSessions(parsedInput));
	},
	async updateChatSession(sessionId: string, title: string) {
		const input = updateChatSessionInputSchema.parse({ sessionId, title });
		return updateChatSessionOutputSchema.parse(await request.updateChatSession(input));
	},
	async setChatSessionArchived(sessionId: string, archived: boolean) {
		const input = setChatSessionArchivedInputSchema.parse({
			sessionId,
			archived,
		});
		return setChatSessionArchivedOutputSchema.parse(await request.setChatSessionArchived(input));
	},
	async deleteChatSession(sessionId: string) {
		const input = deleteChatSessionInputSchema.parse({ sessionId });
		return deleteChatSessionOutputSchema.parse(await request.deleteChatSession(input));
	},
	async sendChatMessage(input: { sessionId: string; content: string }) {
		return traceChatRpcRequest({
			side: "web",
			operation: "sendChatMessage",
			input,
			execute: async () => chatSendAcceptedOutputSchema.parse(await request.sendChatMessage(input)),
		});
	},
	async cancelChatRun(runId: string, reason?: string) {
		const input = {
			runId,
			reason,
		};
		return traceChatRpcRequest({
			side: "web",
			operation: "cancelChatRun",
			input,
			execute: async () =>
				cancelChatRunOutputSchema.parse(
					await request.cancelChatRun({
						runId,
						reason,
					}),
				),
		});
	},
	subscribeChatEvents(listener: (event: ChatRunEvent) => void) {
		chatEventListeners.add(listener);
		return () => {
			chatEventListeners.delete(listener);
		};
	},
};
