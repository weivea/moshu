import type { CreateProviderInput, UpdateProviderInput } from "@moshu/contracts";
import type {
	AvailableModel,
	ChatMessage,
	ChatSendResult,
	ChatSession,
	ChatSessionSummary,
	ChatTransport,
	ChatTransportEvent,
	ChatTransportListener,
	DefaultModelSelection,
	ProviderConnectionTestResult,
	ProviderSummary,
	SessionModelSelection,
} from "./transport";

interface PendingPreviewResponse {
	sessionId: string;
	messageId: string;
	timers: number[];
}

export function createPreviewChatTransport(): ChatTransport {
	const providers: ProviderSummary[] = [];
	let defaultModel: DefaultModelSelection | undefined;
	let nextSessionNumber = 1;
	let nextMessageNumber = 1;
	let nextRequestNumber = 1;
	let nextProviderNumber = 1;
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

	function requireConfiguredProvider(): SessionModelSelection {
		if (defaultModel === undefined) {
			throw new Error("Configure a Provider and select a model before sending messages.");
		}
		return defaultModel;
	}

	function requireProvider(providerId: string): ProviderSummary {
		const provider = providers.find((candidate) => candidate.id === providerId);
		if (provider === undefined) {
			throw new Error(`Provider ${providerId} was not found.`);
		}
		return provider;
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
		const response = buildPreviewResponse(userPrompt, defaultModel?.modelId ?? "preview-model");
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
		async listProviders() {
			return providers.map((provider) => structuredClone(provider));
		},
		async createProvider(input: CreateProviderInput) {
			const provider: ProviderSummary = {
				schemaVersion: 1,
				id: `preview-provider-${nextProviderNumber}`,
				displayName: input.displayName,
				type: input.type,
				baseUrl: input.baseUrl,
				enabled: true,
				apiKeyMask: `••••••••${input.apiKey.slice(-4)}`,
				customHeaderNames: Object.keys(input.customHeaders ?? {}).sort(),
				models: [],
			};
			nextProviderNumber += 1;
			providers.push(provider);
			return structuredClone(provider);
		},
		async updateProvider(input: UpdateProviderInput) {
			const provider = requireProvider(input.providerId);
			if (input.displayName !== undefined) {
				provider.displayName = input.displayName;
			}
			if (input.type !== undefined) {
				provider.type = input.type;
			}
			if (input.baseUrl !== undefined) {
				provider.baseUrl = input.baseUrl;
			}
			if (input.apiKey !== undefined) {
				provider.apiKeyMask = `••••••••${input.apiKey.slice(-4)}`;
			}
			if (input.customHeaders !== undefined) {
				provider.customHeaderNames = Object.keys(input.customHeaders).sort();
			}
			if (input.enabled !== undefined) {
				provider.enabled = input.enabled;
			}
			return structuredClone(provider);
		},
		async deleteProvider(providerId: string) {
			requireNoPendingResponse();
			const index = providers.findIndex((provider) => provider.id === providerId);
			if (index >= 0) {
				providers.splice(index, 1);
			}
			if (defaultModel?.providerId === providerId) {
				defaultModel = undefined;
			}
		},
		async testProvider(): Promise<ProviderConnectionTestResult> {
			return { ok: true, latencyMs: 12 };
		},
		async fetchProviderModels(providerId: string) {
			const provider = requireProvider(providerId);
			const enabled = new Set(provider.models.filter((model) => model.enabled).map((m) => m.id));
			provider.models = previewCatalog(provider.type).map((model) => ({
				...model,
				enabled: enabled.has(model.id),
			}));
			provider.modelsFetchedAt = new Date().toISOString();
			return structuredClone(provider);
		},
		async setProviderModelsEnabled(providerId: string, enabledModelIds: string[]) {
			const provider = requireProvider(providerId);
			const enabled = new Set(enabledModelIds);
			provider.models = provider.models.map((model) => ({
				...model,
				enabled: enabled.has(model.id),
			}));
			if (defaultModel?.providerId === providerId && !enabled.has(defaultModel.modelId)) {
				defaultModel = undefined;
			}
			return structuredClone(provider);
		},
		async listAvailableModels() {
			const models: AvailableModel[] = [];
			for (const provider of providers) {
				if (!provider.enabled) {
					continue;
				}
				for (const model of provider.models) {
					if (!model.enabled) {
						continue;
					}
					models.push({
						providerId: provider.id,
						providerDisplayName: provider.displayName,
						providerType: provider.type,
						model: structuredClone(model),
						reasoning:
							model.reasoningEfforts === undefined
								? { kind: "none" }
								: { kind: "effort", levels: [...model.reasoningEfforts] },
					});
				}
			}
			return {
				models,
				...(defaultModel === undefined ? {} : { defaultModel: structuredClone(defaultModel) }),
			};
		},
		async getDefaultModel() {
			return defaultModel === undefined ? undefined : structuredClone(defaultModel);
		},
		async setDefaultModel(selection: DefaultModelSelection | null) {
			defaultModel = selection === null ? undefined : structuredClone(selection);
			return defaultModel === undefined ? undefined : structuredClone(defaultModel);
		},
		async setSessionModel(sessionId: string, selection: SessionModelSelection | null) {
			const session = getStoredSession(sessionId);
			if (selection === null) {
				delete session.model;
				return undefined;
			}
			session.model = structuredClone(selection);
			return structuredClone(selection);
		},

		async createSession(model?: SessionModelSelection) {
			const selection = model ?? requireConfiguredProvider();
			const session: ChatSession = {
				id: `preview-session-${nextSessionNumber}`,
				title: "New chat",
				updatedAt: new Date().toISOString(),
				model: structuredClone(selection),
				askMode: "Ask",
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

function previewCatalog(type: ProviderSummary["type"]): ProviderSummary["models"] {
	if (type === "anthropic-compatible") {
		return [
			{
				id: "claude-opus-4.6",
				enabled: false,
				displayName: "Claude Opus 4.6",
				contextWindowTokens: 200_000,
				maxOutputTokens: 64_000,
				supportedEndpoints: ["/v1/messages"],
			},
		];
	}

	return [
		{
			id: "gpt-5.5",
			enabled: false,
			displayName: "GPT-5.5",
			contextWindowTokens: 272_000,
			maxOutputTokens: 128_000,
			supportedEndpoints: ["/chat/completions", "/responses"],
			reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
		},
		{ id: "gpt-4.1-mini", enabled: false, displayName: "GPT-4.1 mini" },
	];
}
