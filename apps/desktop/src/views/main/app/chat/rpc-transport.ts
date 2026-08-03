import type {
	CancelChatRunOutput,
	ChatSendAcceptedOutput,
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
	ProviderAuthAttemptOutput,
	ProviderAuthType,
	ProviderMutationOutput,
	RespondProviderAuthInput,
	SessionListScope,
	SetChatSessionArchivedOutput,
	SetChatSessionModelInput,
	SetChatSessionModelOutput,
	SetDefaultModelInput,
	SetDefaultModelOutput,
	SetProviderModelsEnabledInput,
	SetProviderModelsEnabledOutput,
	StartProviderAuthInput,
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
	providerAuthStart(input: StartProviderAuthInput): Promise<ProviderAuthAttemptOutput>;
	providerAuthGet(attemptId: string): Promise<ProviderAuthAttemptOutput>;
	providerAuthRespond(input: RespondProviderAuthInput): Promise<ProviderAuthAttemptOutput>;
	providerAuthCancel(attemptId: string): Promise<ProviderAuthAttemptOutput>;
	providerLogout(providerId: string): Promise<unknown>;
	openExternalUrl(url: string): Promise<{ opened: boolean }>;
	listAvailableModels(): Promise<ListAvailableModelsOutput>;
	getDefaultModel(): Promise<GetDefaultModelOutput>;
	setDefaultModel(input: SetDefaultModelInput): Promise<SetDefaultModelOutput>;
	setChatSessionModel(input: SetChatSessionModelInput): Promise<SetChatSessionModelOutput>;
	createChatSession(
		model?: SessionModelSelection,
		projectId?: string,
	): Promise<CreateChatSessionOutput>;
	getChatSession(sessionId: string): Promise<GetChatSessionSnapshotOutput>;
	listChatSessions(input?: {
		query?: string;
		archived?: boolean;
		limit?: number;
		runtimeBoxId?: string;
		scope?: SessionListScope;
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
	subscribeChatEvents(listener: (event: ChatTransportEvent) => void): () => void;
	subscribeChatSessionInvalidations?(
		listener: (invalidation: ChatSessionInvalidation) => void | PromiseLike<void>,
		options?: ChatSessionInvalidationSubscriptionOptions,
	): () => void;
}

export function createRpcChatTransport(
	client: RpcChatClient,
	options: { now?: () => number } = {},
): ChatTransport {
	const listeners = new Set<ChatTransportListener>();
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
		for (const listener of listeners) {
			listener(event);
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
				schemaVersion: 2,
				providerId,
				enabledModelIds,
			});
			return output.provider;
		},
		async startProviderAuth(providerId: string, authType: ProviderAuthType) {
			return (
				await client.providerAuthStart({
					schemaVersion: 2,
					providerId,
					authType,
				})
			).attempt;
		},
		async getProviderAuth(attemptId: string) {
			return (await client.providerAuthGet(attemptId)).attempt;
		},
		async respondProviderAuth(attemptId: string, challengeId: string, value: string) {
			return (
				await client.providerAuthRespond({
					attemptId,
					challengeId,
					value,
				})
			).attempt;
		},
		async cancelProviderAuth(attemptId: string) {
			return (await client.providerAuthCancel(attemptId)).attempt;
		},
		async logoutProvider(providerId: string): Promise<void> {
			await client.providerLogout(providerId);
		},
		async openExternalUrl(url: string): Promise<void> {
			await client.openExternalUrl(url);
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
			const output = await client.setDefaultModel({ schemaVersion: 2, defaultModel: selection });
			return output.defaultModel;
		},
		async setSessionModel(
			sessionId: string,
			selection: SessionModelSelection | null,
		): Promise<SessionModelSelection | undefined> {
			const output = await client.setChatSessionModel({ sessionId, model: selection });
			return output.session.model;
		},
		async createSession(model?: SessionModelSelection, projectId?: string) {
			const { session } = await client.createChatSession(model, projectId);
			return {
				id: session.id,
				runtimeBoxId: session.runtimeBoxId,
				...(session.projectId === undefined ? {} : { projectId: session.projectId }),
				title: session.title,
				updatedAt: session.updatedAt,
				...(session.model === undefined ? {} : { model: session.model }),
				askMode: "Ask",
				runs: [],
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
				runtimeBoxId: snapshot.session.runtimeBoxId,
				...(snapshot.session.projectId === undefined
					? {}
					: { projectId: snapshot.session.projectId }),
				title: snapshot.session.title,
				updatedAt: snapshot.session.updatedAt,
				...(snapshot.session.archivedAt === undefined
					? {}
					: { archivedAt: snapshot.session.archivedAt }),
				...(snapshot.session.model === undefined ? {} : { model: snapshot.session.model }),
				askMode: "Ask",
				runs: snapshot.runs,
			};

			if (activeRun !== undefined) {
				session.activeResponse = {
					requestId: activeRun.id,
				};
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
			return {
				requestId: accepted.run.id,
				run: accepted.run,
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
		runtimeBoxId: session.runtimeBoxId,
		...(session.projectId === undefined ? {} : { projectId: session.projectId }),
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
		...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
	};
}
