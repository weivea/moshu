import {
	type ChatMessage,
	type ChatProviderConfiguration,
	type ChatProviderConnectionTestResult,
	type ChatProviderStatus,
	type ChatSendResult,
	type ChatSession,
	type ChatSessionSummary,
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
	let providerApiKey: string | undefined;
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

	function requireNoPendingResponse(sessionId?: string) {
		const hasPendingResponse = [...pendingResponses.values()].some(
			(response) => sessionId === undefined || response.sessionId === sessionId,
		);
		if (hasPendingResponse) {
			throw new Error("Stop active responses before changing this configuration.");
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
			requireNoPendingResponse();
			if (!input.endpoint.trim()) {
				throw new Error("Endpoint is required.");
			}
			if (!URL.canParse(input.endpoint.trim())) {
				throw new Error("Endpoint must be a valid URL.");
			}
			if (!input.model.trim()) {
				throw new Error("Model is required.");
			}
			if (!input.apiKey?.trim() && providerApiKey === undefined) {
				throw new Error("API key is required.");
			}
			if (
				!input.apiKey?.trim() &&
				providerStatus.configured &&
				new URL(providerStatus.endpoint).origin !== new URL(input.endpoint.trim()).origin
			) {
				throw new Error("A new API key is required for a different Endpoint origin.");
			}
			providerApiKey = input.apiKey?.trim() || providerApiKey;

			providerStatus = {
				configured: true,
				endpoint: input.endpoint.trim(),
				model: input.model.trim(),
				askMode: "Ask",
				...(providerApiKey === undefined
					? {}
					: {
							apiKeyMask: `********${providerApiKey.length > 4 ? providerApiKey.slice(-4) : ""}`,
						}),
			};

			return { ...providerStatus };
		},
		async testProvider(
			input: ChatProviderConfiguration,
		): Promise<ChatProviderConnectionTestResult> {
			if (
				!input.endpoint.trim() ||
				!URL.canParse(input.endpoint.trim()) ||
				!input.model.trim() ||
				(!input.apiKey?.trim() && providerApiKey === undefined)
			) {
				return {
					ok: false,
					latencyMs: 0,
					errorMessage: "Endpoint, model, and API key are required.",
				};
			}
			if (
				!input.apiKey?.trim() &&
				providerStatus.configured &&
				new URL(providerStatus.endpoint).origin !== new URL(input.endpoint.trim()).origin
			) {
				return {
					ok: false,
					latencyMs: 0,
					errorMessage: "A new API key is required for a different Endpoint origin.",
				};
			}
			return { ok: true, latencyMs: 12 };
		},
		async deleteProvider() {
			requireNoPendingResponse();
			providerApiKey = undefined;
			providerStatus = {
				configured: false,
				endpoint: DEFAULT_PROVIDER_ENDPOINT,
				model: "",
				askMode: "Ask",
			};
			return { ...providerStatus };
		},
		async createSession() {
			requireConfiguredProvider();
			const session: ChatSession = {
				id: `preview-session-${nextSessionNumber}`,
				title: "New chat",
				updatedAt: new Date().toISOString(),
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
		async listSessions(input = {}) {
			const query = input.query?.trim().toLocaleLowerCase() ?? "";
			return [...sessions.values()]
				.filter((session) => (session.archivedAt !== undefined) === (input.archived ?? false))
				.filter((session) => session.title.toLocaleLowerCase().includes(query))
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
				.slice(0, input.limit ?? 50)
				.map(toSessionSummary);
		},
		async renameSession(sessionId: string, title: string) {
			const session = getStoredSession(sessionId);
			session.title = title.trim();
			session.updatedAt = new Date().toISOString();
			return toSessionSummary(session);
		},
		async setSessionArchived(sessionId: string, archived: boolean) {
			if (archived) {
				requireNoPendingResponse(sessionId);
			}
			const session = getStoredSession(sessionId);
			if (archived) {
				session.archivedAt = new Date().toISOString();
			} else {
				delete session.archivedAt;
			}
			session.updatedAt = new Date().toISOString();
			return toSessionSummary(session);
		},
		async deleteSession(sessionId: string) {
			requireNoPendingResponse(sessionId);
			if (!sessions.delete(sessionId)) {
				throw new Error("The requested chat session could not be found.");
			}
		},
		async send(input: {
			requestId: string;
			sessionId: string;
			message: string;
		}): Promise<ChatSendResult> {
			requireConfiguredProvider();
			const trimmedMessage = input.message.trim();
			if (!trimmedMessage) {
				throw new Error("Message is required.");
			}

			const session = getStoredSession(input.sessionId);
			if (session.archivedAt !== undefined) {
				throw new Error("Archived chat Sessions cannot send new messages.");
			}
			if (session.messages.length === 0 && session.title === "New chat") {
				const normalizedTitle = trimmedMessage.replace(/\s+/g, " ");
				session.title =
					normalizedTitle.length <= 60 ? normalizedTitle : `${normalizedTitle.slice(0, 57)}...`;
			}
			session.updatedAt = new Date().toISOString();
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

function toSessionSummary(session: ChatSession): ChatSessionSummary {
	const lastMessageAt = session.messages.at(-1)?.createdAt;
	return {
		id: session.id,
		title: session.title,
		createdAt: session.updatedAt,
		updatedAt: session.updatedAt,
		...(lastMessageAt === undefined ? {} : { lastMessageAt }),
		...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
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
