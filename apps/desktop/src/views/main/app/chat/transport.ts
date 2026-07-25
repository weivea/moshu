export const DEFAULT_PROVIDER_ENDPOINT = "https://api.openai.com/v1";

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "streaming" | "completed" | "cancelled" | "error";

export interface ChatProviderStatus {
	configured: boolean;
	endpoint: string;
	model: string;
	askMode: string;
	apiKeyMask?: string;
}

export interface ChatProviderConfiguration {
	endpoint: string;
	model: string;
	apiKey?: string;
}

export interface ChatProviderConnectionTestResult {
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
	model: string;
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

export interface ChatTransport {
	getProviderStatus(): Promise<ChatProviderStatus>;
	configureProvider(input: ChatProviderConfiguration): Promise<ChatProviderStatus>;
	testProvider(input: ChatProviderConfiguration): Promise<ChatProviderConnectionTestResult>;
	deleteProvider(): Promise<ChatProviderStatus>;
	createSession(): Promise<ChatSession>;
	getSession(sessionId: string): Promise<ChatSession>;
	listSessions(input?: ListChatSessionsOptions): Promise<ChatSessionSummary[]>;
	renameSession(sessionId: string, title: string): Promise<ChatSessionSummary>;
	setSessionArchived(sessionId: string, archived: boolean): Promise<ChatSessionSummary>;
	deleteSession(sessionId: string): Promise<void>;
	send(input: { sessionId: string; message: string }): Promise<ChatSendResult>;
	cancel(input: { sessionId: string; requestId: string }): Promise<void>;
	subscribe(listener: ChatTransportListener): () => void;
}
