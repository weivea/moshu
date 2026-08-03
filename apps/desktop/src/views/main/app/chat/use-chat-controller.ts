import type {
	AvailableModel,
	ChatRunSnapshot,
	DefaultModelSelection,
	ThinkingLevel,
} from "@moshu/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, useI18n } from "../i18n";
import { useChatSessionRecovery } from "./session-recovery-coordinator";
import { applyChatRunEvent, mergeChatRunSnapshot } from "./run-timeline-reducer";
import type {
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
	projectId?: string;
	expectedProjectId: string | undefined;
	interactionDisabledReason?: string;
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
	projectId,
	expectedProjectId,
	interactionDisabledReason,
	onSessionChange,
	onSessionHydrated,
	onSessionRetired,
}: UseChatControllerOptions) {
	const providedSession =
		initialSession !== undefined &&
		initialSession.id === sessionId &&
		initialSession.projectId === expectedProjectId
			? initialSession
			: undefined;
	const initialOwnershipMismatch =
		initialSession !== undefined &&
		initialSession.id === sessionId &&
		initialSession.projectId !== expectedProjectId;
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
	const [ownershipMismatch, setOwnershipMismatch] = useState(initialOwnershipMismatch);
	const [isSessionLoading, setIsSessionLoading] = useState(false);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState<ChatNotice | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [activeResponse, setActiveResponse] = useState<ActiveResponse | null>(
		providedSession?.activeResponse ?? null,
	);
	const [isSending, setIsSending] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const routeIdentity = `${sessionId ?? "new"}\u0000${expectedProjectId ?? "global"}`;
	const sessionStateRouteRef = useRef(routeIdentity);
	const preparedRouteRef = useRef(routeIdentity);
	const providerLoadToken = useRef(0);
	const sessionLoadToken = useRef(0);
	const sendGenerationRef = useRef(0);
	const sendRouteRef = useRef(routeIdentity);
	const sendInFlightRef = useRef(false);
	const activeSessionIdRef = useRef<string | null>(null);
	const lastSubmittedTextRef = useRef<string | null>(null);
	const lastSubmittedRequestIdRef = useRef<string | null>(null);
	const hydratedSessionIdRef = useRef<string | null>(null);
	const sessionHydrationRef = useRef<SessionHydration | null>(null);
	const bufferedEventsRef = useRef<ChatTransportEvent[]>([]);
	const eventCursorsRef = useRef<Record<string, number>>({});
	const knownRunIdsRef = useRef(new Set(providedSession?.runs.map((run) => run.id) ?? []));
	const unacceptedRunEventsRef = useRef(new Map<string, ChatTransportEvent[]>());
	const unroutedSessionIdRef = useRef<string | null>(null);
	const acceptedRequestIdsRef = useRef(
		new Set<string>(
			providedSession?.activeResponse === undefined
				? []
				: [providedSession.activeResponse.requestId],
		),
	);
	const terminalEventsBeforeAcceptanceRef = useRef(new Set<string>());
	if (preparedRouteRef.current !== routeIdentity) {
		preparedRouteRef.current = routeIdentity;
		sessionLoadToken.current += 1;
		sessionHydrationRef.current = null;
		sendGenerationRef.current += 1;
		sendRouteRef.current = routeIdentity;
		sendInFlightRef.current = false;
		lastSubmittedTextRef.current = null;
		lastSubmittedRequestIdRef.current = null;
		unroutedSessionIdRef.current = null;
		hydratedSessionIdRef.current = null;
		bufferedEventsRef.current =
			sessionId === undefined
				? []
				: bufferedEventsRef.current.filter((event) => event.sessionId === sessionId);
		eventCursorsRef.current = {};
		knownRunIdsRef.current.clear();
		unacceptedRunEventsRef.current.clear();
		acceptedRequestIdsRef.current.clear();
		terminalEventsBeforeAcceptanceRef.current.clear();
	}
	const routeStateMatches = sessionStateRouteRef.current === routeIdentity;
	const stateSessionMatches =
		routeStateMatches &&
		session !== null &&
		(sessionId === undefined || session.id === sessionId) &&
		session.projectId === expectedProjectId;
	const routedSession = stateSessionMatches ? session : (providedSession ?? null);
	const routedActiveResponse = stateSessionMatches
		? activeResponse
		: (providedSession?.activeResponse ?? null);
	const routedOwnershipMismatch = routeStateMatches ? ownershipMismatch : initialOwnershipMismatch;
	const routedDraft = routeStateMatches ? draft : "";

	activeSessionIdRef.current = sessionId ?? routedSession?.id ?? null;

	useEffect(() => {
		sendRouteRef.current = routeIdentity;
		sendGenerationRef.current += 1;
		sendInFlightRef.current = false;
		lastSubmittedTextRef.current = null;
		lastSubmittedRequestIdRef.current = null;
		setIsSending(false);
		setDraft("");
		setPendingModel(null);

		return () => {
			sendGenerationRef.current += 1;
			sendInFlightRef.current = false;
			lastSubmittedTextRef.current = null;
			lastSubmittedRequestIdRef.current = null;
		};
	}, [routeIdentity]);

	const applyRunUpdate = useCallback(
		(runId: string, updater: (run: ChatRunSnapshot) => ChatRunSnapshot) => {
			setSession((currentSession) => {
				if (!currentSession) {
					return currentSession;
				}

				if (!currentSession.runs.some((run) => run.id === runId)) {
					return currentSession;
				}

				return {
					...currentSession,
					runs: currentSession.runs.map((run) => (run.id === runId ? updater(run) : run)),
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
				applyRunUpdate,
				setActiveResponse,
				setAnnouncement,
				setIsStopping,
				setNotice,
				t,
				lastSubmittedText: lastSubmittedTextRef.current,
			});
		},
		[applyRunUpdate, t],
	);

	const applyTransportEventIfNew = useCallback(
		(event: ChatTransportEvent) => {
			const lastSequence = eventCursorsRef.current[event.runId] ?? 0;
			if (event.seq <= lastSequence) {
				return;
			}
			eventCursorsRef.current[event.runId] = event.seq;
			if (!knownRunIdsRef.current.has(event.runId)) {
				const queued = unacceptedRunEventsRef.current.get(event.runId) ?? [];
				queued.push(event);
				unacceptedRunEventsRef.current.set(event.runId, queued);
				if (isTerminalTransportEvent(event)) {
					terminalEventsBeforeAcceptanceRef.current.add(event.runId);
				}
				return;
			}

			if (isTerminalTransportEvent(event)) {
				if (acceptedRequestIdsRef.current.has(event.runId)) {
					acceptedRequestIdsRef.current.delete(event.runId);
				} else {
					terminalEventsBeforeAcceptanceRef.current.add(event.runId);
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
			knownRunIdsRef.current.clear();
			unacceptedRunEventsRef.current.clear();
			acceptedRequestIdsRef.current.clear();
			terminalEventsBeforeAcceptanceRef.current.clear();
			unroutedSessionIdRef.current = null;
			lastSubmittedTextRef.current = null;
			lastSubmittedRequestIdRef.current = null;
			setSession(null);
			setOwnershipMismatch(false);
			setActiveResponse(null);
			setPendingModel(null);
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
			sessionStateRouteRef.current = routeIdentity;
			hydratedSessionIdRef.current = null;
			bufferedEventsRef.current = bufferedEventsRef.current.filter(
				(event) => event.sessionId === requestedSessionId,
			);
			eventCursorsRef.current = {};
			knownRunIdsRef.current.clear();
			unacceptedRunEventsRef.current.clear();
			acceptedRequestIdsRef.current.clear();
			terminalEventsBeforeAcceptanceRef.current.clear();
			setIsSessionLoading(true);
			setOwnershipMismatch(false);
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

				acceptedRequestIdsRef.current.clear();
				terminalEventsBeforeAcceptanceRef.current.clear();
				unroutedSessionIdRef.current = null;
				const bufferedEvents = orderBufferedTransportEvents(bufferedEventsRef.current);
				bufferedEventsRef.current = [];
				if (nextSession.projectId !== expectedProjectId) {
					setSession(null);
					setActiveResponse(null);
					eventCursorsRef.current = {};
					knownRunIdsRef.current.clear();
					unacceptedRunEventsRef.current.clear();
					hydratedSessionIdRef.current = null;
					setOwnershipMismatch(true);
				} else {
					setSession(nextSession);
					knownRunIdsRef.current = new Set(nextSession.runs.map((run) => run.id));
					unacceptedRunEventsRef.current.clear();
					setActiveResponse(nextSession.activeResponse ?? null);
					if (nextSession.activeResponse !== undefined) {
						acceptedRequestIdsRef.current.add(nextSession.activeResponse.requestId);
					}
					eventCursorsRef.current = Object.fromEntries(
						nextSession.runs.map((run) => [run.id, run.lastEventSeq]),
					);
					hydratedSessionIdRef.current = requestedSessionId;
					for (const event of bufferedEvents) {
						if (event.sessionId === requestedSessionId) {
							applyTransportEventIfNew(event);
						}
					}
					onSessionHydrated?.(requestedSessionId);
					setOwnershipMismatch(false);
				}
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
				setOwnershipMismatch(false);
				hydratedSessionIdRef.current = null;
				bufferedEventsRef.current = [];
				eventCursorsRef.current = {};
				knownRunIdsRef.current.clear();
				unacceptedRunEventsRef.current.clear();
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
		[
			applyTransportEventIfNew,
			expectedProjectId,
			onSessionHydrated,
			routeIdentity,
			sessionRecoveryCoordinator,
			t,
			transport,
		],
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
		if (routedOwnershipMismatch) {
			return;
		}
		return transport.subscribe((event) => {
			if (activeSessionIdRef.current !== event.sessionId) {
				return;
			}

			if (hydratedSessionIdRef.current !== event.sessionId) {
				bufferedEventsRef.current.push(event);
				return;
			}

			if (!knownRunIdsRef.current.has(event.runId)) {
				if (event.clientRequestId === lastSubmittedRequestIdRef.current) {
					applyTransportEventIfNew(event);
					return;
				}
				bufferedEventsRef.current.push(event);
				void loadSession(event.sessionId, false, undefined, true);
				return;
			}
			applyTransportEventIfNew(event);
		});
	}, [applyTransportEventIfNew, loadSession, routedOwnershipMismatch, transport]);

	useEffect(() => {
		if (sessionId !== undefined) {
			return;
		}
		sessionLoadToken.current += 1;
		sessionStateRouteRef.current = routeIdentity;
		hydratedSessionIdRef.current = null;
		sessionHydrationRef.current = null;
		bufferedEventsRef.current = [];
		eventCursorsRef.current = {};
		knownRunIdsRef.current.clear();
		unacceptedRunEventsRef.current.clear();
		acceptedRequestIdsRef.current.clear();
		terminalEventsBeforeAcceptanceRef.current.clear();
		setSession(null);
		setOwnershipMismatch(false);
		setActiveResponse(null);
		setIsSessionLoading(false);
		setIsStopping(false);
		setNotice(null);
		setAnnouncement("");
	}, [routeIdentity, sessionId]);

	useEffect(() => {
		if (!sessionId) {
			return;
		}

		activeSessionIdRef.current = sessionId;
		void loadSession(sessionId, false, providedSession);
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
	}, [loadSession, providedSession, sessionId]);

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
		() =>
			routedSession?.model ??
			(routeStateMatches ? pendingModel : null) ??
			defaultModel ??
			undefined,
		[defaultModel, pendingModel, routeStateMatches, routedSession?.model],
	);
	const selectedModel = useMemo(
		() => resolveSelectedModel(availableModels, modelSelection),
		[availableModels, modelSelection],
	);
	const meta = useMemo(
		() => ({
			model: selectedModel?.model.displayName ?? selectedModel?.model.id ?? t("chat.meta.pending"),
			askMode: routedSession?.askMode ?? "Ask",
			endpoint: selectedModel?.providerDisplayName ?? t("chat.meta.pending"),
		}),
		[routedSession?.askMode, selectedModel, t],
	);

	const changeSessionModel = useCallback(
		async (selection: SessionModelSelection | null) => {
			const targetSessionId = routedSession?.id ?? sessionId;
			if (targetSessionId === undefined) {
				setPendingModel(selection);
				return;
			}
			if (routedSession?.projectId !== expectedProjectId) {
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
		[expectedProjectId, routedSession?.id, routedSession?.projectId, sessionId, t, transport],
	);

	const canSend =
		hasConfiguredProvider &&
		interactionDisabledReason === undefined &&
		(sessionId === undefined || routedSession?.projectId === expectedProjectId) &&
		routeStateMatches &&
		!isSessionLoading &&
		!isSending &&
		(sessionId === undefined || routedSession?.id === sessionId) &&
		routedDraft.trim().length > 0 &&
		!routedActiveResponse;
	const isResponding = routedActiveResponse !== null;

	const sendMessage = useCallback(
		async (overrideText?: string) => {
			if (
				!hasConfiguredProvider ||
				interactionDisabledReason !== undefined ||
				(sessionId !== undefined && routedSession?.projectId !== expectedProjectId) ||
				routedActiveResponse ||
				isSessionLoading ||
				(sessionId !== undefined && routedSession?.id !== sessionId) ||
				sendInFlightRef.current
			) {
				return;
			}

			const content = (overrideText ?? routedDraft).trim();
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
				let activeSession = routedSession;
				let createdSession = false;
				if (!activeSession) {
					activeSession = await transport.createSession(modelSelection, projectId);
					if (activeSession.projectId !== expectedProjectId) {
						throw new Error("PROJECT_SESSION_MISMATCH: Created Session ownership is invalid.");
					}
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
					knownRunIdsRef.current.clear();
					unacceptedRunEventsRef.current.clear();
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
				let acceptedRun = result.run;
				const queuedEvents = unacceptedRunEventsRef.current.get(result.requestId) ?? [];
				for (const event of [...queuedEvents].sort((left, right) => left.seq - right.seq)) {
					acceptedRun = applyChatRunEvent(acceptedRun, event);
				}
				unacceptedRunEventsRef.current.delete(result.requestId);
				knownRunIdsRef.current.add(result.requestId);
				eventCursorsRef.current[result.requestId] = Math.max(
					eventCursorsRef.current[result.requestId] ?? 0,
					acceptedRun.lastEventSeq,
				);
				const acceptedAlreadyTerminal = isTerminalRun(acceptedRun);
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
							baseSession.runs.length === 0 && baseSession.title === "New chat"
								? createSessionTitle(content)
								: baseSession.title,
						updatedAt: new Date().toISOString(),
						runs: mergeChatRunSnapshot(baseSession.runs, acceptedRun),
					};
				});
				setActiveResponse(
					completedBeforeAcceptance || acceptedAlreadyTerminal
						? null
						: {
								requestId: result.requestId,
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
			clearInvalidatedSession,
			expectedProjectId,
			hasConfiguredProvider,
			interactionDisabledReason,
			isSessionLoading,
			modelSelection,
			onSessionChange,
			projectId,
			routedActiveResponse,
			routedDraft,
			routedSession,
			sessionId,
			sessionRecoveryCoordinator,
			t,
			transport,
		],
	);

	const stopMessage = useCallback(async () => {
		if (
			!routedSession ||
			routedSession.projectId !== expectedProjectId ||
			!routedActiveResponse ||
			isStopping
		) {
			return;
		}

		const stopGeneration = sendGenerationRef.current;
		const stopSessionId = routedSession.id;
		setIsStopping(true);
		setNotice(null);
		setAnnouncement(t("chat.status.stopping"));

		try {
			await transport.cancel({
				sessionId: routedSession.id,
				requestId: routedActiveResponse.requestId,
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
	}, [
		expectedProjectId,
		isStopping,
		routedActiveResponse,
		routedSession,
		sessionRecoveryCoordinator,
		t,
		transport,
	]);

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
		announcement: routeStateMatches ? announcement : "",
		availableModels,
		canSend,
		changeSessionModel,
		modelSelection,
		draft: routedDraft,
		hasConfiguredProvider,
		isProviderLoading,
		isResponding,
		isSending: routeStateMatches ? isSending : false,
		isSessionLoading: routeStateMatches ? isSessionLoading : sessionId !== undefined,
		isStopping: routeStateMatches ? isStopping : false,
		meta,
		notice: routeStateMatches ? notice : null,
		ownershipMismatch: routedOwnershipMismatch,
		providerError,
		reloadProviderStatus: loadProviderStatus,
		selectedModel,
		retryNoticeAction,
		sendMessage,
		session: routedSession,
		setDraft,
		stopMessage,
		updateSessionSummary: (updatedSession: ChatSessionSummary) => {
			if (sessionStateRouteRef.current === routeIdentity) {
				setSession((currentSession) => mergeSessionSummary(currentSession, updatedSession));
			}
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
	applyRunUpdate,
	lastSubmittedText,
	setActiveResponse,
	setAnnouncement,
	setIsStopping,
	setNotice,
	t,
}: {
	event: ChatTransportEvent;
	activeSessionId: string | null;
	applyRunUpdate(runId: string, updater: (run: ChatRunSnapshot) => ChatRunSnapshot): void;
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

	applyRunUpdate(event.runId, (run) => applyChatRunEvent(run, event));
	if (event.type === "run.warning") {
		setNotice({
			tone: "info",
			message: t("projects.chat.rootAgentsWarning", event.payload.reason),
		});
		setAnnouncement(t("projects.chat.rootAgentsWarning", event.payload.reason));
		return;
	}
	if (event.type === "run.error") {
		setNotice({
			tone: "danger",
			message: event.payload.error.safeMessage,
			action: lastSubmittedText ? "retry-send" : undefined,
		});
		setAnnouncement(t("chat.status.failed"));
		return;
	}
	if (event.type !== "run.status") {
		setAnnouncement(t("chat.status.streaming"));
		return;
	}
	switch (event.payload.status) {
		case "completed":
			setActiveResponse(null);
			setIsStopping(false);
			setAnnouncement(t("chat.status.completed"));
			return;
		case "cancelled":
			setActiveResponse(null);
			setIsStopping(false);
			setNotice({
				tone: "info",
				message: t("chat.notice.stopped"),
				action: lastSubmittedText ? "retry-send" : undefined,
			});
			setAnnouncement(t("chat.status.stopped"));
			return;
		case "failed":
			setActiveResponse(null);
			setIsStopping(false);
			setAnnouncement(t("chat.status.failed"));
			return;
		default:
			setAnnouncement(t("chat.status.streaming"));
	}
}

function orderBufferedTransportEvents(events: ChatTransportEvent[]): ChatTransportEvent[] {
	const grouped = new Map<string, Array<{ event: ChatTransportEvent; index: number }>>();
	for (const [index, event] of events.entries()) {
		const group = grouped.get(event.runId) ?? [];
		group.push({ event, index });
		grouped.set(event.runId, group);
	}

	return [...grouped.values()].flatMap((group) =>
		group
			.sort((left, right) => {
				return left.event.seq - right.event.seq || left.index - right.index;
			})
			.map(({ event }) => event),
	);
}

function isTerminalTransportEvent(
	event: ChatTransportEvent,
): event is Extract<ChatTransportEvent, { type: "run.status" }> {
	return (
		event.type === "run.status" &&
		(event.payload.status === "completed" ||
			event.payload.status === "failed" ||
			event.payload.status === "cancelled")
	);
}

function isTerminalRun(run: ChatRunSnapshot): boolean {
	return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

function getErrorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
