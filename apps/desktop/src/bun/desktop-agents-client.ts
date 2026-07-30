import {
	agentsProductEventMethods,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type CreateChatSessionOutput,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatEventDeliverySchema,
	chatSendAcceptedOutputSchema,
	chatSessionsRetiredEventSchema,
	chatSubscribeInputSchema,
	chatSubscribeOutputSchema,
	createChatSessionOutputSchema,
	createProcessChatSessionInputSchema,
	deleteChatSessionInputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	type ListRuntimeBoxesOutput,
	listRetiredChatSessionsInputSchema,
	listRetiredChatSessionsOutputSchema,
	listRuntimeBoxesOutputSchema,
	maxReplayRunCursors,
	maxRetainedSessionRetirements,
	maxRetiredSessionsPerRecoveryPage,
	productRpcEvents,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcMethods,
	type productRpcRequestSchemas,
	type ReplayCursorSupport,
	remoteAccessMutationMethods,
	remoteAccessMutationRpcTimeoutMs,
	replayChatEventsInputSchema,
	replayChatEventsOutputSchema,
	type SessionModelSelection,
	sendAskChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	updateChatSessionInputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import {
	type ConnectRpcClientOptions,
	connectRpcClient,
	createRpcBearerHandshakeHeaders,
	isSameRpcPeerIdentity,
	type JsonValue,
	RpcConnectionClosedError,
	RpcFrameTooLargeError,
	type RpcPeer,
	RpcRemoteError,
	RpcRequestLimitError,
	type RpcRequestOptions,
	RpcTimeoutError,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";
import type { ZodType, z } from "zod";
import {
	type AcknowledgeChatSessionInvalidationInput,
	acknowledgeChatSessionInvalidationInputSchema,
	type ChatSessionInvalidation,
	chatSessionInvalidationSchema,
} from "../shared/rpc";
import {
	AgentsUnavailableError,
	ChatSessionNotFoundError,
	chatSessionNotFoundCode,
	ProjectPreviewStaleError,
	projectPreviewStaleCode,
} from "../shared/rpc-errors";
import {
	SessionRetirementCache,
	type SessionRetirementCacheEntry,
	SessionRetirementCapacityError,
} from "../shared/session-retirement-cache";
import type {
	DesktopAgentsConnection,
	DesktopAgentsConnectOptions,
} from "./companion-process-supervisor";

type ChatEventListener = (event: ChatRunEvent) => void | PromiseLike<void>;
type ChatSessionInvalidationListener = (invalidation: ChatSessionInvalidation) => void;
type DesktopAgentsReadyListener = () => void;
type RuntimeBoxesChangedListener = (snapshot: ListRuntimeBoxesOutput) => void;
type ProductMethod = keyof typeof productRpcRequestSchemas;
const remoteAccessMutationMethodSet = new Set<string>(remoteAccessMutationMethods);
export type DesktopAgentsRpcPeer = Pick<RpcPeer, "close" | "remoteIdentity" | "request">;
export type DesktopAgentsPeerConnector = (
	options: ConnectRpcClientOptions,
) => Promise<DesktopAgentsRpcPeer>;

export interface DesktopAgentsRecoveryLimits {
	maxTrackedRunCursors?: number;
	maxPendingSessionCreates?: number;
	maxProvisionalEvents?: number;
	maxProvisionalBytes?: number;
	recoveryTimeoutMs?: number;
}

interface ResolvedDesktopAgentsRecoveryLimits {
	maxTrackedRunCursors: number;
	maxPendingSessionCreates: number;
	maxProvisionalEvents: number;
	maxProvisionalBytes: number;
	recoveryTimeoutMs: number;
}

interface ActiveRunCursor {
	sessionId: string;
	issuedAtMs: number;
	lastSeq: number;
	messageTerminal: boolean;
	runTerminal: boolean;
	reservation: SendReservation;
}

interface ProvisionalEventQueue {
	events: ChatRunEvent[];
	encodedBytes: number;
}

interface SendReservation {
	requestId: string;
	sessionId: string;
	content: string;
	runId?: string;
	retired: boolean;
	terminal: boolean;
}

interface SessionOperation {
	readonly sessionId: string;
	retired: boolean;
}

interface PendingSessionInvalidation {
	connectionGeneration: number;
	sessionId: string;
	retirement?: SessionRetirementCacheEntry<SessionRetirementState>;
	retirementGeneration?: number;
	resolve(): void;
	reject(error: Error): void;
}

interface SessionRetirementState {
	readonly generation: number;
	status: "pending" | "finalized";
}

interface SessionCreateReservation {
	readonly createKey: string;
	readonly input: z.output<typeof createProcessChatSessionInputSchema>;
	ambiguousDispatch: boolean;
	dispatchGeneration: number;
	boundSessionId?: string;
	execution?: Promise<CreateChatSessionOutput>;
}

interface RecoveredSessionCreate {
	readonly output: CreateChatSessionOutput;
}

type RecoverableProductMethod =
	| typeof productRpcMethods.chatSend
	| typeof productRpcMethods.sessionCreate;
type RemoteOperationErrorDisposition = "ambiguous" | "definitive-rejection" | "session-retired";

// Only errors that either precede the handler or follow a durable key lookup that proved no
// matching operation exists may release recovery state. Unknown codes stay ambiguous by default.
const remoteOperationErrorDispositions: Record<
	RecoverableProductMethod,
	Readonly<Record<string, RemoteOperationErrorDisposition>>
> = {
	[productRpcMethods.chatSend]: {
		INVALID_ARGUMENT: "definitive-rejection",
		RUNTIME_BOX_NOT_READY: "definitive-rejection",
		SESSION_NOT_FOUND: "session-retired",
	},
	[productRpcMethods.sessionCreate]: {
		INVALID_ARGUMENT: "definitive-rejection",
		RUNTIME_BOX_NOT_READY: "definitive-rejection",
		PROJECT_NOT_FOUND: "definitive-rejection",
		PROJECT_ARCHIVED: "definitive-rejection",
		PROJECT_RUNTIME_UNAVAILABLE: "definitive-rejection",
		PROJECT_PATH_UNAVAILABLE: "definitive-rejection",
		SESSION_CREATE_KEY_CONFLICT: "definitive-rejection",
		SESSION_CREATE_CAPACITY: "definitive-rejection",
	},
};

const defaultRecoveryLimits: ResolvedDesktopAgentsRecoveryLimits = {
	maxTrackedRunCursors: 256,
	maxPendingSessionCreates: 8,
	maxProvisionalEvents: 128,
	maxProvisionalBytes: 2 * 1024 * 1024,
	recoveryTimeoutMs: 15_000,
};

export { AgentsUnavailableError } from "../shared/rpc-errors";

export class DesktopAgentsClient {
	#peer: DesktopAgentsRpcPeer | null = null;
	#provisionalPeer: DesktopAgentsRpcPeer | null = null;
	#closeActiveConnection: (() => void) | null = null;
	#connecting = false;
	#shutdown = false;
	readonly #chatEventListeners = new Set<ChatEventListener>();
	readonly #chatSessionInvalidationListeners = new Set<ChatSessionInvalidationListener>();
	readonly #readyListeners = new Set<DesktopAgentsReadyListener>();
	readonly #runtimeBoxesChangedListeners = new Set<RuntimeBoxesChangedListener>();
	readonly #activeRunCursors = new Map<string, ActiveRunCursor>();
	readonly #sendReservations = new Map<string, SendReservation>();
	readonly #runReservations = new Map<string, SendReservation>();
	readonly #runSessionRoutes = new Map<string, string>();
	readonly #pendingSessionCreates = new Map<string, SessionCreateReservation>();
	readonly #recoveredSessionCreates = new Map<string, RecoveredSessionCreate>();
	readonly #sessionRetirements: SessionRetirementCache<SessionRetirementState>;
	readonly #sessionOperations = new Set<SessionOperation>();
	readonly #pendingSessionInvalidations = new Map<string, PendingSessionInvalidation>();
	readonly #invalidatingSessionIds = new Set<string>();
	readonly #recoveryLimits: ResolvedDesktopAgentsRecoveryLimits;
	#implicitSessionCreateKey: string | undefined;
	#cursorSupportAnchor: { support: ReplayCursorSupport; observedAtLocalMs: number } | undefined;
	#nextConnectionGeneration = 0;
	#nextRetirementGeneration = 0;

	constructor(
		private readonly connectPeer: DesktopAgentsPeerConnector = connectRpcClient,
		recoveryLimits: DesktopAgentsRecoveryLimits = {},
		private readonly now: () => number = Date.now,
	) {
		this.#recoveryLimits = resolveRecoveryLimits(recoveryLimits);
		this.#sessionRetirements = new SessionRetirementCache({ now });
	}

	async connect(options: DesktopAgentsConnectOptions): Promise<DesktopAgentsConnection> {
		if (this.#shutdown) {
			throw new AgentsUnavailableError("The desktop agents client is shutting down.");
		}
		if (this.#peer !== null || this.#connecting) {
			throw new Error("The desktop agents client is already connected.");
		}
		this.#connecting = true;
		const connectionGeneration = ++this.#nextConnectionGeneration;
		const recoveryDeadline = this.now() + this.#recoveryLimits.recoveryTimeoutMs;
		const provisionalQueue: ProvisionalEventQueue = { events: [], encodedBytes: 0 };
		let resolveClosed: (() => void) | undefined;
		let connectionClosed = false;
		let connectionActive = false;
		let peerCloseIssued = false;
		let provisionalFailure: Error | null = null;
		let peer: DesktopAgentsRpcPeer | undefined;
		let deliveryTail = Promise.resolve();
		let retirementDeliveryTail = Promise.resolve();
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});

		const markExactPeerClosed = (): void => {
			if (this.#peer === peer) {
				this.#peer = null;
				this.#closeActiveConnection = null;
			}
			if (this.#provisionalPeer === peer) {
				this.#provisionalPeer = null;
			}
			connectionClosed = true;
			this.#rejectInvalidationAttempts(
				connectionGeneration,
				new AgentsUnavailableError("The local agents connection closed during recovery."),
			);
			resolveClosed?.();
		};
		const closeExactPeer = (reason: string): void => {
			markExactPeerClosed();
			if (peer !== undefined && !peerCloseIssued) {
				peerCloseIssued = true;
				peer?.close(1000, reason);
			}
		};
		const deliver = (event: ChatRunEvent, deadline?: number): Promise<void> => {
			const operation = deliveryTail.then(async () => {
				if (connectionClosed) {
					throw new AgentsUnavailableError("The local agents connection closed.");
				}
				await this.#deliverThenCommit(event, deadline, !connectionActive);
			});
			deliveryTail = operation.catch(() => undefined);
			return operation;
		};
		const deliverRetirements = (sessionIds: readonly string[]): Promise<void> => {
			const operation = retirementDeliveryTail.then(async () => {
				if (connectionClosed) {
					throw new AgentsUnavailableError("The local agents connection closed.");
				}
				const deadline = this.now() + this.#recoveryLimits.recoveryTimeoutMs;
				const retirements = this.#stagePendingSessionRetirementBatch(sessionIds);
				for (const retirement of retirements) {
					await this.#invalidatePendingSessionRetirement(
						retirement,
						deadline,
						connectionGeneration,
					);
				}
			});
			retirementDeliveryTail = operation.catch(() => undefined);
			return operation;
		};

		try {
			peer = await this.connectPeer({
				url: createAgentsServerUrl(options.agentsServer.endpoint),
				identity: options.identity,
				expectedServerIdentity: options.agentsServer.serverIdentity,
				getHandshakeHeaders: createRpcBearerHandshakeHeaders(options.credential),
				handlers: {
					events: {
						[agentsProductEventMethods[0]]: async (payload) => {
							try {
								const delivery = chatEventDeliverySchema.parse(payload);
								const event = this.#bindEventDelivery(delivery);
								if (event === null) {
									return;
								}
								if (!connectionActive) {
									enqueueProvisionalEvent(provisionalQueue, event, this.#recoveryLimits);
									return;
								}
								await deliver(event);
							} catch (error) {
								provisionalFailure = toRecoveryError(error);
								closeExactPeer("Chat event delivery failed.");
								throw new Error("Chat event delivery failed.");
							}
						},
						[productRpcEvents.chatSessionsRetired]: async (payload) => {
							try {
								const event = chatSessionsRetiredEventSchema.parse(payload);
								if (!connectionActive) {
									this.#stagePendingSessionRetirementBatch(event.sessionIds);
									return;
								}
								await deliverRetirements(event.sessionIds);
							} catch (error) {
								provisionalFailure = toRecoveryError(error);
								closeExactPeer("Session retirement delivery failed.");
								throw new Error("Session retirement delivery failed.");
							}
						},
						[productRpcEvents.runtimeBoxesChanged]: (payload) => {
							const snapshot = listRuntimeBoxesOutputSchema.parse(payload);
							for (const listener of this.#runtimeBoxesChangedListeners) {
								listener(snapshot);
							}
						},
					},
				},
				methodAllowlist: {
					agents: { events: agentsProductEventMethods },
				},
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
				requestTimeoutLimits: Object.fromEntries(
					remoteAccessMutationMethods.map((method) => [method, remoteAccessMutationRpcTimeoutMs]),
				),
				onClose: markExactPeerClosed,
			});
			if (!isSameRpcPeerIdentity(peer.remoteIdentity, options.agentsServer.serverIdentity)) {
				throw new AgentsUnavailableError(
					"The local agents server identity did not match its bootstrap record.",
				);
			}
			this.#provisionalPeer = peer;
			if (this.#shutdown) {
				throw new AgentsUnavailableError("The desktop agents client is shutting down.");
			}
			if (provisionalFailure !== null) {
				throw provisionalFailure;
			}
			await this.#readCursorSupport(peer, recoveryDeadline);
			await this.#recoverRetiredSessions(peer, recoveryDeadline, connectionGeneration);
			await this.#retryPendingSessionRetirements(recoveryDeadline, connectionGeneration);
			await this.#installLiveSubscriptions(peer, recoveryDeadline, connectionGeneration);
			await this.#replayProgressively(peer, recoveryDeadline, connectionGeneration, deliver);
			await this.#flushProvisionalEvents(provisionalQueue, recoveryDeadline, deliver);
			this.#deleteCommittedTerminalCursors();
			await this.#reconcileUnboundReservations(peer, recoveryDeadline, connectionGeneration);
			await this.#reconcilePendingSessionCreates(peer, recoveryDeadline);
			if (this.#shutdown || connectionClosed) {
				throw new AgentsUnavailableError("The local agents service disconnected during recovery.");
			}
			this.#assertRecoveryDeadline(recoveryDeadline);
			// Atomic drain-and-activate fence. Drain provisional chat events AND pending Session
			// retirements together until BOTH are quiescent, because either can be produced during the
			// other's renderer await (a retirement staged mid chat-event flush; a chat event enqueued mid
			// retirement finalization). This unified loop is the LAST await before the connection is
			// marked active: because no await follows it, nothing can be enqueued-then-stranded between
			// reaching quiescence and the synchronous flip below. Any event that arrives while
			// connectionActive is still false is therefore drained here or delivered live after the flip;
			// events that straddle the boundary still commit exactly once via the per-run cursor in
			// #deliverThenCommit.
			await this.#drainRecoveryUntilQuiescent(
				provisionalQueue,
				recoveryDeadline,
				connectionGeneration,
				deliver,
			);
			this.#deleteCommittedTerminalCursors();
			if (this.#shutdown || connectionClosed) {
				throw new AgentsUnavailableError("The local agents service disconnected during recovery.");
			}
			this.#provisionalPeer = null;
			this.#peer = peer;
			this.#closeActiveConnection = () => closeExactPeer("Desktop agents client closed.");
			connectionActive = true;
			for (const listener of [...this.#readyListeners]) {
				try {
					listener();
				} catch (error) {
					console.error("Desktop agents readiness listener failed.", error);
				}
			}
			return {
				closed,
				isClosed: () => connectionClosed,
				close: () => closeExactPeer("Desktop agents client closed."),
			};
		} catch (error) {
			closeExactPeer("Desktop agents connection recovery failed.");
			throw error instanceof AgentsUnavailableError
				? error
				: new AgentsUnavailableError("Failed to restore the local agents connection.", {
						cause: error,
					});
		} finally {
			this.#connecting = false;
		}
	}

	async createSession(
		createKey?: string,
		model?: SessionModelSelection,
		projectId?: string,
	): Promise<CreateChatSessionOutput> {
		const reservation = this.#getOrCreateSessionCreateReservation(createKey, model, projectId);
		const recovered = this.#recoveredSessionCreates.get(reservation.createKey);
		if (recovered !== undefined) {
			this.#recoveredSessionCreates.delete(reservation.createKey);
			this.#releaseSessionCreateReservation(reservation, true);
			if (this.#sessionRetirements.has(recovered.output.session.id)) {
				throw new ChatSessionNotFoundError();
			}
			return recovered.output;
		}
		const peer = this.#peer;
		if (peer === null) {
			throw new AgentsUnavailableError();
		}
		if (reservation.execution !== undefined) {
			return reservation.execution;
		}

		const execution = this.#requestSessionCreate(peer, reservation);
		reservation.execution = execution;
		try {
			const output = await execution;
			if (
				this.#pendingSessionCreates.get(reservation.createKey) === reservation &&
				reservation.boundSessionId === output.session.id
			) {
				this.#recoveredSessionCreates.delete(reservation.createKey);
				this.#releaseSessionCreateReservation(reservation, true);
			}
			return output;
		} catch (error) {
			if (
				((error instanceof RpcRemoteError &&
					classifyRemoteOperationError(productRpcMethods.sessionCreate, error) ===
						"definitive-rejection") ||
					(isDefiniteLocalRequestFailure(error) && !reservation.ambiguousDispatch)) &&
				!this.#recoveredSessionCreates.has(reservation.createKey)
			) {
				this.#releaseSessionCreateReservation(reservation);
			}
			if (isUnavailableTransportError(error)) {
				throw createTransportUnavailableError(error);
			}
			throw error;
		} finally {
			if (reservation.execution === execution) {
				reservation.execution = undefined;
			}
		}
	}

	async request<TInputSchema extends ZodType, TOutputSchema extends ZodType>(
		method: ProductMethod,
		input: z.input<TInputSchema>,
		inputSchema: TInputSchema,
		outputSchema: TOutputSchema,
		sessionIdHint?: string,
	): Promise<z.output<TOutputSchema>> {
		let peer = this.#peer;
		if (peer === null) {
			if (method === productRpcMethods.sessionGet) {
				const parsedRecoveryInput = getChatSessionPageInputSchema.safeParse(input);
				if (
					parsedRecoveryInput.success &&
					this.#invalidatingSessionIds.has(parsedRecoveryInput.data.sessionId)
				) {
					peer = this.#provisionalPeer;
				}
			} else if (
				method === productRpcMethods.sessionList &&
				this.#invalidatingSessionIds.size > 0
			) {
				peer = this.#provisionalPeer;
			}
		}
		if (peer === null) {
			throw new AgentsUnavailableError();
		}
		let sendReservation: SendReservation | undefined;
		let sessionOperation: SessionOperation | undefined;
		try {
			const parsedInput = inputSchema.parse(input);
			sessionOperation = this.#trackSessionOperation(method, parsedInput, sessionIdHint);
			if (
				sessionOperation !== undefined &&
				this.#sessionRetirements.has(sessionOperation.sessionId)
			) {
				sessionOperation.retired = true;
				throw new ChatSessionNotFoundError();
			}
			if (method === productRpcMethods.chatSend) {
				sendReservation = this.#getOrCreateSendReservation(
					sendAskChatMessageInputSchema.parse(parsedInput),
				);
			}
			const encodedInput = JSON.stringify(parsedInput);
			if (encodedInput === undefined) {
				throw new TypeError("Product RPC input is not JSON serializable.");
			}
			const payload = rpcJsonValueSchema.parse(JSON.parse(encodedInput));
			const response = await peer.request(
				method,
				payload,
				remoteAccessMutationMethodSet.has(method)
					? { timeoutMs: remoteAccessMutationRpcTimeoutMs }
					: undefined,
			);
			// A successful sessionDelete response is authoritative: the delete completed, and the server
			// broadcasts the resulting retirement to every peer — including this initiating peer, which may
			// observe it before the response settles. The delete operation therefore owns its own Session's
			// retirement and must not be rejected by it. Every other in-flight operation still fails closed
			// when its Session retires concurrently.
			if (
				method !== productRpcMethods.sessionDelete &&
				(sessionOperation?.retired ||
					(sessionOperation !== undefined &&
						this.#sessionRetirements.has(sessionOperation.sessionId)))
			) {
				throw new ChatSessionNotFoundError();
			}
			const output = outputSchema.parse(response);
			if (method === productRpcMethods.chatSend) {
				const accepted = chatSendAcceptedOutputSchema.parse(output);
				this.#acceptSendResponse(
					sendReservation ?? fail("Chat send response is missing its reservation."),
					accepted,
				);
			}
			this.#rememberRequestRunRoutes(method, sessionOperation?.sessionId, output);
			if (method === productRpcMethods.sessionDelete) {
				this.#retireSession(deleteChatSessionInputSchema.parse(parsedInput).sessionId);
			}
			return output;
		} catch (error) {
			if (error instanceof RpcRemoteError) {
				if (
					sendReservation !== undefined &&
					classifyRemoteOperationError(productRpcMethods.chatSend, error) ===
						"definitive-rejection" &&
					!this.#isSessionRetirementPending(sendReservation.sessionId)
				) {
					this.#discardSendReservation(sendReservation);
				}
				if (error.code === chatSessionNotFoundCode) {
					if (sessionOperation !== undefined) {
						if (!this.#isSessionRetirementPending(sessionOperation.sessionId)) {
							this.#retireSession(sessionOperation.sessionId);
						}
					}
					throw new ChatSessionNotFoundError(error.message, { cause: error });
				}
				if (error.code === projectPreviewStaleCode) {
					throw new ProjectPreviewStaleError(error.message, { cause: error });
				}
				throw error;
			}
			if (
				sendReservation !== undefined &&
				!this.#isSessionRetirementPending(sendReservation.sessionId) &&
				isDefiniteLocalRequestFailure(error)
			) {
				this.#discardSendReservation(sendReservation);
			}
			if (isUnavailableTransportError(error)) {
				throw createTransportUnavailableError(error);
			}
			throw error;
		} finally {
			if (sessionOperation !== undefined) {
				this.#sessionOperations.delete(sessionOperation);
			}
		}
	}

	#trackSessionOperation(
		method: ProductMethod,
		input: unknown,
		sessionIdHint?: string,
	): SessionOperation | undefined {
		let sessionId: string | undefined;
		switch (method) {
			case productRpcMethods.sessionGet:
				sessionId = getChatSessionPageInputSchema.parse(input).sessionId;
				break;
			case productRpcMethods.sessionUpdate:
				sessionId = updateChatSessionInputSchema.parse(input).sessionId;
				break;
			case productRpcMethods.sessionArchive:
				sessionId = setChatSessionArchivedInputSchema.parse(input).sessionId;
				break;
			case productRpcMethods.sessionDelete:
				sessionId = deleteChatSessionInputSchema.parse(input).sessionId;
				break;
			case productRpcMethods.chatSend:
				sessionId = sendAskChatMessageInputSchema.parse(input).sessionId;
				break;
			case productRpcMethods.chatCancel: {
				const runId = cancelChatRunInputSchema.parse(input).runId;
				sessionId =
					this.#runReservations.get(runId)?.sessionId ??
					this.#activeRunCursors.get(runId)?.sessionId ??
					this.#runSessionRoutes.get(runId);
				break;
			}
			case productRpcMethods.chatReplay:
				sessionId = replayChatEventsInputSchema.parse(input).cursors[0]?.sessionId;
				break;
		}
		if (sessionIdHint !== undefined) {
			if (method !== productRpcMethods.chatCancel) {
				throw new Error("Session context is only supported for Chat cancellation.");
			}
			const hintedSessionId = uuidV7Schema.parse(sessionIdHint);
			if (sessionId !== undefined && sessionId !== hintedSessionId) {
				throw new Error("Session-scoped Product RPC context did not match its request.");
			}
			sessionId = hintedSessionId;
		}
		if (method === productRpcMethods.chatCancel && sessionId === undefined) {
			throw new Error("Desktop Chat cancellation requires exact Session context.");
		}
		if (sessionId === undefined) {
			return undefined;
		}
		const operation: SessionOperation = { sessionId, retired: false };
		this.#sessionOperations.add(operation);
		return operation;
	}

	#rememberRequestRunRoutes(
		method: ProductMethod,
		sessionId: string | undefined,
		output: unknown,
	): void {
		if (method === productRpcMethods.sessionGet && sessionId !== undefined) {
			const page = getChatSessionPageOutputSchema.parse(output);
			for (const run of page.runs) {
				if (run.status === "queued" || run.status === "running" || run.status === "cancelling") {
					this.#rememberRunSessionRoute(run.id, sessionId);
				} else if (this.#runSessionRoutes.get(run.id) === sessionId) {
					this.#runSessionRoutes.delete(run.id);
				}
			}
			return;
		}
		if (method === productRpcMethods.chatCancel) {
			const { run } = cancelChatRunOutputSchema.parse(output);
			if (run.status === "queued" || run.status === "running" || run.status === "cancelling") {
				this.#rememberRunSessionRoute(run.id, run.sessionId);
			} else {
				this.#runSessionRoutes.delete(run.id);
			}
		}
	}

	#rememberRunSessionRoute(runId: string, sessionId: string): void {
		this.#runSessionRoutes.delete(runId);
		this.#runSessionRoutes.set(runId, sessionId);
		while (this.#runSessionRoutes.size > this.#recoveryLimits.maxTrackedRunCursors) {
			const oldestRunId = this.#runSessionRoutes.keys().next().value;
			if (oldestRunId === undefined) {
				break;
			}
			this.#runSessionRoutes.delete(oldestRunId);
		}
	}

	#getOrCreateSessionCreateReservation(
		createKey?: string,
		model?: SessionModelSelection,
		projectId?: string,
	): SessionCreateReservation {
		const selectedKey = createKey ?? this.#implicitSessionCreateKey ?? crypto.randomUUID();
		const parsedInput = createProcessChatSessionInputSchema.parse({
			schemaVersion: 1,
			createKey: selectedKey,
			title: "New chat",
			defaultMode: "agent",
			...(model === undefined ? {} : { model }),
			...(projectId === undefined ? {} : { projectId }),
		});
		const existing = this.#pendingSessionCreates.get(parsedInput.createKey);
		if (existing !== undefined) {
			if (existing.input.projectId !== parsedInput.projectId) {
				throw new Error("A Session create key cannot be reused for a different Project.");
			}
			return existing;
		}
		if (this.#recoveredSessionCreates.has(parsedInput.createKey)) {
			return {
				createKey: parsedInput.createKey,
				input: parsedInput,
				ambiguousDispatch: false,
				dispatchGeneration: 0,
			};
		}
		let retainedCreateCount = this.#pendingSessionCreates.size;
		for (const recoveredKey of this.#recoveredSessionCreates.keys()) {
			if (!this.#pendingSessionCreates.has(recoveredKey)) {
				retainedCreateCount += 1;
			}
		}
		if (retainedCreateCount >= this.#recoveryLimits.maxPendingSessionCreates) {
			throw new AgentsUnavailableError("The pending Session create recovery limit was exceeded.");
		}
		const reservation: SessionCreateReservation = {
			createKey: parsedInput.createKey,
			input: parsedInput,
			ambiguousDispatch: false,
			dispatchGeneration: 0,
		};
		this.#pendingSessionCreates.set(reservation.createKey, reservation);
		if (createKey === undefined) {
			this.#implicitSessionCreateKey = reservation.createKey;
		}
		return reservation;
	}

	async #requestSessionCreate(
		peer: DesktopAgentsRpcPeer,
		reservation: SessionCreateReservation,
		options?: RpcRequestOptions,
	): Promise<CreateChatSessionOutput> {
		const payload = rpcJsonValueSchema.parse(JSON.parse(JSON.stringify(reservation.input)));
		const dispatchGeneration = reservation.dispatchGeneration + 1;
		reservation.dispatchGeneration = dispatchGeneration;
		const wasAmbiguous = reservation.ambiguousDispatch;
		reservation.ambiguousDispatch = true;
		try {
			const output = createChatSessionOutputSchema.parse(
				await peer.request(productRpcMethods.sessionCreate, payload, options),
			);
			const isCurrent =
				this.#pendingSessionCreates.get(reservation.createKey) === reservation &&
				reservation.dispatchGeneration === dispatchGeneration;
			if (isCurrent) {
				if (
					reservation.boundSessionId !== undefined &&
					reservation.boundSessionId !== output.session.id
				) {
					throw new Error("A Session create reservation resolved to multiple Sessions.");
				}
				reservation.boundSessionId = output.session.id;
			}
			const retirement = this.#sessionRetirements.get(output.session.id);
			if (retirement !== undefined) {
				if (isCurrent) {
					reservation.boundSessionId = output.session.id;
					if (retirement.value.status === "finalized") {
						this.#recoveredSessionCreates.delete(reservation.createKey);
						this.#releaseSessionCreateReservation(reservation, true);
					}
				}
				throw new ChatSessionNotFoundError();
			}
			return output;
		} catch (error) {
			if (
				isDefiniteLocalRequestFailure(error) &&
				!wasAmbiguous &&
				reservation.dispatchGeneration === dispatchGeneration
			) {
				reservation.ambiguousDispatch = false;
			}
			throw error;
		}
	}

	#releaseSessionCreateReservation(
		reservation: SessionCreateReservation,
		consumeRecovered = false,
	): void {
		let releasedPending = false;
		if (this.#pendingSessionCreates.get(reservation.createKey) === reservation) {
			this.#pendingSessionCreates.delete(reservation.createKey);
			releasedPending = true;
		}
		if (
			(releasedPending ||
				(consumeRecovered && !this.#pendingSessionCreates.has(reservation.createKey))) &&
			this.#implicitSessionCreateKey === reservation.createKey
		) {
			this.#implicitSessionCreateKey = undefined;
		}
	}

	#getOrCreateSendReservation(
		input: z.output<typeof sendAskChatMessageInputSchema>,
	): SendReservation {
		const existing = this.#sendReservations.get(input.requestId);
		if (existing !== undefined) {
			if (existing.sessionId !== input.sessionId || existing.content !== input.content) {
				throw new Error("Chat send request ID was reused for different content.");
			}
			return existing;
		}
		if (this.#sendReservations.size >= this.#recoveryLimits.maxTrackedRunCursors) {
			throw new AgentsUnavailableError("The local agents recovery state limit was exceeded.");
		}
		const reservation: SendReservation = {
			requestId: input.requestId,
			sessionId: input.sessionId,
			content: input.content,
			retired: false,
			terminal: false,
		};
		this.#sendReservations.set(input.requestId, reservation);
		return reservation;
	}

	#acceptSendResponse(reservation: SendReservation, accepted: ChatSendAcceptedOutput): void {
		if (reservation.retired || this.#sessionRetirements.has(reservation.sessionId)) {
			throw new ChatSessionNotFoundError();
		}
		this.#bindReservationRun(reservation, accepted.run.id, accepted.run.sessionId);
		if (accepted.assistantMessage.status !== "streaming") {
			reservation.terminal = true;
		}
		if (!reservation.terminal && !this.#activeRunCursors.has(accepted.run.id)) {
			this.#activeRunCursors.set(accepted.run.id, {
				sessionId: accepted.run.sessionId,
				issuedAtMs: this.#estimatedServerTimeMs(),
				lastSeq: 0,
				messageTerminal: false,
				runTerminal: false,
				reservation,
			});
		}
		if (reservation.terminal) {
			this.#activeRunCursors.delete(accepted.run.id);
			this.#releaseSendReservation(reservation);
		}
	}

	#bindEventDelivery(delivery: z.output<typeof chatEventDeliverySchema>): ChatRunEvent | null {
		if (this.#sessionRetirements.has(delivery.event.sessionId)) {
			return null;
		}
		const reservation = this.#correlateDeliveryReservation(delivery);
		if (reservation === undefined) {
			throw new Error("Chat event correlation did not match an active send reservation.");
		}
		if (reservation.retired) {
			return null;
		}
		this.#bindReservationRun(reservation, delivery.event.runId, delivery.event.sessionId);
		if (reservation.terminal) {
			return null;
		}
		if (!reservation.terminal && !this.#activeRunCursors.has(delivery.event.runId)) {
			this.#activeRunCursors.set(delivery.event.runId, {
				sessionId: delivery.event.sessionId,
				issuedAtMs: this.#estimatedServerTimeMs(),
				lastSeq: 0,
				messageTerminal: false,
				runTerminal: false,
				reservation,
			});
		}
		return delivery.event;
	}

	#correlateDeliveryReservation(
		delivery: z.output<typeof chatEventDeliverySchema>,
	): SendReservation | undefined {
		// Correlate live events by their stable Run id first. This keeps delivery working without the
		// originating request id, which the Session-scoped event hub now treats as an optional echo.
		const runReservation = this.#runReservations.get(delivery.event.runId);
		if (runReservation !== undefined) {
			return runReservation;
		}
		const retainedCursor = this.#activeRunCursors.get(delivery.event.runId);
		if (retainedCursor !== undefined) {
			return retainedCursor.reservation;
		}
		// Fall back to the optional origin echo for the race where the first live event arrives before
		// the chat.send accept response has bound the Run id locally.
		const clientRequestId = delivery.clientRequestId;
		if (clientRequestId !== undefined) {
			return this.#sendReservations.get(clientRequestId);
		}
		return undefined;
	}

	#bindReservationRun(reservation: SendReservation, runId: string, sessionId: string): void {
		if (reservation.sessionId !== sessionId) {
			throw new Error("Chat send reservation Session did not match its Run.");
		}
		if (reservation.runId !== undefined && reservation.runId !== runId) {
			throw new Error("Chat send reservation was correlated to multiple Runs.");
		}
		reservation.runId = runId;
		this.#runReservations.set(runId, reservation);
	}

	#releaseSendReservation(reservation: SendReservation): void {
		if (this.#sendReservations.get(reservation.requestId) === reservation) {
			this.#sendReservations.delete(reservation.requestId);
		}
		if (
			reservation.runId !== undefined &&
			this.#runReservations.get(reservation.runId) === reservation
		) {
			this.#runReservations.delete(reservation.runId);
		}
	}

	#discardSendReservation(reservation: SendReservation): void {
		this.#releaseSendReservation(reservation);
		if (
			reservation.runId !== undefined &&
			this.#activeRunCursors.get(reservation.runId)?.reservation === reservation
		) {
			this.#activeRunCursors.delete(reservation.runId);
		}
	}

	subscribeChatEvents(listener: ChatEventListener): () => void {
		this.#chatEventListeners.add(listener);
		return () => {
			this.#chatEventListeners.delete(listener);
		};
	}

	subscribeRuntimeBoxesChanged(listener: RuntimeBoxesChangedListener): () => void {
		this.#runtimeBoxesChangedListeners.add(listener);
		return () => {
			this.#runtimeBoxesChangedListeners.delete(listener);
		};
	}

	subscribeChatSessionInvalidations(listener: ChatSessionInvalidationListener): () => void {
		this.#chatSessionInvalidationListeners.add(listener);
		return () => {
			this.#chatSessionInvalidationListeners.delete(listener);
		};
	}

	subscribeReady(listener: DesktopAgentsReadyListener): () => void {
		this.#readyListeners.add(listener);
		return () => {
			this.#readyListeners.delete(listener);
		};
	}

	acknowledgeChatSessionInvalidation(input: AcknowledgeChatSessionInvalidationInput): void {
		const parsedInput = acknowledgeChatSessionInvalidationInputSchema.parse(input);
		const pending = this.#pendingSessionInvalidations.get(parsedInput.invalidationId);
		if (pending === undefined || pending.sessionId !== parsedInput.sessionId) {
			throw new Error("Chat Session invalidation acknowledgement did not match a pending request.");
		}
		this.#pendingSessionInvalidations.delete(parsedInput.invalidationId);
		this.#releaseInvalidatingSessionId(pending.sessionId);
		if (parsedInput.accepted) {
			try {
				if (pending.retirement !== undefined) {
					this.#finalizePendingSessionRetirement(pending.retirement, pending.retirementGeneration);
				}
				pending.resolve();
			} catch (error) {
				pending.reject(toRecoveryError(error));
			}
			return;
		}
		pending.reject(
			new AgentsUnavailableError("The renderer could not refresh invalidated chat state."),
		);
	}

	close(): void {
		this.#shutdown = true;
		const closeActiveConnection = this.#closeActiveConnection;
		const provisionalPeer = this.#provisionalPeer;
		this.#closeActiveConnection = null;
		this.#peer = null;
		this.#provisionalPeer = null;
		for (const pending of this.#pendingSessionInvalidations.values()) {
			pending.reject(new AgentsUnavailableError("The desktop agents client is shutting down."));
		}
		this.#pendingSessionInvalidations.clear();
		this.#invalidatingSessionIds.clear();
		this.#activeRunCursors.clear();
		this.#sendReservations.clear();
		this.#runReservations.clear();
		this.#runSessionRoutes.clear();
		this.#pendingSessionCreates.clear();
		this.#recoveredSessionCreates.clear();
		this.#sessionRetirements.clear();
		this.#sessionOperations.clear();
		this.#implicitSessionCreateKey = undefined;
		this.#chatEventListeners.clear();
		this.#runtimeBoxesChangedListeners.clear();
		this.#chatSessionInvalidationListeners.clear();
		this.#readyListeners.clear();
		closeActiveConnection?.();
		provisionalPeer?.close(1000, "Provisional desktop agents client shutting down.");
	}

	/**
	 * Installs live Session subscriptions on the freshly connected peer BEFORE replay so the server
	 * routes live ChatRunEvents for every recovering Session into the provisional buffer while replay
	 * is still in flight. This is the head of the gap-free recovery loop:
	 * subscribe -> buffer live -> replay from durable cursor -> dedupe/merge by (runId, seq) -> flush
	 * -> ready. Because the subscription is armed at-or-before the replay snapshot boundary, any event
	 * committed after the snapshot is delivered live into the buffer, and any overlap with the replay
	 * response is deduplicated by the per-run cursor in #deliverThenCommit — so no event committed
	 * between the subscribe and the replay response is ever lost or double-delivered.
	 *
	 * A Session that has been retired since the last connection answers with SESSION_NOT_FOUND; that is
	 * expected and handled by the per-Run replay path below, so we skip it here rather than failing
	 * recovery.
	 */
	async #installLiveSubscriptions(
		peer: DesktopAgentsRpcPeer,
		deadline: number,
		connectionGeneration: number,
	): Promise<void> {
		const sessionIds = new Set<string>();
		for (const cursor of this.#activeRunCursors.values()) {
			if (!this.#sessionRetirements.has(cursor.sessionId)) {
				sessionIds.add(cursor.sessionId);
			}
		}
		for (const sessionId of sessionIds) {
			this.#assertRecoveryDeadline(deadline);
			if (this.#shutdown) {
				throw new AgentsUnavailableError("The desktop agents client is shutting down.");
			}
			const input = chatSubscribeInputSchema.parse({ sessionId });
			const encoded = rpcJsonValueSchema.parse(JSON.parse(JSON.stringify(input)));
			const remainingMs = Math.max(1, deadline - this.now());
			try {
				const response = await peer.request(productRpcMethods.chatSubscribe, encoded, {
					timeoutMs: remainingMs,
				});
				chatSubscribeOutputSchema.parse(response);
			} catch (error) {
				if (error instanceof RpcRemoteError && error.code === chatSessionNotFoundCode) {
					await this.#invalidatePendingSessionRetirement(
						this.#stagePendingSessionRetirement(sessionId),
						deadline,
						connectionGeneration,
					);
					continue;
				}
				throw error;
			}
		}
	}

	async #replayProgressively(
		peer: DesktopAgentsRpcPeer,
		deadline: number,
		connectionGeneration: number,
		deliver: (event: ChatRunEvent, deadline?: number) => Promise<void>,
	): Promise<void> {
		const iterator = this.#activeRunCursors.entries();
		while (true) {
			this.#assertRecoveryDeadline(deadline);
			const batch: Array<[string, ActiveRunCursor]> = [];
			while (batch.length < maxReplayRunCursors) {
				const next = iterator.next();
				if (next.done) {
					break;
				}
				batch.push(next.value);
			}
			if (batch.length === 0) {
				return;
			}
			const [runId, initialCursor] =
				batch[0] ?? fail("Replay batch unexpectedly contained no Run.");
			let lastSeq = initialCursor.lastSeq;
			let hasMore: boolean;
			do {
				const input = replayChatEventsInputSchema.parse({
					cursors: [
						{
							runId,
							sessionId: initialCursor.sessionId,
							issuedAtMs: initialCursor.issuedAtMs,
							lastSeq,
						},
					],
				});
				const encoded = rpcJsonValueSchema.parse(JSON.parse(JSON.stringify(input)));
				const remainingMs = Math.max(1, deadline - this.now());
				let response: JsonValue;
				try {
					response = await peer.request(productRpcMethods.chatReplay, encoded, {
						timeoutMs: remainingMs,
					});
				} catch (error) {
					if (error instanceof RpcRemoteError && error.code === chatSessionNotFoundCode) {
						await this.#invalidatePendingSessionRetirement(
							this.#stagePendingSessionRetirement(initialCursor.sessionId),
							deadline,
							connectionGeneration,
						);
						hasMore = false;
						break;
					}
					throw error;
				}
				const output = replayChatEventsOutputSchema.parse(response);
				this.#setCursorSupport(output.cursorSupport);
				if (output.retiredSessionIds.length > 0 && output.resnapshotSessionIds.length > 0) {
					throw new AgentsUnavailableError(
						"Agents replay returned contradictory cursor recovery instructions.",
					);
				}
				for (const retiredSessionId of output.retiredSessionIds) {
					if (retiredSessionId !== initialCursor.sessionId) {
						throw new AgentsUnavailableError("Agents replay returned an unknown retired Session.");
					}
					await this.#invalidatePendingSessionRetirement(
						this.#stagePendingSessionRetirement(retiredSessionId),
						deadline,
						connectionGeneration,
					);
				}
				for (const resnapshotSessionId of output.resnapshotSessionIds) {
					if (resnapshotSessionId !== initialCursor.sessionId) {
						throw new AgentsUnavailableError(
							"Agents replay returned an unknown Session resnapshot.",
						);
					}
					if (initialCursor.issuedAtMs > output.cursorSupport.oldestSupportedCursorIssuedAtMs) {
						throw new AgentsUnavailableError(
							"Agents replay attempted to resnapshot a cursor that is still supported.",
						);
					}
					await this.#invalidateSession(
						resnapshotSessionId,
						"history_expired",
						deadline,
						connectionGeneration,
					);
					this.#clearSessionRunState(resnapshotSessionId);
				}
				if (!this.#activeRunCursors.has(runId)) {
					hasMore = false;
					break;
				}
				for (const event of sortReplayEvents(output.events)) {
					if (event.runId !== runId) {
						throw new AgentsUnavailableError(
							"Agents replay returned an event for an unrequested Run.",
						);
					}
					await deliver(event, deadline);
					lastSeq = event.seq;
				}
				initialCursor.issuedAtMs = output.cursorSupport.serverTimeMs;
				if (output.hasMore && output.events.length === 0) {
					throw new AgentsUnavailableError(
						"Agents replay did not advance its continuation cursor.",
					);
				}
				hasMore = output.hasMore;
			} while (hasMore);
		}
	}

	async #reconcileUnboundReservations(
		peer: DesktopAgentsRpcPeer,
		deadline: number,
		connectionGeneration: number,
	): Promise<void> {
		const reservations = [...this.#sendReservations.values()].filter(
			(reservation) => reservation.runId === undefined && !reservation.terminal,
		);
		for (const reservation of reservations) {
			if (
				this.#sendReservations.get(reservation.requestId) !== reservation ||
				reservation.runId !== undefined ||
				reservation.terminal
			) {
				continue;
			}
			this.#assertRecoveryDeadline(deadline);
			const input = sendAskChatMessageInputSchema.parse({
				requestId: reservation.requestId,
				sessionId: reservation.sessionId,
				content: reservation.content,
			});
			const payload = rpcJsonValueSchema.parse(JSON.parse(JSON.stringify(input)));
			const remainingMs = Math.max(1, deadline - this.now());
			let response: JsonValue;
			try {
				response = await waitWithinDeadline(
					peer.request(productRpcMethods.chatSend, payload, {
						timeoutMs: remainingMs,
					}),
					deadline,
					this.now,
				);
			} catch (error) {
				if (error instanceof RpcRemoteError) {
					switch (classifyRemoteOperationError(productRpcMethods.chatSend, error)) {
						case "session-retired":
							await this.#invalidatePendingSessionRetirement(
								this.#stagePendingSessionRetirement(reservation.sessionId),
								deadline,
								connectionGeneration,
							);
							continue;
						case "definitive-rejection":
							this.#discardSendReservation(reservation);
							continue;
						case "ambiguous":
							throw error;
					}
				}
				if (isUnavailableTransportError(error)) {
					throw createTransportUnavailableError(error);
				}
				throw error;
			}
			if (reservation.retired || this.#sessionRetirements.has(reservation.sessionId)) {
				continue;
			}
			this.#acceptSendResponse(reservation, chatSendAcceptedOutputSchema.parse(response));
			this.#assertRecoveryDeadline(deadline);
		}
	}

	async #reconcilePendingSessionCreates(
		peer: DesktopAgentsRpcPeer,
		deadline: number,
	): Promise<void> {
		for (const reservation of [...this.#pendingSessionCreates.values()]) {
			if (
				this.#pendingSessionCreates.get(reservation.createKey) !== reservation ||
				this.#recoveredSessionCreates.has(reservation.createKey)
			) {
				continue;
			}
			this.#assertRecoveryDeadline(deadline);
			try {
				const output = await waitWithinDeadline(
					this.#requestSessionCreate(peer, reservation, {
						timeoutMs: Math.max(1, deadline - this.now()),
					}),
					deadline,
					this.now,
				);
				if (this.#pendingSessionCreates.get(reservation.createKey) !== reservation) {
					continue;
				}
				if (reservation.boundSessionId !== output.session.id) {
					continue;
				}
				this.#recoveredSessionCreates.set(reservation.createKey, { output });
			} catch (error) {
				if (error instanceof ChatSessionNotFoundError) {
					continue;
				}
				if (error instanceof RpcRemoteError) {
					if (
						classifyRemoteOperationError(productRpcMethods.sessionCreate, error) ===
						"definitive-rejection"
					) {
						this.#releaseSessionCreateReservation(reservation);
						continue;
					}
					throw error;
				}
				if (isDefiniteLocalRequestFailure(error) && !reservation.ambiguousDispatch) {
					this.#releaseSessionCreateReservation(reservation);
					continue;
				}
				if (isDefiniteLocalRequestFailure(error)) {
					continue;
				}
				if (isUnavailableTransportError(error)) {
					throw createTransportUnavailableError(error);
				}
				throw error;
			}
			this.#assertRecoveryDeadline(deadline);
		}
	}

	async #readCursorSupport(peer: DesktopAgentsRpcPeer, deadline: number): Promise<void> {
		const output = replayChatEventsOutputSchema.parse(
			await peer.request(
				productRpcMethods.chatReplay,
				{ cursors: [] },
				{
					timeoutMs: Math.max(1, deadline - this.now()),
				},
			),
		);
		if (
			output.events.length !== 0 ||
			output.retiredSessionIds.length !== 0 ||
			output.resnapshotSessionIds.length !== 0 ||
			output.hasMore
		) {
			throw new AgentsUnavailableError("Agents replay support probe returned unexpected data.");
		}
		this.#setCursorSupport(output.cursorSupport);
	}

	#setCursorSupport(support: ReplayCursorSupport): void {
		this.#cursorSupportAnchor = { support, observedAtLocalMs: this.now() };
	}

	#estimatedServerTimeMs(): number {
		const anchor =
			this.#cursorSupportAnchor ??
			fail("Agents replay cursor support was not established before tracking a Run.");
		return Math.max(
			anchor.support.serverTimeMs,
			anchor.support.serverTimeMs + (this.now() - anchor.observedAtLocalMs),
		);
	}

	async #flushProvisionalEvents(
		queue: ProvisionalEventQueue,
		deadline: number,
		deliver: (event: ChatRunEvent, deadline?: number) => Promise<void>,
	): Promise<void> {
		while (queue.events.length > 0) {
			const events = queue.events.splice(0);
			queue.encodedBytes = 0;
			const uniqueEvents = new Map<string, ChatRunEvent>();
			for (const event of sortReplayEvents(events)) {
				uniqueEvents.set(`${event.runId}\u0000${event.seq}`, event);
			}
			for (const event of uniqueEvents.values()) {
				await deliver(event, deadline);
			}
		}
	}

	async #deliverThenCommit(
		event: ChatRunEvent,
		deadline?: number,
		deferTerminalDeletion = false,
	): Promise<void> {
		if (this.#sessionRetirements.has(event.sessionId)) {
			return;
		}
		const cursor = this.#activeRunCursors.get(event.runId);
		if (cursor !== undefined && event.seq <= cursor.lastSeq) {
			return;
		}
		if (cursor !== undefined && event.seq !== cursor.lastSeq + 1) {
			throw new AgentsUnavailableError("A gap was detected in the local chat event stream.");
		}
		for (const listener of [...this.#chatEventListeners]) {
			const delivery = Promise.resolve(listener(event));
			if (deadline === undefined) {
				await delivery;
			} else {
				await waitWithinDeadline(delivery, deadline, this.now);
			}
		}
		if (deadline !== undefined) {
			this.#assertRecoveryDeadline(deadline);
		}
		if (cursor === undefined) {
			return;
		}
		cursor.lastSeq = event.seq;
		if (event.type === "message.completed") {
			cursor.messageTerminal = true;
		}
		if (
			event.type === "run.status" &&
			(event.payload.status === "completed" ||
				event.payload.status === "failed" ||
				event.payload.status === "cancelled")
		) {
			cursor.runTerminal = true;
		}
		if (cursor.messageTerminal && cursor.runTerminal) {
			const reservation = this.#runReservations.get(event.runId);
			if (reservation !== undefined) {
				reservation.terminal = true;
				this.#releaseSendReservation(reservation);
			}
			if (!deferTerminalDeletion) {
				this.#activeRunCursors.delete(event.runId);
			}
		}
	}

	#deleteCommittedTerminalCursors(): void {
		for (const [runId, cursor] of this.#activeRunCursors) {
			if (cursor.messageTerminal && cursor.runTerminal) {
				const reservation = this.#runReservations.get(runId);
				if (reservation !== undefined) {
					reservation.terminal = true;
					this.#releaseSendReservation(reservation);
				}
				this.#activeRunCursors.delete(runId);
			}
		}
	}

	#retireRun(runId: string): void {
		this.#activeRunCursors.delete(runId);
		this.#runSessionRoutes.delete(runId);
		const reservation = this.#runReservations.get(runId);
		if (reservation === undefined) {
			return;
		}
		this.#releaseSendReservation(reservation);
	}

	#clearSessionRunState(sessionId: string): void {
		for (const [runId, cursor] of this.#activeRunCursors) {
			if (cursor.sessionId === sessionId) {
				this.#retireRun(runId);
			}
		}
		for (const reservation of [...this.#sendReservations.values()]) {
			if (reservation.sessionId === sessionId) {
				this.#releaseSendReservation(reservation);
			}
		}
		for (const [runId, routedSessionId] of this.#runSessionRoutes) {
			if (routedSessionId === sessionId) {
				this.#runSessionRoutes.delete(runId);
			}
		}
	}

	#retireSession(sessionId: string): void {
		const retirement = this.#stagePendingSessionRetirement(sessionId);
		retirement.value.status = "finalized";
		this.#finalizeSessionRetirementState(sessionId);
	}

	#isSessionRetirementPending(sessionId: string): boolean {
		return this.#sessionRetirements.get(sessionId)?.value.status === "pending";
	}

	#stagePendingSessionRetirement(
		sessionId: string,
	): SessionRetirementCacheEntry<SessionRetirementState> {
		const existing = this.#sessionRetirements.get(sessionId);
		if (existing !== undefined) {
			return existing;
		}
		try {
			return this.#sessionRetirements.remember(sessionId, {
				generation: ++this.#nextRetirementGeneration,
				status: "pending",
			}).entry;
		} catch (error) {
			if (error instanceof SessionRetirementCapacityError) {
				throw new AgentsUnavailableError("The Session retirement recovery limit was exceeded.", {
					cause: error,
				});
			}
			throw error;
		}
	}

	#stagePendingSessionRetirementBatch(
		sessionIds: readonly string[],
	): SessionRetirementCacheEntry<SessionRetirementState>[] {
		const missingSessionIds = new Set(
			sessionIds.filter((sessionId) => !this.#sessionRetirements.has(sessionId)),
		);
		if (this.#sessionRetirements.size + missingSessionIds.size > maxRetainedSessionRetirements) {
			throw new AgentsUnavailableError("The Session retirement recovery limit was exceeded.");
		}
		return sessionIds.map((sessionId) => this.#stagePendingSessionRetirement(sessionId));
	}

	#finalizePendingSessionRetirement(
		retirement: SessionRetirementCacheEntry<SessionRetirementState>,
		expectedGeneration: number | undefined,
	): void {
		if (
			retirement.value.generation !== expectedGeneration ||
			!this.#sessionRetirements.isCurrent(retirement)
		) {
			throw new AgentsUnavailableError(
				"The Session retirement acknowledgement was stale or expired.",
			);
		}
		if (retirement.value.status === "finalized") {
			return;
		}
		retirement.value.status = "finalized";
		this.#finalizeSessionRetirementState(retirement.sessionId);
	}

	#finalizeSessionRetirementState(sessionId: string): void {
		for (const operation of this.#sessionOperations) {
			if (operation.sessionId === sessionId) {
				operation.retired = true;
			}
		}
		for (const reservation of new Set([
			...this.#sendReservations.values(),
			...this.#runReservations.values(),
		])) {
			if (reservation.sessionId === sessionId) {
				reservation.retired = true;
			}
		}
		this.#clearSessionRunState(sessionId);
		for (const [createKey, recovered] of this.#recoveredSessionCreates) {
			if (recovered.output.session.id !== sessionId) {
				continue;
			}
			this.#recoveredSessionCreates.delete(createKey);
			const reservation = this.#pendingSessionCreates.get(createKey);
			if (reservation !== undefined) {
				if (reservation.boundSessionId !== undefined && reservation.boundSessionId !== sessionId) {
					continue;
				}
				reservation.boundSessionId = sessionId;
				this.#releaseSessionCreateReservation(reservation, true);
			} else if (this.#implicitSessionCreateKey === createKey) {
				this.#implicitSessionCreateKey = undefined;
			}
		}
		for (const reservation of [...this.#pendingSessionCreates.values()]) {
			if (reservation.boundSessionId !== sessionId) {
				continue;
			}
			this.#recoveredSessionCreates.delete(reservation.createKey);
			this.#releaseSessionCreateReservation(reservation, true);
		}
	}

	#hasPendingSessionRetirements(): boolean {
		return (
			this.#sessionRetirements.entries().find((entry) => entry.value.status === "pending") !==
			undefined
		);
	}

	/**
	 * Drains provisional chat events and pending Session retirements together until BOTH are quiescent.
	 *
	 * The two recovery queues feed each other: delivering a provisional chat event awaits a renderer chat
	 * listener, during which a `chatSessionsRetired` notification can be staged as a new pending
	 * retirement; and finalizing a retirement awaits a renderer acknowledgement, during which a live chat
	 * event can be enqueued into the provisional buffer. Flushing one queue and then the other exactly
	 * once therefore leaves a tail race — e.g. a retirement staged during the final chat-event flush is
	 * never retried, so the connection is marked ready without invalidating the renderer. Looping until a
	 * full pass leaves both queues empty closes that race. The caller flips `connectionActive = true`
	 * synchronously immediately after this resolves, with no interleaving await, so any later arrival is
	 * routed through active delivery instead of the provisional buffers.
	 */
	async #drainRecoveryUntilQuiescent(
		queue: ProvisionalEventQueue,
		deadline: number,
		connectionGeneration: number,
		deliver: (event: ChatRunEvent, deadline?: number) => Promise<void>,
	): Promise<void> {
		// Each round after the first drains at least one item that was staged during the previous round's
		// awaits. Distinct items are bounded by the provisional event and retention caps, so this is a
		// finite backstop to the recovery deadline both inner drains already enforce.
		const maxRounds = this.#recoveryLimits.maxProvisionalEvents + maxRetainedSessionRetirements + 1;
		let rounds = 0;
		while (queue.events.length > 0 || this.#hasPendingSessionRetirements()) {
			if (rounds >= maxRounds) {
				throw new AgentsUnavailableError(
					"The recovery drain did not reach a quiescent state within its bounded rounds.",
				);
			}
			await this.#flushProvisionalEvents(queue, deadline, deliver);
			await this.#retryPendingSessionRetirements(deadline, connectionGeneration);
			rounds += 1;
		}
	}

	async #retryPendingSessionRetirements(
		deadline: number,
		connectionGeneration: number,
	): Promise<void> {
		let processed = 0;
		while (true) {
			this.#assertRecoveryDeadline(deadline);
			const retirement = this.#sessionRetirements
				.entries()
				.find((entry) => entry.value.status === "pending");
			if (retirement === undefined) {
				return;
			}
			if (processed >= maxRetainedSessionRetirements) {
				throw new AgentsUnavailableError(
					"The pending Session retirement drain exceeded its bounded capacity.",
				);
			}
			await this.#invalidatePendingSessionRetirement(retirement, deadline, connectionGeneration);
			processed += 1;
		}
	}

	async #recoverRetiredSessions(
		peer: DesktopAgentsRpcPeer,
		deadline: number,
		connectionGeneration: number,
	): Promise<void> {
		let cursor: string | undefined;
		while (true) {
			this.#assertRecoveryDeadline(deadline);
			const input = listRetiredChatSessionsInputSchema.parse({
				schemaVersion: 1,
				...(cursor === undefined ? {} : { cursor }),
				limit: maxRetiredSessionsPerRecoveryPage,
			});
			const output = listRetiredChatSessionsOutputSchema.parse(
				await peer.request(productRpcMethods.chatRetiredSessionsList, input, {
					timeoutMs: Math.max(1, deadline - this.now()),
				}),
			);
			const retirements = this.#stagePendingSessionRetirementBatch(output.sessionIds);
			for (const retirement of retirements) {
				await this.#invalidatePendingSessionRetirement(retirement, deadline, connectionGeneration);
			}
			if (output.nextCursor === undefined) {
				return;
			}
			if (
				output.sessionIds.length === 0 ||
				output.nextCursor !== output.sessionIds.at(-1) ||
				(cursor !== undefined && output.nextCursor <= cursor)
			) {
				throw new AgentsUnavailableError(
					"Agents returned an invalid retired Session recovery cursor.",
				);
			}
			cursor = output.nextCursor;
		}
	}

	async #invalidatePendingSessionRetirement(
		retirement: SessionRetirementCacheEntry<SessionRetirementState>,
		deadline: number,
		connectionGeneration: number,
	): Promise<void> {
		if (!this.#sessionRetirements.isCurrent(retirement)) {
			throw new AgentsUnavailableError("The pending Session retirement expired during recovery.");
		}
		if (retirement.value.status === "finalized") {
			return;
		}
		await this.#invalidateSession(
			retirement.sessionId,
			"session_retired",
			deadline,
			connectionGeneration,
			retirement,
		);
	}

	async #invalidateSession(
		sessionId: string,
		reason: ChatSessionInvalidation["reason"],
		deadline: number,
		connectionGeneration: number,
		retirement?: SessionRetirementCacheEntry<SessionRetirementState>,
	): Promise<void> {
		if (this.#chatSessionInvalidationListeners.size === 0) {
			throw new AgentsUnavailableError(
				"No renderer is available to refresh invalidated chat state.",
			);
		}
		if (this.#pendingSessionInvalidations.size >= this.#recoveryLimits.maxTrackedRunCursors) {
			throw new AgentsUnavailableError("The chat invalidation acknowledgement limit was exceeded.");
		}
		const invalidationId = crypto.randomUUID();
		let pending!: PendingSessionInvalidation;
		const acknowledgement = new Promise<void>((resolve, reject) => {
			pending = {
				connectionGeneration,
				retirement,
				retirementGeneration: retirement?.value.generation,
				sessionId,
				resolve,
				reject,
			};
			this.#pendingSessionInvalidations.set(invalidationId, pending);
		});
		this.#invalidatingSessionIds.add(sessionId);
		const invalidation = chatSessionInvalidationSchema.parse({
			schemaVersion: 1,
			invalidationId,
			sessionId,
			reason,
		});
		try {
			for (const listener of [...this.#chatSessionInvalidationListeners]) {
				listener(invalidation);
			}
			await waitWithinDeadline(acknowledgement, deadline, this.now);
		} finally {
			if (this.#pendingSessionInvalidations.get(invalidationId) === pending) {
				this.#pendingSessionInvalidations.delete(invalidationId);
				this.#releaseInvalidatingSessionId(sessionId);
			}
		}
	}

	#rejectInvalidationAttempts(connectionGeneration: number, error: AgentsUnavailableError): void {
		for (const [invalidationId, pending] of this.#pendingSessionInvalidations) {
			if (pending.connectionGeneration !== connectionGeneration) {
				continue;
			}
			this.#pendingSessionInvalidations.delete(invalidationId);
			this.#releaseInvalidatingSessionId(pending.sessionId);
			pending.reject(error);
		}
	}

	#releaseInvalidatingSessionId(sessionId: string): void {
		for (const pending of this.#pendingSessionInvalidations.values()) {
			if (pending.sessionId === sessionId) {
				return;
			}
		}
		this.#invalidatingSessionIds.delete(sessionId);
	}

	#assertRecoveryDeadline(deadline: number): void {
		if (this.now() > deadline) {
			throw new AgentsUnavailableError("The local agents recovery deadline was exceeded.");
		}
	}
}

