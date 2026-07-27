import type {
	AvailableModel,
	CreateProviderInput,
	DefaultModelSelection,
	ProviderSummary,
	SessionModelSelection,
	TestProviderInput,
	UpdateProviderInput,
} from "@moshu/contracts";

export const DEFAULT_PROVIDER_ENDPOINT = "https://api.openai.com/v1";

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "streaming" | "completed" | "cancelled" | "error";

export type {
	AvailableModel,
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

export interface ChatMessage {
	id: string;
	role: ChatRole;
	content: string;
	createdAt: string;
	status?: ChatMessageStatus;
	errorMessage?: string;
}

export interface ChatSession {
	id: string;
	title: string;
	updatedAt: string;
	archivedAt?: string;
	model?: SessionModelSelection;
	askMode: string;
	messages: ChatMessage[];
	eventCursors?: Record<string, number>;
	activeResponse?: {
		requestId: string;
		messageId: string;
	};
}

export interface ChatSessionSummary {
	id: string;
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
}

export interface ChatSendResult {
	requestId: string;
	userMessage: ChatMessage;
	assistantMessage: ChatMessage;
}

export type ChatTransportEvent =
	| {
			type: "response.delta";
			sessionId: string;
			requestId: string;
			messageId: string;
			delta: string;
			sequence?: number;
	  }
	| {
			type: "response.completed";
			sessionId: string;
			requestId: string;
			messageId: string;
			content: string;
			sequence?: number;
	  }
	| {
			type: "response.cancelled";
			sessionId: string;
			requestId: string;
			messageId: string;
			content?: string;
			reason?: string;
			sequence?: number;
	  }
	| {
			type: "response.error";
			sessionId: string;
			requestId: string;
			messageId: string;
			content: string;
			message: string;
			sequence?: number;
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
	createSession(model?: SessionModelSelection): Promise<ChatSession>;
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
