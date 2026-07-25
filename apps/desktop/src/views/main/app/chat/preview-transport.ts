import {
	type ChatMessage,
	type ChatProviderConfiguration,
	type ChatProviderStatus,
	type ChatSendResult,
	type ChatSession,
	type ChatTransport,
	type ChatTransportEvent,
	type ChatTransportListener,
	DEFAULT_PROVIDER_ENDPOINT,
} from "./transport";

interface PendingPreviewResponse {
	sessionId: string;
	messageId: string;
	timers: number[];
}

export function createPreviewChatTransport(): ChatTransport {
	let providerStatus: ChatProviderStatus = {
		configured: false,
		endpoint: DEFAULT_PROVIDER_ENDPOINT,
		model: "",
		askMode: "Ask",
	};
	let nextSessionNumber = 1;
	let nextMessageNumber = 1;
	let nextRequestNumber = 1;
	const listeners = new Set<ChatTransportListener>();
	const sessions = new Map<string, ChatSession>();
	const pendingResponses = new Map<string, PendingPreviewResponse>();

	function cloneMessage(message: ChatMessage): ChatMessage {
		return { ...message };
	}

	function cloneSession(session: ChatSession): ChatSession {
		return {
			...session,
			messages: session.messages.map(cloneMessage),
		};
	}

	function notify(event: ChatTransportEvent) {
		for (const listener of listeners) {
			listener(event);
		}
	}

	function requireConfiguredProvider() {
		if (!providerStatus.configured) {
			throw new Error("Configure an OpenAI-compatible provider before sending messages.");
		}
	}

	function getStoredSession(sessionId: string): ChatSession {
		const session = sessions.get(sessionId);
		if (!session) {
			throw new Error("The requested chat session could not be found.");
		}
		return session;
	}

	function getStoredMessage(sessionId: string, messageId: string): ChatMessage {
		const message = getStoredSession(sessionId).messages.find(
			(candidate) => candidate.id === messageId,
		);
		if (!message) {
			throw new Error("The requested chat message could not be found.");
		}
		return message;
	}

	function updateMessage(
		sessionId: string,
		messageId: string,
		updater: (message: ChatMessage) => ChatMessage,
	) {
		const session = getStoredSession(sessionId);
		session.messages = session.messages.map((message) =>
			message.id === messageId ? updater(message) : message,
		);
	}

	function schedulePreviewResponse(
		requestId: string,
		sessionId: string,
		messageId: string,
		userPrompt: string,
	) {
		const response = buildPreviewResponse(userPrompt, providerStatus.model);
		const chunks = splitIntoChunks(response);
		const timers = chunks.map((chunk, index) =>
			window.setTimeout(
				() => {
					updateMessage(sessionId, messageId, (message) => ({
						...message,
						content: `${message.content}${chunk}`,
						status: "streaming",
					}));
					notify({
						type: "response.delta",
						sessionId,
						requestId,
						messageId,
						delta: chunk,
					});
				},
				180 * (index + 1),
			),
		);

		timers.push(
			window.setTimeout(
				() => {
					updateMessage(sessionId, messageId, (message) => ({
						...message,
						status: "completed",
					}));
					pendingResponses.delete(requestId);
					notify({
						type: "response.completed",
						sessionId,
						requestId,
						messageId,
						content: response,
					});
				},
				180 * (chunks.length + 1),
			),
		);

		pendingResponses.set(requestId, {
			sessionId,
			messageId,
			timers,
		});
	}

	return {
		async getProviderStatus() {
			return { ...providerStatus };
		},
		async configureProvider(input: ChatProviderConfiguration) {
			if (!input.endpoint.trim()) {
				throw new Error("Endpoint is required.");
			}
			if (!input.model.trim()) {
				throw new Error("Model is required.");
			}
			if (!input.apiKey.trim()) {
				throw new Error("API key is required.");
			}

			providerStatus = {
				configured: true,
				endpoint: input.endpoint.trim(),
				model: input.model.trim(),
				askMode: "Ask",
			};

			return { ...providerStatus };
		},
		async createSession() {
			requireConfiguredProvider();
			const session: ChatSession = {
				id: `preview-session-${nextSessionNumber}`,
				model: providerStatus.model,
				askMode: providerStatus.askMode,
				messages: [],
			};
			nextSessionNumber += 1;
			sessions.set(session.id, session);
			return cloneSession(session);
		},
		async getSession(sessionId: string) {
			return cloneSession(getStoredSession(sessionId));
		},
		async send(input: { sessionId: string; message: string }): Promise<ChatSendResult> {
			requireConfiguredProvider();
			const trimmedMessage = input.message.trim();
			if (!trimmedMessage) {
				throw new Error("Message is required.");
			}

			const session = getStoredSession(input.sessionId);
			const userMessage: ChatMessage = {
				id: `preview-user-${nextMessageNumber}`,
				role: "user",
				content: trimmedMessage,
				createdAt: new Date().toISOString(),
				status: "completed",
			};
			nextMessageNumber += 1;

			const assistantMessage: ChatMessage = {
				id: `preview-assistant-${nextMessageNumber}`,
				role: "assistant",
				content: "",
				createdAt: new Date().toISOString(),
				status: "streaming",
			};
			nextMessageNumber += 1;

			session.messages.push(userMessage, assistantMessage);

			const requestId = `preview-request-${nextRequestNumber}`;
			nextRequestNumber += 1;
			schedulePreviewResponse(requestId, session.id, assistantMessage.id, trimmedMessage);

			return {
				requestId,
				userMessage: cloneMessage(userMessage),
				assistantMessage: cloneMessage(assistantMessage),
			};
		},
		async cancel(input: { sessionId: string; requestId: string }) {
			const pending = pendingResponses.get(input.requestId);
			if (!pending || pending.sessionId !== input.sessionId) {
				throw new Error("The current response can no longer be stopped.");
			}

			for (const timer of pending.timers) {
				window.clearTimeout(timer);
			}

			updateMessage(input.sessionId, pending.messageId, (message) => ({
				...message,
				status: "cancelled",
			}));
			pendingResponses.delete(input.requestId);

			notify({
				type: "response.cancelled",
				sessionId: input.sessionId,
				requestId: input.requestId,
				messageId: pending.messageId,
				content: getStoredMessage(input.sessionId, pending.messageId).content,
				reason: "Preview response stopped.",
			});
		},
		subscribe(listener: ChatTransportListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

function buildPreviewResponse(userPrompt: string, model: string) {
	return [
		`Preview assistant (${model}) received your message:`,
		"",
		userPrompt,
		"",
		"This standalone module only demonstrates provider setup, session bootstrap, streaming text, cancellation, and retry-ready UI states.",
	].join("\n");
}

function splitIntoChunks(response: string) {
	const size = Math.max(18, Math.ceil(response.length / 4));
	const chunks: string[] = [];

	for (let index = 0; index < response.length; index += size) {
		chunks.push(response.slice(index, index + size));
	}

	return chunks.length > 0 ? chunks : [response];
}
