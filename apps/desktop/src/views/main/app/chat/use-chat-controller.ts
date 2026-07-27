import type { AvailableModel, DefaultModelSelection, ThinkingLevel } from "@moshu/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, useI18n } from "../i18n";
import { useChatSessionRecovery } from "./session-recovery-coordinator";
import type {
	ChatMessage,
	ChatSession,
	ChatSessionSummary,
	ChatTransport,
	ChatTransportEvent,
	SessionModelSelection,
} from "./transport";

interface UseChatControllerOptions {
	transport: ChatTransport;
	sessionId?: string;
	initialSession?: ChatSession;
	onSessionChange?(sessionId: string): void;
	onSessionHydrated?(sessionId: string): void;
	onSessionRetired?(sessionId: string): void;
}

interface ChatNotice {
	tone: "info" | "danger";
	message: string;
	action?: "retry-send" | "retry-session" | "retry-stop";
}

interface ActiveResponse {
	requestId: string;
	messageId: string;
}

interface SessionHydration {
	sessionId: string;
	promise: Promise<boolean>;
	queuedRefresh?: Promise<boolean>;
}

export function useChatController({
	transport,
	sessionId,
	initialSession,
	onSessionChange,
	onSessionHydrated,
	onSessionRetired,
}: UseChatControllerOptions) {
	const providedSession =
		initialSession !== undefined && initialSession.id === sessionId ? initialSession : undefined;
	const { coordinator: sessionRecoveryCoordinator, route: recoveryRoute } = useChatSessionRecovery(
		transport,
		sessionId,
	);
	const { t } = useI18n();
	const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
	const [defaultModel, setDefaultModel] = useState<DefaultModelSelection | null>(null);
	const [pendingModel, setPendingModel] = useState<SessionModelSelection | null>(null);
	const [isProviderLoading, setIsProviderLoading] = useState(true);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [session, setSession] = useState<ChatSession | null>(providedSession ?? null);
	const [isSessionLoading, setIsSessionLoading] = useState(false);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState<ChatNotice | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [activeResponse, setActiveResponse] = useState<ActiveResponse | null>(
		providedSession?.activeResponse ?? null,
	);
	const [isSending, setIsSending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const providerLoadToken = useRef(0);
	const sessionLoadToken = useRef(0);
	const sendGenerationRef = useRef(0);
	const sendInFlightRef = useRef(false);
	const activeSessionIdRef = useRef<string | null>(null);
	const lastSubmittedTextRef = useRef<string | null>(null);
	const lastSubmittedRequestIdRef = useRef<string | null>(null);
	const hydratedSessionIdRef = useRef<string | null>(null);
	const sessionHydrationRef = useRef<SessionHydration | null>(null);
	const bufferedEventsRef = useRef<ChatTransportEvent[]>([]);
	const eventCursorsRef = useRef<Record<string, number>>({});
	const unroutedSessionIdRef = useRef<string | null>(null);
	const acceptedRequestIdsRef = useRef(
		new Set<string>(
			providedSession?.activeResponse === undefined
				? []
				: [providedSession.activeResponse.requestId],
		),
	);
	const terminalEventsBeforeAcceptanceRef = useRef(new Set<string>());

	activeSessionIdRef.current = sessionId ?? session?.id ?? null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId invalidates pending sends.
	useEffect(() => {
		sendGenerationRef.current += 1;
		sendInFlightRef.current = false;
		lastSubmittedTextRef.current = null;
		lastSubmittedRequestIdRef.current = null;
		setIsSending(false);
		setDraft("");

		return () => {
			sendGenerationRef.current += 1;
			sendInFlightRef.current = false;
			lastSubmittedTextRef.current = null;
			lastSubmittedRequestIdRef.current = null;
		};
	}, [sessionId]);

	const applyMessageUpdate = useCallback(
		(messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
			setSession((currentSession) => {
				if (!currentSession) {
					return currentSession;
				}

				const messageIndex = currentSession.messages.findIndex(
					(message) => message.id === messageId,
				);
				if (messageIndex === -1) {
					return {
						...currentSession,
						messages: [
							...currentSession.messages,
							updater({
								id: messageId,
								role: "assistant",
								content: "",
								createdAt: new Date().toISOString(),
								status: "streaming",
							}),
						],
					};
				}

				return {
					...currentSession,
					messages: currentSession.messages.map((message, index) =>
						index === messageIndex ? updater(message) : message,
					),
				};
			});
		},
		[],
	);

	const applyTransportEvent = useCallback(
		(event: ChatTransportEvent) => {
			handleTransportEvent({
				event,
				activeSessionId: activeSessionIdRef.current,
				applyMessageUpdate,
				setActiveResponse,
				setAnnouncement,
				setIsStopping,
				setNotice,
				t,
				lastSubmittedText: lastSubmittedTextRef.current,
			});
		},
		[applyMessageUpdate, t],
	);

	const applyTransportEventIfNew = useCallback(
		(event: ChatTransportEvent) => {
			if (event.sequence !== undefined) {
				const lastSequence = eventCursorsRef.current[event.requestId] ?? 0;
				if (event.sequence <= lastSequence) {
					return;
				}
				eventCursorsRef.current[event.requestId] = event.sequence;
			}

			if (isTerminalTransportEvent(event)) {
				if (acceptedRequestIdsRef.current.has(event.requestId)) {
					acceptedRequestIdsRef.current.delete(event.requestId);
				} else {
					terminalEventsBeforeAcceptanceRef.current.add(event.requestId);
				}
			}
			applyTransportEvent(event);
		},
		[applyTransportEvent],
	);

	const clearInvalidatedSession = useCallback(
		(invalidatedSessionId: string, notifyRetirement = false) => {
			if (activeSessionIdRef.current !== invalidatedSessionId) {
				return;
			}
			sessionLoadToken.current += 1;
			sendGenerationRef.current += 1;
			sendInFlightRef.current = false;
			activeSessionIdRef.current = null;
			hydratedSessionIdRef.current = null;
			sessionHydrationRef.current = null;
			bufferedEventsRef.current = [];
			eventCursorsRef.current = {};
			acceptedRequestIdsRef.current.clear();
			terminalEventsBeforeAcceptanceRef.current.clear();
			unroutedSessionIdRef.current = null;
			lastSubmittedTextRef.current = null;
			lastSubmittedRequestIdRef.current = null;
			setSession(null);
			setActiveResponse(null);
			setIsSessionLoading(false);
			setIsSending(false);
			setIsStopping(false);
			setDraft("");
			setNotice(null);
			setAnnouncement("");
			if (notifyRetirement) {
				onSessionRetired?.(invalidatedSessionId);
			}
		},
		[onSessionRetired],
	);

	const performSessionLoad = useCallback(
		async (
			requestedSessionId: string,
			propagateFailure = false,
			optimisticSession?: ChatSession,
		) => {
			const loadToken = sessionLoadToken.current + 1;
			sessionLoadToken.current = loadToken;
			hydratedSessionIdRef.current = null;
			bufferedEventsRef.current = bufferedEventsRef.current.filter(
				(event) => event.sessionId === requestedSessionId,
			);
			eventCursorsRef.current = {};
			acceptedRequestIdsRef.current.clear();
			terminalEventsBeforeAcceptanceRef.current.clear();
			setIsSessionLoading(true);
			setSession(optimisticSession ?? null);
			setActiveResponse(optimisticSession?.activeResponse ?? null);
			if (optimisticSession?.activeResponse !== undefined) {
				acceptedRequestIdsRef.current.add(optimisticSession.activeResponse.requestId);
			}
			setIsStopping(false);
			setNotice(null);
			setAnnouncement(t("chat.status.loadingHistory"));

			try {
				const nextSession = await transport.getSession(requestedSessionId);
				if (
					sessionLoadToken.current !== loadToken ||
					activeSessionIdRef.current !== requestedSessionId
				) {
					return false;
				}

				setSession(nextSession);
				setActiveResponse(nextSession.activeResponse ?? null);
				acceptedRequestIdsRef.current.clear();
				terminalEventsBeforeAcceptanceRef.current.clear();
				if (nextSession.activeResponse !== undefined) {
					acceptedRequestIdsRef.current.add(nextSession.activeResponse.requestId);
				}
				eventCursorsRef.current = { ...(nextSession.eventCursors ?? {}) };
				hydratedSessionIdRef.current = requestedSessionId;
				unroutedSessionIdRef.current = null;
				const bufferedEvents = orderBufferedTransportEvents(bufferedEventsRef.current);
				bufferedEventsRef.current = [];
				for (const event of bufferedEvents) {
					if (event.sessionId === requestedSessionId) {
						applyTransportEventIfNew(event);
					}
				}
				onSessionHydrated?.(requestedSessionId);
				setAnnouncement(t("chat.status.historyReady"));
				return true;
			} catch (error) {
				const sessionMiss = sessionRecoveryCoordinator.handleSessionMiss(requestedSessionId, error);
				if (sessionMiss && propagateFailure) {
					throw error;
				}
				if (
					sessionLoadToken.current !== loadToken ||
					activeSessionIdRef.current !== requestedSessionId
				) {
					return false;
				}

				if (sessionMiss) {
					return false;
				}
				setSession(null);
				hydratedSessionIdRef.current = null;
				bufferedEventsRef.current = [];
				eventCursorsRef.current = {};
				acceptedRequestIdsRef.current.clear();
				terminalEventsBeforeAcceptanceRef.current.clear();
				setActiveResponse(null);
				setIsStopping(false);
				setNotice({
					tone: "danger",
					message: getErrorMessage(error, t("chat.error.history")),
					action: "retry-session",
				});
				setAnnouncement(t("chat.status.historyFailed"));
				if (propagateFailure) {
					throw error;
				}
				return false;
			} finally {
				if (
					sessionLoadToken.current === loadToken &&
					activeSessionIdRef.current === requestedSessionId
				) {
					setIsSessionLoading(false);
				}
			}
		},
		[applyTransportEventIfNew, onSessionHydrated, sessionRecoveryCoordinator, t, transport],
	);

	const loadSession = useCallback(
		(
			requestedSessionId: string,
			propagateFailure = false,
			optimisticSession?: ChatSession,
			refreshAfterCurrent = false,
		): Promise<boolean> => {
			const startHydration = (): Promise<boolean> => {
				const promise = performSessionLoad(requestedSessionId, propagateFailure, optimisticSession);
				const hydration: SessionHydration = {
					sessionId: requestedSessionId,
					promise,
				};
				sessionHydrationRef.current = hydration;
				const clearHydration = () => {
					if (sessionHydrationRef.current === hydration) {
						sessionHydrationRef.current = null;
					}
				};
				void promise.then(clearHydration, clearHydration);
				return promise;
			};

			const currentHydration = sessionHydrationRef.current;
			if (currentHydration?.sessionId !== requestedSessionId) {
				return startHydration();
			}
			if (!refreshAfterCurrent) {
				return currentHydration.promise;
			}
			if (currentHydration.queuedRefresh !== undefined) {
				return currentHydration.queuedRefresh;
			}
			const queuedRefresh = currentHydration.promise
				.catch(() => false)
				.then(() => (activeSessionIdRef.current === requestedSessionId ? startHydration() : false));
			currentHydration.queuedRefresh = queuedRefresh;
			return queuedRefresh;
		},
		[performSessionLoad],
	);

	const loadProviderStatus = useCallback(async () => {
		const loadToken = providerLoadToken.current + 1;
		providerLoadToken.current = loadToken;
		setIsProviderLoading(true);
		setProviderError(null);
		setAnnouncement(t("chat.status.loadingProvider"));

		try {
			const output = await transport.listAvailableModels();
			if (providerLoadToken.current !== loadToken) {
				return;
			}

			setAvailableModels(output.models);
			setDefaultModel(output.defaultModel ?? null);
			setAnnouncement(
				output.models.length > 0 ? t("chat.status.providerReady") : t("chat.status.providerNeeded"),
			);
		} catch (error) {
			if (providerLoadToken.current !== loadToken) {
				return;
			}

			setAvailableModels([]);
			setDefaultModel(null);
			setProviderError(getErrorMessage(error, t("model.error.load")));
			setAnnouncement(t("chat.status.providerFailed"));
		} finally {
			if (providerLoadToken.current === loadToken) {
				setIsProviderLoading(false);
			}
		}
	}, [t, transport]);

	useEffect(() => {
		void loadProviderStatus();
	}, [loadProviderStatus]);

	useEffect(() => {
		return transport.subscribe((event) => {
			if (activeSessionIdRef.current !== event.sessionId) {
				return;
			}

			if (hydratedSessionIdRef.current !== event.sessionId) {
				bufferedEventsRef.current.push(event);
				return;
			}

			applyTransportEventIfNew(event);
		});
	}, [applyTransportEventIfNew, transport]);

	useEffect(() => {
		if (!sessionId) {
			return;
		}

		activeSessionIdRef.current = sessionId;
		void loadSession(
			sessionId,
			false,
			initialSession?.id === sessionId ? initialSession : undefined,
		);
		return () => {
			if (activeSessionIdRef.current === sessionId) {
				activeSessionIdRef.current = null;
			}
			const hydration = sessionHydrationRef.current;
			if (hydration?.sessionId === sessionId) {
				sessionLoadToken.current += 1;
				if (sessionHydrationRef.current === hydration) {
					sessionHydrationRef.current = null;
				}
			}
		};
	}, [initialSession, loadSession, sessionId]);

	useEffect(() => {
		if (sessionId === undefined || recoveryRoute.sessionId !== sessionId) {
			return;
		}
		return sessionRecoveryCoordinator.registerController({
			generation: recoveryRoute.generation,
			sessionId,
			refresh: () => loadSession(sessionId, true, undefined, true),
			retire: () => clearInvalidatedSession(sessionId, true),
		});
	}, [
		clearInvalidatedSession,
		loadSession,
		recoveryRoute.generation,
		recoveryRoute.sessionId,
		sessionId,
		sessionRecoveryCoordinator,
	]);

	const hasConfiguredProvider = availableModels.length > 0;
	/**
	 * A chat runs against its own selection, falling back to the global default. Before the
	 * Session exists the picker edits a pending selection that is handed to `createSession`.
	 */
	const modelSelection = useMemo(
		() => session?.model ?? pendingModel ?? defaultModel ?? undefined,
		[defaultModel, pendingModel, session?.model],
	);
	const selectedModel = useMemo(
		() => resolveSelectedModel(availableModels, modelSelection),
		[availableModels, modelSelection],
	);
	const meta = useMemo(
		() => ({
			model: selectedModel?.model.displayName ?? selectedModel?.model.id ?? t("chat.meta.pending"),
			askMode: session?.askMode ?? "Ask",
			endpoint: selectedModel?.providerDisplayName ?? t("chat.meta.pending"),
		}),
		[selectedModel, session?.askMode, t],
	);

	const changeSessionModel = useCallback(
		async (selection: SessionModelSelection | null) => {
			const targetSessionId = session?.id ?? sessionId;
			if (targetSessionId === undefined) {
				setPendingModel(selection);
				return;
			}
			try {
				const stored = await transport.setSessionModel(targetSessionId, selection);
				setSession((current) =>
					current === null || current.id !== targetSessionId
						? current
						: stored === undefined
							? { ...current, model: undefined }
							: { ...current, model: stored },
				);
			} catch (error) {
				setNotice({ tone: "danger", message: getErrorMessage(error, t("model.error.save")) });
			}
		},
		[session?.id, sessionId, t, transport],
	);

	const canSend =
		hasConfiguredProvider &&
		!isSessionLoading &&
		!isSending &&
		(sessionId === undefined || session?.id === sessionId) &&
		draft.trim().length > 0 &&
		!activeResponse;
	const isResponding = activeResponse !== null;

	const sendMessage = useCallback(
		async (overrideText?: string) => {
			if (
				!hasConfiguredProvider ||
				activeResponse ||
				isSessionLoading ||
				(sessionId !== undefined && session?.id !== sessionId) ||
				sendInFlightRef.current
			) {
				return;
			}

			const content = (overrideText ?? draft).trim();
			if (!content) {
				return;
			}

			const sendGeneration = sendGenerationRef.current;
			const startingSessionId = activeSessionIdRef.current;
			const requestId =
				lastSubmittedTextRef.current === content && lastSubmittedRequestIdRef.current !== null
					? lastSubmittedRequestIdRef.current
					: crypto.randomUUID();
			let operationSessionId = startingSessionId;
			sendInFlightRef.current = true;
			setIsSending(true);
			setNotice(null);
			lastSubmittedTextRef.current = content;
			lastSubmittedRequestIdRef.current = requestId;
			setAnnouncement(t("chat.status.sending"));

			try {
				let activeSession = session;
				let createdSession = false;
				if (!activeSession) {
					activeSession = await transport.createSession(modelSelection);
					if (
						sendGenerationRef.current !== sendGeneration ||
						activeSessionIdRef.current !== startingSessionId
					) {
						return;
					}
					operationSessionId = activeSession.id;
					setSession(activeSession);
					activeSessionIdRef.current = activeSession.id;
					hydratedSessionIdRef.current = activeSession.id;
					eventCursorsRef.current = {};
					unroutedSessionIdRef.current = activeSession.id;
					createdSession = true;
				}

				const result = await transport.send({
					requestId,
					sessionId: activeSession.id,
					message: content,
				});
				if (
					sendGenerationRef.current !== sendGeneration ||
					activeSessionIdRef.current !== operationSessionId
				) {
					return;
				}
				if (lastSubmittedRequestIdRef.current === requestId) {
					lastSubmittedRequestIdRef.current = null;
				}
				const acceptedAlreadyTerminal = result.assistantMessage.status !== "streaming";
				if (!acceptedAlreadyTerminal) {
					acceptedRequestIdsRef.current.add(result.requestId);
				}
				const completedBeforeAcceptance = terminalEventsBeforeAcceptanceRef.current.delete(
					result.requestId,
				);
				if (completedBeforeAcceptance) {
					acceptedRequestIdsRef.current.delete(result.requestId);
				}

				setSession((currentSession) => {
					const baseSession =
						currentSession && currentSession.id === activeSession.id
							? currentSession
							: activeSession;

					return {
						...baseSession,
						title:
							baseSession.messages.length === 0 && baseSession.title === "New chat"
								? createSessionTitle(content)
								: baseSession.title,
						updatedAt: new Date().toISOString(),
						messages: mergeAcceptedMessages(
							baseSession.messages,
							result.userMessage,
							result.assistantMessage,
						),
					};
				});
				setActiveResponse(
					completedBeforeAcceptance || acceptedAlreadyTerminal
						? null
						: {
								requestId: result.requestId,
								messageId: result.assistantMessage.id,
							},
				);
				setDraft("");
				if (
					(createdSession || unroutedSessionIdRef.current === activeSession.id) &&
					onSessionChange !== undefined
				) {
					unroutedSessionIdRef.current = null;
					onSessionChange?.(activeSession.id);
				}
			} catch (error) {
				const sessionMiss =
					operationSessionId !== null &&
					sessionRecoveryCoordinator.handleSessionMiss(operationSessionId, error);
				if (
					sessionMiss &&
					operationSessionId !== null &&
					activeSessionIdRef.current === operationSessionId
				) {
					clearInvalidatedSession(operationSessionId, true);
				}
				if (
					sendGenerationRef.current !== sendGeneration ||
					activeSessionIdRef.current !== operationSessionId
				) {
					return;
				}
				if (sessionMiss) {
					return;
				}
				setNotice({
					tone: "danger",
					message: getErrorMessage(error, t("chat.error.send")),
					action: "retry-send",
				});
				setAnnouncement(t("chat.status.sendFailed"));
			} finally {
				if (sendGenerationRef.current === sendGeneration) {
					sendInFlightRef.current = false;
					setIsSending(false);
				}
			}
		},
		[
			activeResponse,
			clearInvalidatedSession,
			draft,
			hasConfiguredProvider,
			isSessionLoading,
			modelSelection,
			onSessionChange,
			session,
			sessionId,
			sessionRecoveryCoordinator,
			t,
			transport,
		],
	);

	const stopMessage = useCallback(async () => {
		if (!session || !activeResponse || isStopping) {
			return;
		}

		const stopGeneration = sendGenerationRef.current;
		const stopSessionId = session.id;
		setIsStopping(true);
		setNotice(null);
		setAnnouncement(t("chat.status.stopping"));

		try {
			await transport.cancel({
				sessionId: session.id,
				requestId: activeResponse.requestId,
			});
		} catch (error) {
			const sessionMiss = sessionRecoveryCoordinator.handleSessionMiss(stopSessionId, error);
			if (
				sendGenerationRef.current !== stopGeneration ||
				activeSessionIdRef.current !== stopSessionId
			) {
				return;
			}
			if (sessionMiss) {
				return;
			}
			setIsStopping(false);
			setNotice({
				tone: "danger",
				message: getErrorMessage(error, t("chat.error.stop")),
				action: "retry-stop",
			});
			setAnnouncement(t("chat.status.stopFailed"));
		}
	}, [activeResponse, isStopping, session, sessionRecoveryCoordinator, t, transport]);

	const retryNoticeAction = useCallback(() => {
		switch (notice?.action) {
			case "retry-session":
				if (sessionId) {
					void loadSession(sessionId);
				}
				break;
			case "retry-send":
				if (lastSubmittedTextRef.current) {
					void sendMessage(lastSubmittedTextRef.current);
				}
				break;
			case "retry-stop":
				void stopMessage();
				break;
			default:
				break;
		}
	}, [loadSession, notice?.action, sendMessage, sessionId, stopMessage]);

	return {
		announcement,
		availableModels,
		canSend,
		changeSessionModel,
		modelSelection,
		draft,
		hasConfiguredProvider,
		isProviderLoading,
		isResponding,
		isSending,
		isSessionLoading,
		isStopping,
		meta,
		notice,
		providerError,
		reloadProviderStatus: loadProviderStatus,
		selectedModel,
		retryNoticeAction,
		sendMessage,
		session,
		setDraft,
		stopMessage,
		updateSessionSummary: (updatedSession: ChatSessionSummary) => {
			setSession((currentSession) => mergeSessionSummary(currentSession, updatedSession));
		},
	};
}

function resolveSelectedModel(
	models: readonly AvailableModel[],
	selection: { providerId: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined,
): AvailableModel | undefined {
	if (selection === undefined) {
		return undefined;
	}
	return models.find(
		(entry) => entry.providerId === selection.providerId && entry.model.id === selection.modelId,
	);
}

function mergeSessionSummary(
	session: ChatSession | null,
	summary: ChatSessionSummary,
): ChatSession | null {
	if (session?.id !== summary.id) {
		return session;
	}

	const activeSession = { ...session };
	delete activeSession.archivedAt;
	return summary.archivedAt === undefined
		? {
				...activeSession,
				title: summary.title,
				updatedAt: summary.updatedAt,
			}
		: {
				...activeSession,
				title: summary.title,
				updatedAt: summary.updatedAt,
				archivedAt: summary.archivedAt,
			};
}

function createSessionTitle(content: string): string {
	const normalized = content.trim().replace(/\s+/g, " ");
	return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}

function handleTransportEvent({
	event,
	activeSessionId,
	applyMessageUpdate,
	lastSubmittedText,
	setActiveResponse,
	setAnnouncement,
	setIsStopping,
	setNotice,
	t,
}: {
	event: ChatTransportEvent;
	activeSessionId: string | null;
	applyMessageUpdate(messageId: string, updater: (message: ChatMessage) => ChatMessage): void;
	lastSubmittedText: string | null;
	setActiveResponse(value: ActiveResponse | null): void;
	setAnnouncement(value: string): void;
	setIsStopping(value: boolean): void;
	setNotice(value: ChatNotice | null): void;
	t(key: MessageKey, ...params: string[]): string;
}) {
	if (activeSessionId !== event.sessionId) {
		return;
	}

	switch (event.type) {
		case "response.delta":
			applyMessageUpdate(event.messageId, (message) => ({
				...message,
				content: `${message.content}${event.delta}`,
				status: "streaming",
			}));
			setAnnouncement(t("chat.status.streaming"));
			break;
		case "response.completed":
			applyMessageUpdate(event.messageId, (message) => ({
				...message,
				content: event.content,
				status: "completed",
			}));
			setActiveResponse(null);
			setIsStopping(false);
			setAnnouncement(t("chat.status.completed"));
			break;
		case "response.cancelled":
			applyMessageUpdate(event.messageId, (message) => ({
				...message,
				content: event.content ?? message.content,
				status: "cancelled",
				errorMessage: event.reason,
			}));
			setActiveResponse(null);
			setIsStopping(false);
			setNotice({
				tone: "info",
				message: t("chat.notice.stopped"),
				action: lastSubmittedText ? "retry-send" : undefined,
			});
			setAnnouncement(t("chat.status.stopped"));
			break;
		case "response.error":
			applyMessageUpdate(event.messageId, (message) => ({
				...message,
				content: event.content,
				status: "error",
				errorMessage: event.message,
			}));
			setActiveResponse(null);
			setIsStopping(false);
			setNotice({
				tone: "danger",
				message: event.message,
				action: lastSubmittedText ? "retry-send" : undefined,
			});
			setAnnouncement(t("chat.status.failed"));
			break;
	}
}

function mergeAcceptedMessages(
	currentMessages: ChatMessage[],
	userMessage: ChatMessage,
	assistantMessage: ChatMessage,
): ChatMessage[] {
	const acceptedIds = new Set([userMessage.id, assistantMessage.id]);
	const existingById = new Map(currentMessages.map((message) => [message.id, message]));
	const existingUserMessage = existingById.get(userMessage.id);
	const existingAssistantMessage = existingById.get(assistantMessage.id);
	const mergedAssistantMessage =
		existingAssistantMessage === undefined
			? assistantMessage
			: assistantMessage.status !== "streaming"
				? existingAssistantMessage.status === "streaming"
					? assistantMessage
					: existingAssistantMessage
				: existingAssistantMessage.status !== "streaming"
					? existingAssistantMessage
					: {
							...assistantMessage,
							...existingAssistantMessage,
							createdAt: assistantMessage.createdAt,
							content: existingAssistantMessage.content || assistantMessage.content,
						};

	return [
		...currentMessages.filter((message) => !acceptedIds.has(message.id)),
		existingUserMessage ?? userMessage,
		mergedAssistantMessage,
	];
}

function orderBufferedTransportEvents(events: ChatTransportEvent[]): ChatTransportEvent[] {
	const grouped = new Map<string, Array<{ event: ChatTransportEvent; index: number }>>();
	for (const [index, event] of events.entries()) {
		const group = grouped.get(event.requestId) ?? [];
		group.push({ event, index });
		grouped.set(event.requestId, group);
	}

	return [...grouped.values()].flatMap((group) =>
		group
			.sort((left, right) => {
				if (left.event.sequence === undefined || right.event.sequence === undefined) {
					return left.index - right.index;
				}
				return left.event.sequence - right.event.sequence;
			})
			.map(({ event }) => event),
	);
}

function isTerminalTransportEvent(
	event: ChatTransportEvent,
): event is Extract<
	ChatTransportEvent,
	{ type: "response.completed" | "response.cancelled" | "response.error" }
> {
	return (
		event.type === "response.completed" ||
		event.type === "response.cancelled" ||
		event.type === "response.error"
	);
}

function getErrorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