function resolveRecoveryLimits(
	input: DesktopAgentsRecoveryLimits,
): ResolvedDesktopAgentsRecoveryLimits {
	return {
		maxTrackedRunCursors: requirePositiveSafeInteger(
			input.maxTrackedRunCursors ?? defaultRecoveryLimits.maxTrackedRunCursors,
			"maxTrackedRunCursors",
		),
		maxPendingSessionCreates: requirePositiveSafeInteger(
			input.maxPendingSessionCreates ?? defaultRecoveryLimits.maxPendingSessionCreates,
			"maxPendingSessionCreates",
		),
		maxProvisionalEvents: requirePositiveSafeInteger(
			input.maxProvisionalEvents ?? defaultRecoveryLimits.maxProvisionalEvents,
			"maxProvisionalEvents",
		),
		maxProvisionalBytes: requirePositiveSafeInteger(
			input.maxProvisionalBytes ?? defaultRecoveryLimits.maxProvisionalBytes,
			"maxProvisionalBytes",
		),
		recoveryTimeoutMs: requirePositiveSafeInteger(
			input.recoveryTimeoutMs ?? defaultRecoveryLimits.recoveryTimeoutMs,
			"recoveryTimeoutMs",
		),
	};
}

function enqueueProvisionalEvent(
	queue: ProvisionalEventQueue,
	event: ChatRunEvent,
	limits: ResolvedDesktopAgentsRecoveryLimits,
): void {
	const encodedBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
	if (
		queue.events.length + 1 > limits.maxProvisionalEvents ||
		queue.encodedBytes + encodedBytes > limits.maxProvisionalBytes
	) {
		throw new AgentsUnavailableError("The local agents provisional event budget was exceeded.");
	}
	queue.events.push(event);
	queue.encodedBytes += encodedBytes;
}

