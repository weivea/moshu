import {
	type ChatRunEvent,
	type ConfigureChatProviderInput,
	cancelChatRunOutputSchema,
	chatProviderStatusSchema,
	chatRunEventSchema,
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
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	type TestChatProviderInput,
	testChatProviderInputSchema,
	testChatProviderOutputSchema,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import { logChatRpcDiagnostic, traceChatRpcRequest } from "../../../shared/chat-rpc-diagnostics";
import {
	type ChatSessionInvalidation,
	chatSessionInvalidationSchema,
	type DesktopRpc,
} from "../../../shared/rpc";
import { normalizeDesktopRpcError } from "../../../shared/rpc-errors";
import { ChatSessionInvalidationBridge } from "./session-invalidation-bridge";

const invalidationListenerTimeoutMs = 10_000;
const maxPendingChatSessionInvalidations = 256;
const chatEventListeners = new Set<(event: ChatRunEvent) => void>();
const agentsReadyListeners = new Set<() => void>();
const chatSessionInvalidationBridge = new ChatSessionInvalidationBridge({
	timeoutMs: invalidationListenerTimeoutMs,
	maxPending: maxPendingChatSessionInvalidations,
});
const rpc = Electroview.defineRPC<DesktopRpc>({
	maxRequestTime: 15_000,
	handlers: {
		requests: {},
		messages: {
			agentsReady: (payload) => {
				emptyParamsSchema.parse(payload);
				for (const listener of [...agentsReadyListeners]) {
					listener();
				}
			},
			chatEvent: (payload) => {
				const event = chatRunEventSchema.parse(payload);
				logChatRpcDiagnostic("web", "receive", "chatEvent", event);
				for (const listener of chatEventListeners) {
					listener(event);
				}
			},
			chatSessionInvalidated: (payload) => {
				const invalidation = chatSessionInvalidationSchema.parse(payload);
				void acknowledgeChatSessionInvalidation(invalidation);
			},
		},
	},
});

const electroview = "__electrobun" in window ? new Electrobun.Electroview({ rpc }) : undefined;

if (electroview !== undefined && !electroview.rpc) {
	throw new Error("Electrobun RPC was not initialized.");
}

function getRequest() {
	if (!electroview?.rpc) {
		throw new Error("Electrobun RPC is unavailable outside the desktop runtime.");
	}
	return electroview.rpc.request;
}

export const desktopClient = {
	subscribeAgentsReady(listener: () => void) {
		agentsReadyListeners.add(listener);
		return () => {
			agentsReadyListeners.delete(listener);
		};
	},
	async getRuntimeInfo() {
		return runtimeInfoSchema.parse(await requestDesktop(() => getRequest().getRuntimeInfo({})));
	},
	async getChatProviderStatus() {
		return chatProviderStatusSchema.parse(
			await requestDesktop(() => getRequest().getChatProviderStatus({})),
		);
	},
	async configureChatProvider(input: ConfigureChatProviderInput) {
		const parsedInput = configureChatProviderInputSchema.parse(input);
		return chatProviderStatusSchema.parse(
			await requestDesktop(() => getRequest().configureChatProvider(parsedInput)),
		);
	},
	async testChatProvider(input: TestChatProviderInput) {
		const parsedInput = testChatProviderInputSchema.parse(input);
		return testChatProviderOutputSchema.parse(
			await requestDesktop(() => getRequest().testChatProvider(parsedInput)),
		);
	},
	async deleteChatProvider() {
		return chatProviderStatusSchema.parse(
			await requestDesktop(() => getRequest().deleteChatProvider({})),
		);
	},
	async createChatSession() {
		return traceChatRpcRequest({
			side: "web",
			operation: "createChatSession",
			input: {},
			execute: async () =>
				createChatSessionOutputSchema.parse(
					await requestDesktop(() => getRequest().createChatSession({})),
				),
		});
	},
	async getChatSession(sessionId: string) {
		const input = getChatSessionInputSchema.parse({ sessionId });
		return traceChatRpcRequest({
			side: "web",
			operation: "getChatSession",
			input,
			execute: async () =>
				getChatSessionSnapshotOutputSchema.parse(
					await requestDesktop(() => getRequest().getChatSession(input)),
				),
		});
	},
	async listChatSessions(input: { query?: string; archived?: boolean; limit?: number } = {}) {
		const parsedInput = listChatSessionsInputSchema.parse(input);
		return listChatSessionsOutputSchema.parse(
			await requestDesktop(() => getRequest().listChatSessions(parsedInput)),
		);
	},
	async updateChatSession(sessionId: string, title: string) {
		const input = updateChatSessionInputSchema.parse({ sessionId, title });
		return updateChatSessionOutputSchema.parse(
			await requestDesktop(() => getRequest().updateChatSession(input)),
		);
	},
	async setChatSessionArchived(sessionId: string, archived: boolean) {
		const input = setChatSessionArchivedInputSchema.parse({
			sessionId,
			archived,
		});
		return setChatSessionArchivedOutputSchema.parse(
			await requestDesktop(() => getRequest().setChatSessionArchived(input)),
		);
	},
	async deleteChatSession(sessionId: string) {
		const input = deleteChatSessionInputSchema.parse({ sessionId });
		return deleteChatSessionOutputSchema.parse(
			await requestDesktop(() => getRequest().deleteChatSession(input)),
		);
	},
	async sendChatMessage(input: { requestId?: string; sessionId: string; content: string }) {
		return traceChatRpcRequest({
			side: "web",
			operation: "sendChatMessage",
			input,
			execute: async () =>
				chatSendAcceptedOutputSchema.parse(
					await requestDesktop(() => getRequest().sendChatMessage(input)),
				),
		});
	},
	async cancelChatRun(sessionId: string, runId: string, reason?: string) {
		const input = {
			sessionId: uuidV7Schema.parse(sessionId),
			runId,
			reason,
		};
		return traceChatRpcRequest({
			side: "web",
			operation: "cancelChatRun",
			input,
			execute: async () =>
				cancelChatRunOutputSchema.parse(
					await requestDesktop(() =>
						getRequest().cancelChatRun({
							sessionId: input.sessionId,
							runId,
							reason,
						}),
					),
				),
		});
	},
	subscribeChatEvents(listener: (event: ChatRunEvent) => void) {
		chatEventListeners.add(listener);
		return () => {
			chatEventListeners.delete(listener);
		};
	},
	subscribeChatSessionInvalidations(
		listener: (invalidation: ChatSessionInvalidation) => void | PromiseLike<void>,
		options: { authoritative?: boolean } = {},
	) {
		return chatSessionInvalidationBridge.subscribe(listener, options);
	},
};

async function acknowledgeChatSessionInvalidation(
	invalidation: ChatSessionInvalidation,
): Promise<void> {
	const accepted = await chatSessionInvalidationBridge.handle(invalidation);
	try {
		await getRequest().acknowledgeChatSessionInvalidation({
			schemaVersion: 1,
			invalidationId: invalidation.invalidationId,
			sessionId: invalidation.sessionId,
			accepted,
		});
	} catch (error) {
		console.error("Failed to acknowledge a chat Session invalidation.", error);
	}
}

async function requestDesktop<T>(execute: () => Promise<T>): Promise<T> {
	try {
		return await execute();
	} catch (error) {
		throw normalizeDesktopRpcError(error);
	}
}

window.addEventListener("beforeunload", () => {
	chatSessionInvalidationBridge.shutdown();
});
