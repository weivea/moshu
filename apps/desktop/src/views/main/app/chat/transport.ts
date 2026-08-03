import type {
	AvailableModel,
	ChatRunEvent,
	ChatRunSnapshot,
	CreateProviderInput,
	DefaultModelSelection,
	ProviderAuthAttempt,
	ProviderAuthType,
	ProviderSummary,
	SessionListScope,
	SessionModelSelection,
	TestProviderInput,
	UpdateProviderInput,
} from "@moshu/contracts";

export const DEFAULT_PROVIDER_ENDPOINT = "https://api.openai.com/v1";

export type {
	AvailableModel,
	ChatRunEvent,
	ChatRunSnapshot,
	CreateProviderInput,
	DefaultModelSelection,
	ProviderSummary,
	SessionModelSelection,
	UpdateProviderInput,
};

export interface ProviderConnectionTestResult {
	ok: boolean;
	latencyMs: number;
	errorMessage?: string;
}

export interface ChatSession {
	id: string;
	runtimeBoxId: string;
	projectId?: string;
	title: string;
	updatedAt: string;
	archivedAt?: string;
	model?: SessionModelSelection;
	askMode: string;
	runs: ChatRunSnapshot[];
	activeResponse?: {
		requestId: string;
	};
}

export interface ChatSessionSummary {
	id: string;
	runtimeBoxId: string;
	projectId?: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	lastMessageAt?: string;
	archivedAt?: string;
}

export interface ListChatSessionsOptions {
	query?: string;
	archived?: boolean;
	limit?: number;
	runtimeBoxId?: string;
	scope?: SessionListScope;
}

export interface ChatSendResult {
	requestId: string;
	run: ChatRunSnapshot;
}

export type ChatTransportEvent = ChatRunEvent & {
	clientRequestId?: string;
};

export type ChatTransportListener = (event: ChatTransportEvent) => void;
export interface ChatSessionInvalidation {
	sessionId: string;
	reason: "session_retired" | "history_expired";
}
export type ChatSessionInvalidationListener = (
	invalidation: ChatSessionInvalidation,
) => void | PromiseLike<void>;
export interface ChatSessionInvalidationSubscriptionOptions {
	authoritative?: boolean;
}

export interface ChatTransport {
	listProviders(): Promise<ProviderSummary[]>;
	createProvider(input: CreateProviderInput): Promise<ProviderSummary>;
	updateProvider(input: UpdateProviderInput): Promise<ProviderSummary>;
	deleteProvider(providerId: string): Promise<void>;
	testProvider(input: TestProviderInput): Promise<ProviderConnectionTestResult>;
	fetchProviderModels(providerId: string): Promise<ProviderSummary>;
	setProviderModelsEnabled(providerId: string, enabledModelIds: string[]): Promise<ProviderSummary>;
	startProviderAuth(providerId: string, authType: ProviderAuthType): Promise<ProviderAuthAttempt>;
	getProviderAuth(attemptId: string): Promise<ProviderAuthAttempt>;
	respondProviderAuth(
		attemptId: string,
		challengeId: string,
		value: string,
	): Promise<ProviderAuthAttempt>;
	cancelProviderAuth(attemptId: string): Promise<ProviderAuthAttempt>;
	logoutProvider(providerId: string): Promise<void>;
	openExternalUrl(url: string): Promise<void>;
	listAvailableModels(): Promise<{
		models: AvailableModel[];
		defaultModel?: DefaultModelSelection;
	}>;
	getDefaultModel(): Promise<DefaultModelSelection | undefined>;
	setDefaultModel(
		selection: DefaultModelSelection | null,
	): Promise<DefaultModelSelection | undefined>;
	setSessionModel(
		sessionId: string,
		selection: SessionModelSelection | null,
	): Promise<SessionModelSelection | undefined>;
	createSession(model?: SessionModelSelection, projectId?: string): Promise<ChatSession>;
	getSession(sessionId: string): Promise<ChatSession>;
	listSessions(input?: ListChatSessionsOptions): Promise<ChatSessionSummary[]>;
	renameSession(sessionId: string, title: string): Promise<ChatSessionSummary>;
	setSessionArchived(sessionId: string, archived: boolean): Promise<ChatSessionSummary>;
	deleteSession(sessionId: string): Promise<void>;
	send(input: { requestId: string; sessionId: string; message: string }): Promise<ChatSendResult>;
	cancel(input: { sessionId: string; requestId: string }): Promise<void>;
	retireSession?(sessionId: string): void;
	subscribe(listener: ChatTransportListener): () => void;
	subscribeAgentsReady?(listener: () => void): () => void;
	subscribeSessionInvalidations?(
		listener: ChatSessionInvalidationListener,
		options?: ChatSessionInvalidationSubscriptionOptions,
	): () => void;
}