function sortReplayEvents(events: readonly ChatRunEvent[]): ChatRunEvent[] {
	return [...events].sort(
		(left, right) =>
			left.runId.localeCompare(right.runId) ||
			left.seq - right.seq ||
			left.id.localeCompare(right.id),
	);
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

function classifyRemoteOperationError(
	method: RecoverableProductMethod,
	error: RpcRemoteError,
): RemoteOperationErrorDisposition {
	return remoteOperationErrorDispositions[method][error.code] ?? "ambiguous";
}

function isDefiniteLocalRequestFailure(error: unknown): boolean {
	return error instanceof RpcRequestLimitError || error instanceof RpcFrameTooLargeError;
}

function isUnavailableTransportError(
	error: unknown,
): error is RpcConnectionClosedError | RpcTimeoutError {
	return error instanceof RpcConnectionClosedError || error instanceof RpcTimeoutError;
}

function createTransportUnavailableError(
	error: RpcConnectionClosedError | RpcTimeoutError,
): AgentsUnavailableError {
	return new AgentsUnavailableError("The local agents service is unavailable.", { cause: error });
}

function toRecoveryError(error: unknown): Error {
	return error instanceof Error
		? error
		: new AgentsUnavailableError("The local agents recovery failed.");
}

function fail(message: string): never {
	throw new Error(message);
}

async function waitWithinDeadline<T>(
	operation: PromiseLike<T>,
	deadline: number,
	now: () => number,
): Promise<T> {
	const remainingMs = deadline - now();
	if (remainingMs <= 0) {
		throw new AgentsUnavailableError("The local agents recovery deadline was exceeded.");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(new AgentsUnavailableError("The local agents recovery deadline was exceeded.")),
					Math.min(remainingMs, 2_147_483_647),
				);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function createAgentsServerUrl(endpoint: {
	host: "127.0.0.1";
	port: number;
	path: "/rpc";
}): string {
	return `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`;
}
