import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, useI18n } from "../i18n";
import {
	type ChatMessage,
	type ChatProviderStatus,
	type ChatSession,
	type ChatSessionSummary,
	type ChatTransport,
	type ChatTransportEvent,
	DEFAULT_PROVIDER_ENDPOINT,
} from "./transport";

interface UseChatControllerOptions {
	transport: ChatTransport;
	sessionId?: string;
	onSessionChange?(sessionId: string): void;
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

export function useChatController({
	transport,
	sessionId,
	onSessionChange,
}: UseChatControllerOptions) {
	const { t } = useI18n();
	const [providerStatus, setProviderStatus] = useState<ChatProviderStatus | null>(null);
	const [isProviderLoading, setIsProviderLoading] = useState(true);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [session, setSession] = useState<ChatSession | null>(null);
	const [isSessionLoading, setIsSessionLoading] = useState(false);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState<ChatNotice | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [activeResponse, setActiveResponse] = useState<ActiveResponse | null>(null);
	const [isSending, setIsSending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const providerLoadToken = useRef(0);
	const sessionLoadToken = useRef(0);
	const sendGenerationRef = useRef(0);
	const sendInFlightRef = useRef(false);
	const activeSessionIdRef = useRef<string | null>(null);
	const lastSubmittedTextRef = useRef<string | null>(null);
	const hydratedSessionIdRef = useRef<string | null>(null);
	const bufferedEventsRef = useRef<ChatTransportEvent[]>([]);
	const eventCursorsRef = useRef<Record<string, number>>({});
	const unroutedSessionIdRef = useRef<string | null>(null);
	const acceptedRequestIdsRef = useRef(new Set<string>());
	const terminalEventsBeforeAcceptanceRef = useRef(new Set<string>());

	activeSessionIdRef.current = sessionId ?? session?.id ?? null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId invalidates pending sends.
	useEffect(() => {
		sendGenerationRef.current += 1;
		sendInFlightRef.current = false;
		lastSubmittedTextRef.current = null;
		setIsSending(false);
		setDraft("");

		return () => {
			sendGenerationRef.current += 1;
			sendInFlightRef.current = false;
			lastSubmittedTextRef.current = null;
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

			applyTransportEvent(event);
		},
		[applyTransportEvent],
	);

	const loadSession = useCallback(
		async (requestedSessionId: string) => {
			const loadToken = sessionLoadToken.current + 1;
			sessionLoadToken.current = loadToken;
			hydratedSessionIdRef.current = null;
			bufferedEventsRef.current = [];
			eventCursorsRef.current = {};
			acceptedRequestIdsRef.current.clear();
			terminalEventsBeforeAcceptanceRef.current.clear();
			setIsSessionLoading(true);
			setSession(null);
			setActiveResponse(null);
			setIsStopping(false);
			setNotice(null);
			setAnnouncement(t("chat.status.loadingHistory"));

			try {
				const nextSession = await transport.getSession(requestedSessionId);
				if (sessionLoadToken.current !== loadToken) {
					return;
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
				const bufferedEvents = bufferedEventsRef.current;
				bufferedEventsRef.current = [];
				for (const event of bufferedEvents) {
					if (event.sessionId === requestedSessionId) {
						applyTransportEventIfNew(event);
					}
				}
				setAnnouncement(t("chat.status.historyReady"));
			} catch (error) {
				if (sessionLoadToken.current !== loadToken) {
					return;
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
			} finally {
				if (sessionLoadToken.current === loadToken) {
					setIsSessionLoading(false);
				}
			}
		},
		[applyTransportEventIfNew, t, transport],
	);

	const loadProviderStatus = useCallback(async () => {
		const loadToken = providerLoadToken.current + 1;
		providerLoadToken.current = loadToken;
		setIsProviderLoading(true);
		setProviderError(null);
		setAnnouncement(t("chat.status.loadingProvider"));

		try {
			const nextStatus = await transport.getProviderStatus();
			if (providerLoadToken.current !== loadToken) {
				return;
			}

			setProviderStatus(nextStatus);
			setAnnouncement(
				nextStatus.configured ? t("chat.status.providerReady") : t("chat.status.providerNeeded"),
			);
		} catch (error) {
			if (providerLoadToken.current !== loadToken) {
				return;
			}

			setProviderStatus(null);
			setProviderError(getErrorMessage(error, t("chat.error.providerStatus")));
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
		if (!sessionId) {
			return;
		}

		void loadSession(sessionId);
	}, [loadSession, sessionId]);

	useEffect(() => {
		return transport.subscribe((event) => {
			if (activeSessionIdRef.current !== event.sessionId) {
				return;
			}

			if (isTerminalTransportEvent(event)) {
				if (acceptedRequestIdsRef.current.has(event.requestId)) {
					acceptedRequestIdsRef.current.delete(event.requestId);
				} else {
					terminalEventsBeforeAcceptanceRef.current.add(event.requestId);
				}
			}

			if (hydratedSessionIdRef.current !== event.sessionId) {
				bufferedEventsRef.current.push(event);
				return;
			}

			applyTransportEventIfNew(event);
		});
	}, [applyTransportEventIfNew, transport]);

	const hasConfiguredProvider = providerStatus?.configured ?? false;
	const meta = useMemo(
		() => ({
			model: session?.model || providerStatus?.model || t("chat.meta.pending"),
			askMode: session?.askMode || providerStatus?.askMode || t("chat.meta.pending"),
			endpoint: providerStatus?.endpoint || DEFAULT_PROVIDER_ENDPOINT,
		}),
		[providerStatus?.askMode, providerStatus?.endpoint, providerStatus?.model, session, t],
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
			let operationSessionId = startingSessionId;
			sendInFlightRef.current = true;
			setIsSending(true);
			setNotice(null);
			lastSubmittedTextRef.current = content;
			setAnnouncement(t("chat.status.sending"));

			try {
				let activeSession = session;
				let createdSession = false;
				if (!activeSession) {
					activeSession = await transport.createSession();
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
					sessionId: activeSession.id,
					message: content,
				});
				if (
					sendGenerationRef.current !== sendGeneration ||
					activeSessionIdRef.current !== operationSessionId
				) {
					return;
				}
				acceptedRequestIdsRef.current.add(result.requestId);
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
					completedBeforeAcceptance
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
				if (
					sendGenerationRef.current !== sendGeneration ||
					activeSessionIdRef.current !== operationSessionId
				) {
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
			draft,
			hasConfiguredProvider,
			isSessionLoading,
			onSessionChange,
			session,
			sessionId,
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
			if (
				sendGenerationRef.current !== stopGeneration ||
				activeSessionIdRef.current !== stopSessionId
			) {
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
	}, [activeResponse, isStopping, session, t, transport]);

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
		canSend,
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
		providerStatus,
		reloadProviderStatus: loadProviderStatus,
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

	return [
		...currentMessages.filter((message) => !acceptedIds.has(message.id)),
		existingUserMessage ?? userMessage,
		existingAssistantMessage === undefined
			? assistantMessage
			: {
					...assistantMessage,
					...existingAssistantMessage,
					createdAt: assistantMessage.createdAt,
					content: existingAssistantMessage.content || assistantMessage.content,
				},
	];
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
