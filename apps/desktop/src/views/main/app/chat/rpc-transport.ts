import type {
	CancelChatRunOutput,
	ChatRunEvent,
	ChatSendAcceptedOutput,
	ChatMessage as ContractChatMessage,
	CreateChatSessionOutput,
	CreateProviderInput,
	DeleteChatSessionOutput,
	DeleteProviderOutput,
	FetchProviderModelsOutput,
	GetChatSessionSnapshotOutput,
	GetDefaultModelOutput,
	ListAvailableModelsOutput,
	ListChatSessionsOutput,
	ListProvidersOutput,
	ProviderMutationOutput,
	SetChatSessionArchivedOutput,
	SetChatSessionModelInput,
	SetChatSessionModelOutput,
	SetDefaultModelInput,
	SetDefaultModelOutput,
	SetProviderModelsEnabledInput,
	SetProviderModelsEnabledOutput,
	TestProviderInput,
	TestProviderOutput,
	UpdateChatSessionOutput,
	UpdateProviderInput,
} from "@moshu/contracts";
import { AgentsUnavailableError, ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import {
	SessionRetirementCache,
	SessionRetirementCapacityError,
} from "../../../../shared/session-retirement-cache";
import type {
	AvailableModel,
	ChatMessage,
	ChatSession,
	ChatSessionInvalidation,
	ChatSessionInvalidationSubscriptionOptions,
	ChatSessionSummary,
	ChatTransport,
	ChatTransportEvent,
	ChatTransportListener,
	DefaultModelSelection,
	ProviderConnectionTestResult,
	ProviderSummary,
	SessionModelSelection,
} from "./transport";

export interface RpcChatClient {
	subscribeAgentsReady?(listener: () => void): () => void;
	listProviders(): Promise<ListProvidersOutput>;
	createProvider(input: CreateProviderInput): Promise<ProviderMutationOutput>;
	updateProvider(input: UpdateProviderInput): Promise<ProviderMutationOutput>;
	deleteProvider(providerId: string): Promise<DeleteProviderOutput>;
	testProvider(input: TestProviderInput): Promise<TestProviderOutput>;
	fetchProviderModels(providerId: string): Promise<FetchProviderModelsOutput>;
	setProviderModelsEnabled(
		input: SetProviderModelsEnabledInput,
	): Promise<SetProviderModelsEnabledOutput>;
	listAvailableModels(): Promise<ListAvailableModelsOutput>;
	getDefaultModel(): Promise<GetDefaultModelOutput>;
	setDefaultModel(input: SetDefaultModelInput): Promise<SetDefaultModelOutput>;
	setChatSessionModel(input: SetChatSessionModelInput): Promise<SetChatSessionModelOutput>;
	createChatSession(model?: SessionModelSelection): Promise<CreateChatSessionOutput>;
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
		async listProviders(): Promise<ProviderSummary[]> {
			return (await client.listProviders()).providers;
		},
		async createProvider(input: CreateProviderInput): Promise<ProviderSummary> {
			return (await client.createProvider(input)).provider;
		},
		async updateProvider(input: UpdateProviderInput): Promise<ProviderSummary> {
			return (await client.updateProvider(input)).provider;
		},
		async deleteProvider(providerId: string): Promise<void> {
			await client.deleteProvider(providerId);
		},
		async testProvider(input: TestProviderInput): Promise<ProviderConnectionTestResult> {
			const result = await client.testProvider(input);
			return {
				ok: result.ok,
				latencyMs: result.latencyMs,
				...(result.error === undefined ? {} : { errorMessage: result.error.safeMessage }),
			};
		},
		async fetchProviderModels(providerId: string): Promise<ProviderSummary> {
			return (await client.fetchProviderModels(providerId)).provider;
		},
		async setProviderModelsEnabled(
			providerId: string,
			enabledModelIds: string[],
		): Promise<ProviderSummary> {
			const output = await client.setProviderModelsEnabled({
				schemaVersion: 1,
				providerId,
				enabledModelIds,
			});
			return output.provider;
		},
		async listAvailableModels(): Promise<{
			models: AvailableModel[];
			defaultModel?: DefaultModelSelection;
		}> {
			const output = await client.listAvailableModels();
			return {
				models: output.models,
				...(output.defaultModel === undefined ? {} : { defaultModel: output.defaultModel }),
			};
		},
		async getDefaultModel(): Promise<DefaultModelSelection | undefined> {
			return (await client.getDefaultModel()).defaultModel;
		},
		async setDefaultModel(
			selection: DefaultModelSelection | null,
		): Promise<DefaultModelSelection | undefined> {
			const output = await client.setDefaultModel({ schemaVersion: 1, defaultModel: selection });
			return output.defaultModel;
		},
		async setSessionModel(
			sessionId: string,
			selection: SessionModelSelection | null,
		): Promise<SessionModelSelection | undefined> {
			const output = await client.setChatSessionModel({ sessionId, model: selection });
			return output.session.model;
		},
		async createSession(model?: SessionModelSelection) {
			const { session } = await client.createChatSession(model);
			return {
				id: session.id,
				title: session.title,
				updatedAt: session.updatedAt,
				...(session.model === undefined ? {} : { model: session.model }),
				askMode: "Ask",
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
			const session: ChatSession = {
				id: snapshot.session.id,
				title: snapshot.session.title,
				updatedAt: snapshot.session.updatedAt,
				...(snapshot.session.archivedAt === undefined
					? {}
					: { archivedAt: snapshot.session.archivedAt }),
				...(snapshot.session.model === undefined ? {} : { model: snapshot.session.model }),
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
