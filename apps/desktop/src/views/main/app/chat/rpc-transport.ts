import type {
	CancelChatRunOutput,
	ChatMessage as ContractChatMessage,
	ChatProviderStatus as ContractChatProviderStatus,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	CreateChatSessionOutput,
	GetChatSessionSnapshotOutput,
} from "@moshu/contracts";

import type {
	ChatMessage,
	ChatProviderConfiguration,
	ChatProviderStatus,
	ChatSession,
	ChatTransport,
	ChatTransportEvent,
	ChatTransportListener,
} from "./transport";

export interface RpcChatClient {
	getChatProviderStatus(): Promise<ContractChatProviderStatus>;
	configureChatProvider(input: {
		schemaVersion: 1;
		baseUrl: string;
		model: string;
		apiKey: string;
	}): Promise<ContractChatProviderStatus>;
	createChatSession(): Promise<CreateChatSessionOutput>;
	getChatSession(sessionId: string): Promise<GetChatSessionSnapshotOutput>;
	sendChatMessage(input: { sessionId: string; content: string }): Promise<ChatSendAcceptedOutput>;
	cancelChatRun(runId: string, reason?: string): Promise<CancelChatRunOutput>;
	subscribeChatEvents(listener: (event: ChatRunEvent) => void): () => void;
}

interface ActiveRequest {
	sessionId: string;
	messageId: string;
}

export function createRpcChatTransport(client: RpcChatClient): ChatTransport {
	const listeners = new Set<ChatTransportListener>();
	const activeRequests = new Map<string, ActiveRequest>();
	let providerStatus: ChatProviderStatus | undefined;

	client.subscribeChatEvents((event) => {
		const mappedEvent = mapRunEvent(event, activeRequests);
		if (mappedEvent === undefined) {
			return;
		}

		if (
			mappedEvent.type === "response.completed" ||
			mappedEvent.type === "response.cancelled" ||
			mappedEvent.type === "response.error"
		) {
			activeRequests.delete(mappedEvent.requestId);
		}

		for (const listener of listeners) {
			listener(mappedEvent);
		}
	});

	return {
		async getProviderStatus() {
			providerStatus = mapProviderStatus(await client.getChatProviderStatus());
			return providerStatus;
		},
		async configureProvider(input: ChatProviderConfiguration) {
			providerStatus = mapProviderStatus(
				await client.configureChatProvider({
					schemaVersion: 1,
					baseUrl: input.endpoint,
					model: input.model,
					apiKey: input.apiKey,
				}),
			);
			return providerStatus;
		},
		async createSession() {
			const { session } = await client.createChatSession();
			const status = providerStatus ?? mapProviderStatus(await client.getChatProviderStatus());
			return {
				id: session.id,
				model: status.model,
				askMode: status.askMode,
				messages: [],
			};
		},
		async getSession(sessionId: string) {
			const snapshot = await client.getChatSession(sessionId);
			const fallbackStatus =
				providerStatus ?? mapProviderStatus(await client.getChatProviderStatus());
			const activeRun = snapshot.runs.find(
				(run) => run.status === "queued" || run.status === "running" || run.status === "cancelling",
			);
			const latestRun = snapshot.runs[0];
			const session: ChatSession = {
				id: snapshot.session.id,
				model: latestRun?.provider.model ?? fallbackStatus.model,
				askMode: "Ask",
				messages: snapshot.messages.map(mapMessage),
				eventCursors: Object.fromEntries(
					snapshot.eventCursors.map((cursor) => [cursor.runId, cursor.lastSeq]),
				),
			};

			if (activeRun?.assistantMessageId !== undefined) {
				session.activeResponse = {
					requestId: activeRun.id,
					messageId: activeRun.assistantMessageId,
				};
				activeRequests.set(activeRun.id, {
					sessionId: snapshot.session.id,
					messageId: activeRun.assistantMessageId,
				});
			}

			return session;
		},
		async send(input: { sessionId: string; message: string }) {
			const accepted = await client.sendChatMessage({
				sessionId: input.sessionId,
				content: input.message,
			});
			activeRequests.set(accepted.run.id, {
				sessionId: input.sessionId,
				messageId: accepted.assistantMessage.id,
			});

			return {
				requestId: accepted.run.id,
				userMessage: mapMessage(accepted.userMessage),
				assistantMessage: mapMessage(accepted.assistantMessage),
			};
		},
		async cancel(input: { sessionId: string; requestId: string }) {
			await client.cancelChatRun(input.requestId, "User stopped the response.");
		},
		subscribe(listener: ChatTransportListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

function mapProviderStatus(status: ContractChatProviderStatus): ChatProviderStatus {
	return {
		configured: status.configured,
		endpoint: status.baseUrl,
		model: status.model,
		askMode: "Ask",
	};
}

function mapMessage(message: ContractChatMessage): ChatMessage {
	const mapped: ChatMessage = {
		id: message.id,
		role: message.role,
		content: message.content,
		createdAt: message.createdAt,
		status:
			message.status === "complete"
				? "completed"
				: message.status === "failed"
					? "error"
					: message.status,
	};

	if (message.status === "failed") {
		mapped.errorMessage = message.error.safeMessage;
	}

	return mapped;
}

function mapRunEvent(
	event: ChatRunEvent,
	activeRequests: Map<string, ActiveRequest>,
): ChatTransportEvent | undefined {
	if (event.type === "message.delta") {
		return {
			type: "response.delta",
			sessionId: event.sessionId,
			requestId: event.runId,
			messageId: event.payload.messageId,
			delta: event.payload.delta,
			sequence: event.seq,
		};
	}

	if (event.type === "message.completed") {
		if (event.payload.status === "complete") {
			return {
				type: "response.completed",
				sessionId: event.sessionId,
				requestId: event.runId,
				messageId: event.payload.messageId,
				content: event.payload.content,
				sequence: event.seq,
			};
		}
		if (event.payload.status === "cancelled") {
			return {
				type: "response.cancelled",
				sessionId: event.sessionId,
				requestId: event.runId,
				messageId: event.payload.messageId,
				content: event.payload.content,
				sequence: event.seq,
			};
		}
		return {
			type: "response.error",
			sessionId: event.sessionId,
			requestId: event.runId,
			messageId: event.payload.messageId,
			content: event.payload.content,
			message: event.payload.error.safeMessage,
			sequence: event.seq,
		};
	}

	if (event.type === "run.status" && event.payload.status === "cancelled") {
		const activeRequest = activeRequests.get(event.runId);
		if (activeRequest !== undefined) {
			return {
				type: "response.cancelled",
				sessionId: activeRequest.sessionId,
				requestId: event.runId,
				messageId: activeRequest.messageId,
				sequence: event.seq,
			};
		}
	}

	return undefined;
}
