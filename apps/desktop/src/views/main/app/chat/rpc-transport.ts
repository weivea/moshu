import type {
	CancelChatRunOutput,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ChatMessage as ContractChatMessage,
	ChatProviderStatus as ContractChatProviderStatus,
	CreateChatSessionOutput,
	DeleteChatSessionOutput,
	GetChatSessionSnapshotOutput,
	ListChatSessionsOutput,
	SetChatSessionArchivedOutput,
	TestChatProviderOutput,
	UpdateChatSessionOutput,
} from "@moshu/contracts";
import { AgentsUnavailableError, ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import {
	SessionRetirementCache,
	SessionRetirementCapacityError,
} from "../../../../shared/session-retirement-cache";
import type {
	ChatMessage,
	ChatProviderConfiguration,
	ChatProviderConnectionTestResult,
	ChatProviderStatus,
	ChatSession,
	ChatSessionInvalidation,
	ChatSessionInvalidationSubscriptionOptions,
	ChatSessionSummary,
	ChatTransport,
	ChatTransportEvent,
	ChatTransportListener,
} from "./transport";

export interface RpcChatClient {
	subscribeAgentsReady?(listener: () => void): () => void;
	getChatProviderStatus(): Promise<ContractChatProviderStatus>;
	configureChatProvider(input: {
		schemaVersion: 1;
		baseUrl: string;
		model: string;
		apiKey?: string;
	}): Promise<ContractChatProviderStatus>;
	testChatProvider(input: {
		schemaVersion: 1;
		baseUrl: string;
		model: string;
		apiKey?: string;
	}): Promise<TestChatProviderOutput>;
	deleteChatProvider(): Promise<ContractChatProviderStatus>;
	createChatSession(): Promise<CreateChatSessionOutput>;
	getChatSession(sessionId: string): Promise<GetChatSessionSnapshotOutput>;
	listChatSessions(input?: {
		query?: string;
		archived?: boolean;
		limit?: number;
	}): Promise<ListChatSessionsOutput>;
	updateChatSession(sessionId: string, title: string): Promise<UpdateChatSessionOutput>;
	setChatSessionArchived(
		sessionId: string,
		archived: boolean,
	): Promise<SetChatSessionArchivedOutput>;
	deleteChatSession(sessionId: string): Promise<DeleteChatSessionOutput>;
	sendChatMessage(input: {
		requestId: string;
		sessionId: string;
		content: string;
	}): Promise<ChatSendAcceptedOutput>;
	cancelChatRun(sessionId: string, runId: string, reason?: string): Promise<CancelChatRunOutput>;
	subscribeChatEvents(listener: (event: ChatRunEvent) => void): () => void;
	subscribeChatSessionInvalidations?(
		listener: (invalidation: ChatSessionInvalidation) => void | PromiseLike<void>,
		options?: ChatSessionInvalidationSubscriptionOptions,
	): () => void;
}

interface ActiveRequest {
	sessionId: string;
	messageId: string;
}

export function createRpcChatTransport(
	client: RpcChatClient,
	options: { now?: () => number } = {},
): ChatTransport {
	const listeners = new Set<ChatTransportListener>();
	const activeRequests = new Map<string, ActiveRequest>();
	const retiredSessions = new SessionRetirementCache<undefined>({ now: options.now });
	let backpressuredRetirementSessionId: string | undefined;
	let providerStatus: ChatProviderStatus | undefined;
	const assertSessionSnapshotAllowed = (sessionId: string): void => {
		if (backpressuredRetirementSessionId !== undefined) {
			throw new AgentsUnavailableError("The renderer retirement cache is at capacity.");
		}
		if (retiredSessions.has(sessionId)) {
			throw new ChatSessionNotFoundError();
		}
	};

	client.subscribeChatEvents((event) => {
		if (backpressuredRetirementSessionId !== undefined || retiredSessions.has(event.sessionId)) {
			return;
		}
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
					...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
				}),
			);
			return providerStatus;
		},
		async testProvider(
			input: ChatProviderConfiguration,
		): Promise<ChatProviderConnectionTestResult> {
			const result = await client.testChatProvider({
				schemaVersion: 1,
				baseUrl: input.endpoint,
				model: input.model,
				...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
			});
			return {
				ok: result.ok,
				latencyMs: result.latencyMs,
				...(result.error === undefined ? {} : { errorMessage: result.error.safeMessage }),
			};
		},
		async deleteProvider() {
			providerStatus = mapProviderStatus(await client.deleteChatProvider());
			return providerStatus;
		},
		async createSession() {
			const { session } = await client.createChatSession();
			const status = providerStatus ?? mapProviderStatus(await client.getChatProviderStatus());
			return {
				id: session.id,
				title: session.title,
				updatedAt: session.updatedAt,
				model: status.model,
				askMode: status.askMode,
				messages: [],
			};
		},
		async getSession(sessionId: string) {
			assertSessionSnapshotAllowed(sessionId);
			const snapshot = await client.getChatSession(sessionId);
			assertSessionSnapshotAllowed(sessionId);
			const activeRun = snapshot.runs.find(
				(run) => run.status === "queued" || run.status === "running" || run.status === "cancelling",
			);
			const latestRun = snapshot.runs[0];
			const session: ChatSession = {
				id: snapshot.session.id,
				title: snapshot.session.title,
				updatedAt: snapshot.session.updatedAt,
				...(snapshot.session.archivedAt === undefined
					? {}
					: { archivedAt: snapshot.session.archivedAt }),
				model: latestRun?.provider.model ?? providerStatus?.model ?? "",
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
		async listSessions(input = {}) {
			const output = await client.listChatSessions(input);
			return output.items.map(mapSessionSummary);
		},
		async renameSession(sessionId: string, title: string) {
			const output = await client.updateChatSession(sessionId, title);
			return mapSessionSummary(output.session);
		},
		async setSessionArchived(sessionId: string, archived: boolean) {
			const output = await client.setChatSessionArchived(sessionId, archived);
			return mapSessionSummary(output.session);
		},
		async deleteSession(sessionId: string) {
			await client.deleteChatSession(sessionId);
		},
		async send(input: { requestId: string; sessionId: string; message: string }) {
			const accepted = await client.sendChatMessage({
				requestId: input.requestId,
				sessionId: input.sessionId,
				content: input.message,
			});
			if (accepted.assistantMessage.status === "streaming") {
				activeRequests.set(accepted.run.id, {
					sessionId: input.sessionId,
					messageId: accepted.assistantMessage.id,
				});
			}

			return {
				requestId: accepted.run.id,
				userMessage: mapMessage(accepted.userMessage),
				assistantMessage: mapMessage(accepted.assistantMessage),
			};
		},
		async cancel(input: { sessionId: string; requestId: string }) {
			await client.cancelChatRun(input.sessionId, input.requestId, "User stopped the response.");
		},
		retireSession(sessionId: string) {
			if (
				backpressuredRetirementSessionId !== undefined &&
				backpressuredRetirementSessionId !== sessionId
			) {
				throw new SessionRetirementCapacityError();
			}
			try {
				retiredSessions.remember(sessionId, undefined);
				backpressuredRetirementSessionId = undefined;
			} catch (error) {
				if (error instanceof SessionRetirementCapacityError) {
					backpressuredRetirementSessionId = sessionId;
				}
				throw error;
			}
			for (const [requestId, request] of activeRequests) {
				if (request.sessionId === sessionId) {
					activeRequests.delete(requestId);
				}
			}
		},
		subscribe(listener: ChatTransportListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		subscribeAgentsReady(listener) {
			return client.subscribeAgentsReady?.(listener) ?? (() => undefined);
		},
		subscribeSessionInvalidations(listener, options) {
			return client.subscribeChatSessionInvalidations?.(listener, options) ?? (() => undefined);
		},
	};
}

function mapProviderStatus(status: ContractChatProviderStatus): ChatProviderStatus {
	return {
		configured: status.configured,
		endpoint: status.baseUrl,
		model: status.model,
		askMode: "Ask",
		...(status.apiKeyMask === undefined ? {} : { apiKeyMask: status.apiKeyMask }),
	};
}

function mapSessionSummary(session: ListChatSessionsOutput["items"][number]): ChatSessionSummary {
	return {
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
		...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
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
