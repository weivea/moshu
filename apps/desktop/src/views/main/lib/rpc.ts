import {
	cancelChatRunOutputSchema,
	chatProviderStatusSchema,
	chatRunEventSchema,
	chatSendAcceptedOutputSchema,
	configureChatProviderInputSchema,
	createChatSessionOutputSchema,
	getChatSessionInputSchema,
	getChatSessionSnapshotOutputSchema,
	runtimeInfoSchema,
	type ChatRunEvent,
	type ConfigureChatProviderInput,
} from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import { logChatRpcDiagnostic, traceChatRpcRequest } from "../../../shared/chat-rpc-diagnostics";
import type { DesktopRpc } from "../../../shared/rpc";

const chatEventListeners = new Set<(event: ChatRunEvent) => void>();

const rpc = Electroview.defineRPC<DesktopRpc>({
	maxRequestTime: 5000,
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
