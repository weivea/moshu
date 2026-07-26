import { invokeRpcCallback, reportRpcCallbackError } from "./callback-errors";
import {
	ProcessRpcError,
	RpcCancelledError,
	RpcConnectionClosedError,
	RpcFrameTooLargeError,
	RpcHandlerError,
	RpcRemoteError,
	RpcRequestLimitError,
	RpcTimeoutError,
} from "./errors";
import { hasSafeRpcJsonStructure } from "./json-structure";
import type { ResolvedRpcLimits, RpcLimits } from "./limits";
import {
	hasUnsupportedRpcSchemaVersion,
	type JsonValue,
	PROCESS_RPC_SCHEMA_VERSION,
	type RpcCancelEnvelope,
	type RpcEnvelope,
	type RpcEventEnvelope,
	type RpcPeerIdentity,
	type RpcPeerRole,
	type RpcProtocolErrorCode,
	type RpcProtocolErrorEnvelope,
	type RpcProtocolVersion,
	type RpcRequestEnvelope,
	type RpcResponseError,
	rpcEnvelopeSchema,
	rpcJsonValueSchema,
} from "./protocol";
import { truncateWebSocketCloseReason } from "./websocket-utils";

export interface RpcRequestContext {
	readonly peer: RpcPeer;
	readonly remoteIdentity: RpcPeerIdentity;
	readonly requestId: string;
	readonly traceId: string;
	readonly method: string;
	readonly deadlineAt: number;
	readonly signal: AbortSignal;
}

export interface RpcEventContext {
	readonly peer: RpcPeer;
	readonly remoteIdentity: RpcPeerIdentity;
	readonly eventId: string;
	readonly traceId: string;
	readonly method: string;
	/** Aborted when the peer disconnects or the protocol closes. */
	readonly signal: AbortSignal;
}

export type RpcRequestHandler = (
	payload: JsonValue,
	context: RpcRequestContext,
) => JsonValue | Promise<JsonValue>;

export type RpcEventHandler = (
	payload: JsonValue,
	context: RpcEventContext,
) => void | Promise<void>;

export interface RpcHandlers {
	readonly requests?: Readonly<Record<string, RpcRequestHandler>>;
	readonly events?: Readonly<Record<string, RpcEventHandler>>;
}

export interface RpcRoleMethodPolicy {
	readonly requests?: readonly string[];
	readonly events?: readonly string[];
}

/**
 * Inbound methods are denied unless the remote role and method are explicitly listed.
 */
export type RpcMethodAllowlist = Partial<Record<RpcPeerRole, RpcRoleMethodPolicy>>;

export interface RpcCloseInfo {
	readonly code: number;
	readonly reason: string;
}

export interface RpcEndpointOptions {
	readonly handlers?: RpcHandlers;
	readonly methodAllowlist?: RpcMethodAllowlist;
	readonly limits?: RpcLimits;
	readonly onProtocolError?: (error: RpcProtocolErrorEnvelope, peer: RpcPeer) => void;
	readonly onError?: (error: unknown, peer: RpcPeer) => void;
	readonly onClose?: (info: RpcCloseInfo, peer: RpcPeer) => void;
}

export interface RpcRequestOptions {
	readonly traceId?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface RpcEventOptions {
	readonly eventId?: string;
	readonly traceId?: string;
}

export interface RpcSocketTransport {
	send(text: string): void;
	close(code: number, reason: string): void;
	terminate(): void;
	isOpen(): boolean;
}

export interface RpcPeerInternalOptions extends RpcEndpointOptions {
	readonly localIdentity: RpcPeerIdentity;
	readonly remoteIdentity: RpcPeerIdentity;
	readonly protocol: RpcProtocolVersion;
	readonly resolvedLimits: ResolvedRpcLimits;
	readonly transport: RpcSocketTransport;
}

interface PendingRequest {
	readonly requestId: string;
	readonly traceId: string;
	readonly timeoutMs: number;
	readonly resolve: (payload: JsonValue) => void;
	readonly reject: (error: unknown) => void;
	readonly signal: AbortSignal | undefined;
	abortListener: (() => void) | null;
	timer: ReturnType<typeof setTimeout> | null;
	sent: boolean;
}

interface InboundRequest {
	readonly requestId: string;
	readonly traceId: string;
	readonly controller: AbortController;
	timer: ReturnType<typeof setTimeout> | null;
	responseEligible: boolean;
}

interface InboundEvent {
	readonly controller: AbortController;
}

const textEncoder = new TextEncoder();

/**
 * A fully handshaken, bidirectional RPC connection shared by client and server endpoints.
 */
export class RpcPeer {
	readonly localIdentity: RpcPeerIdentity;
	readonly remoteIdentity: RpcPeerIdentity;
	readonly protocol: RpcProtocolVersion;
	readonly limits: ResolvedRpcLimits;
	readonly closed: Promise<RpcCloseInfo>;

	readonly #transport: RpcSocketTransport;
	readonly #requestHandlers: Readonly<Record<string, RpcRequestHandler>>;
	readonly #eventHandlers: Readonly<Record<string, RpcEventHandler>>;
	readonly #allowedRequests: ReadonlySet<string>;
	readonly #allowedEvents: ReadonlySet<string>;
	readonly #onProtocolError: ((error: RpcProtocolErrorEnvelope, peer: RpcPeer) => void) | undefined;
	readonly #onError: ((error: unknown, peer: RpcPeer) => void) | undefined;
	readonly #onClose: ((info: RpcCloseInfo, peer: RpcPeer) => void) | undefined;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #inboundRequests = new Map<string, InboundRequest>();
	readonly #inboundEvents = new Set<InboundEvent>();
	readonly #resolveClosed: (info: RpcCloseInfo) => void;
	readonly #requestIdPrefix = crypto.randomUUID();
	#nextRequestSequence = 0n;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#lastReceivedAt = Date.now();
	#isClosed = false;

	constructor(options: RpcPeerInternalOptions) {
		this.localIdentity = options.localIdentity;
		this.remoteIdentity = options.remoteIdentity;
		this.protocol = options.protocol;
		this.limits = options.resolvedLimits;
		this.#transport = options.transport;
		this.#requestHandlers = options.handlers?.requests ?? {};
		this.#eventHandlers = options.handlers?.events ?? {};
		const rolePolicy = options.methodAllowlist?.[options.remoteIdentity.role];
		this.#allowedRequests = new Set(rolePolicy?.requests ?? []);
		this.#allowedEvents = new Set(rolePolicy?.events ?? []);
		this.#onProtocolError = options.onProtocolError;
		this.#onError = options.onError;
		this.#onClose = options.onClose;

		let resolveClosed: ((info: RpcCloseInfo) => void) | undefined;
		this.closed = new Promise<RpcCloseInfo>((resolve) => {
			resolveClosed = resolve;
		});
		if (resolveClosed === undefined) {
			throw new Error("Failed to initialize RPC close promise.");
		}
		this.#resolveClosed = resolveClosed;
		this.#startHeartbeat();
	}

	get isClosed(): boolean {
		return this.#isClosed;
	}

	get pendingRequestCount(): number {
		return this.#pendingRequests.size;
	}

	get inboundRequestCount(): number {
		return this.#inboundRequests.size;
	}

	get inboundEventCount(): number {
		return this.#inboundEvents.size;
	}

	/**
	 * Sends a request and resolves with its JSON payload. Every request has a bounded deadline.
	 */
	async request(
		method: string,
		payload: JsonValue,
		options: RpcRequestOptions = {},
	): Promise<JsonValue> {
		this.#assertOpen();
		if (this.#pendingRequests.size >= this.limits.maxPendingRequests) {
			throw new RpcRequestLimitError(this.limits.maxPendingRequests);
		}

		const timeoutMs = options.timeoutMs ?? this.limits.requestTimeoutMs;
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > this.limits.maxRequestTimeoutMs
		) {
			throw new RangeError(
				`timeoutMs must be a positive safe integer no greater than ${this.limits.maxRequestTimeoutMs}.`,
			);
		}

		const requestId = this.#createRequestId();
		const traceId = options.traceId ?? requestId;
		const envelope: RpcRequestEnvelope = {
			...this.#envelopeBase(),
			type: "request",
			requestId,
			traceId,
			method,
			deadlineAt: Date.now() + timeoutMs,
			payload,
		};
		const text = this.#encodeEnvelope(envelope);

		if (options.signal?.aborted === true) {
			throw new RpcCancelledError(requestId, getAbortReason(options.signal.reason));
		}

		return new Promise<JsonValue>((resolve, reject) => {
			const pending: PendingRequest = {
				requestId,
				traceId,
				timeoutMs,
				resolve,
				reject,
				signal: options.signal,
				abortListener: null,
				timer: null,
				sent: false,
			};
			this.#pendingRequests.set(requestId, pending);

			pending.timer = setTimeout(() => {
				this.#cancelPendingRequest(
					requestId,
					new RpcTimeoutError(requestId, timeoutMs),
					"deadline exceeded",
				);
			}, timeoutMs);

			if (pending.signal !== undefined) {
				pending.abortListener = () => {
					this.#cancelPendingRequest(
						requestId,
						new RpcCancelledError(requestId, getAbortReason(pending.signal?.reason)),
						"caller cancelled",
					);
				};
				pending.signal.addEventListener("abort", pending.abortListener, { once: true });
				if (pending.signal.aborted) {
					pending.abortListener();
					return;
				}
			}

			try {
				this.#transport.send(text);
				pending.sent = true;
			} catch (error) {
				this.#deletePendingRequest(pending);
				const connectionError = new RpcConnectionClosedError(1011, "WebSocket send failed.", {
					cause: error,
				});
				reject(connectionError);
				this.#terminate(1011, "WebSocket send failed.", error);
			}
		});
	}

	/**
	 * Emits a one-way JSON event. Events are independently identified and traced.
	 */
	emitEvent(method: string, payload: JsonValue, options: RpcEventOptions = {}): string {
		this.#assertOpen();
		const eventId = options.eventId ?? crypto.randomUUID();
		const envelope: RpcEventEnvelope = {
			...this.#envelopeBase(),
			type: "event",
			eventId,
			traceId: options.traceId ?? eventId,
			method,
			payload,
		};
		try {
			this.#sendEnvelope(envelope);
		} catch (error) {
			this.#terminate(1011, "Failed to send RPC event.", error);
			throw error;
		}
		return eventId;
	}

	close(code = 1000, reason = "RPC connection closed."): void {
		if (this.#isClosed) {
			return;
		}
		assertValidWebSocketCloseCode(code);

		try {
			this.#transport.close(code, truncateWebSocketCloseReason(reason));
		} catch (error) {
			this.#reportError(error);
			this.#forceTerminateTransport();
		}
		this.handleTransportClose(code, reason);
	}

	/**
	 * Immediately tears down the physical transport. This remains effective after logical close.
	 */
	terminate(code = 1001, reason = "RPC connection terminated."): void {
		assertValidWebSocketCloseCode(code);
		this.#forceTerminateTransport();
		this.handleTransportClose(code, reason);
	}

	handleTextFrame(text: string): void {
		if (this.#isClosed) {
			return;
		}

		try {
			this.#handleTextFrame(text);
		} catch (error) {
			this.#rejectMalformedFrame("Frame validation failed.", error);
		}
	}

	#handleTextFrame(text: string): void {
		const frameBytes = getTextBytes(text);
		if (frameBytes > this.limits.maxFrameBytes) {
			this.#rejectInboundFrame(
				"FRAME_TOO_LARGE",
				`Frame exceeded the ${this.limits.maxFrameBytes}-byte limit.`,
			);
			return;
		}
		if (!hasSafeRpcJsonStructure(text)) {
			this.#rejectMalformedFrame("Frame exceeded the JSON structural limits.");
			return;
		}

		let decoded: unknown;
		try {
			decoded = JSON.parse(text);
		} catch (error) {
			this.#rejectMalformedFrame("Frame was not valid JSON.", error);
			return;
		}
		if (hasUnsupportedRpcSchemaVersion(decoded)) {
			this.rejectProtocol(
				"UNSUPPORTED_SCHEMA",
				`Schema version must be ${PROCESS_RPC_SCHEMA_VERSION}.`,
				true,
			);
			return;
		}

		const parsed = rpcEnvelopeSchema.safeParse(decoded);
		if (!parsed.success) {
			this.rejectProtocol(
				"MALFORMED_FRAME",
				"Frame did not match the process RPC envelope schema.",
				true,
			);
			return;
		}
		if (
			parsed.data.protocol.major !== this.protocol.major ||
			parsed.data.protocol.minor !== this.protocol.minor
		) {
			this.rejectProtocol(
				"UNSUPPORTED_PROTOCOL",
				"Frame protocol did not match the negotiated connection protocol.",
				true,
			);
			return;
		}

		this.#lastReceivedAt = Date.now();
		this.#dispatchEnvelope(parsed.data);
	}

	handleBinaryFrame(): void {
		if (this.#isClosed) {
			return;
		}
		this.#rejectMalformedFrame("Binary WebSocket frames are not supported.");
	}

	handleTransportError(error: unknown): void {
		this.#reportError(error);
	}

	handleTransportClose(code: number, reason: string): void {
		if (this.#isClosed) {
			return;
		}
		this.#isClosed = true;

		if (this.#heartbeatTimer !== null) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}

		for (const pending of this.#pendingRequests.values()) {
			this.#deletePendingRequest(pending);
			pending.reject(new RpcConnectionClosedError(code, reason));
		}
		for (const inbound of this.#inboundRequests.values()) {
			this.#suppressInboundResponse(inbound);
			inbound.controller.abort(new RpcConnectionClosedError(code, reason));
		}
		for (const inbound of this.#inboundEvents) {
			inbound.controller.abort(new RpcConnectionClosedError(code, reason));
		}

		const info: RpcCloseInfo = { code, reason };
		this.#resolveClosed(info);
		if (this.#onClose !== undefined) {
			invokeRpcCallback(
				() => this.#onClose?.(info, this),
				(error) => this.#reportCallbackError(error),
			);
		}
	}

	rejectProtocol(
		code: RpcProtocolErrorCode,
		message: string,
		fatal: boolean,
		relatedId?: string,
	): void {
		if (this.#isClosed) {
			return;
		}

		const envelope: RpcProtocolErrorEnvelope = {
			...this.#envelopeBase(),
			type: "protocol-error",
			code,
			message,
			fatal,
			...(relatedId === undefined ? {} : { relatedId }),
		};
		try {
			this.#sendEnvelope(envelope);
		} catch (error) {
			this.#reportError(error);
		}
		if (fatal) {
			this.close(1002, `${code}: ${message}`);
		}
	}

	#dispatchEnvelope(envelope: RpcEnvelope): void {
		switch (envelope.type) {
			case "request":
				this.#handleRequest(envelope);
				return;
			case "response":
				this.#handleResponse(envelope);
				return;
			case "event":
				this.#handleEvent(envelope);
				return;
			case "cancel":
				this.#handleCancel(envelope);
				return;
			case "heartbeat":
				this.#handleHeartbeat(envelope);
				return;
			case "protocol-error":
				if (this.#onProtocolError !== undefined) {
					invokeRpcCallback(
						() => this.#onProtocolError?.(envelope, this),
						(error) => this.#reportCallbackError(error),
					);
				}
				if (envelope.fatal) {
					this.close(1002, `${envelope.code}: ${envelope.message}`);
				}
				return;
			case "hello":
			case "hello-ack":
				this.rejectProtocol(
					"UNEXPECTED_MESSAGE",
					`${envelope.type} is only valid during the handshake.`,
					true,
				);
				return;
		}
	}

	#handleRequest(envelope: RpcRequestEnvelope): void {
		if (!this.#allowedRequests.has(envelope.method)) {
			this.#sendRequestError(envelope, {
				code: "METHOD_NOT_ALLOWED",
				message: `Method "${envelope.method}" is not allowed for role "${this.remoteIdentity.role}".`,
			});
			return;
		}

		const handler = getOwnHandler(this.#requestHandlers, envelope.method);
		if (handler === undefined) {
			this.#sendRequestError(envelope, {
				code: "METHOD_NOT_FOUND",
				message: `No handler is registered for method "${envelope.method}".`,
			});
			return;
		}
		if (this.#inboundRequests.has(envelope.requestId)) {
			this.#sendRequestError(envelope, {
				code: "DUPLICATE_REQUEST",
				message: `Request "${envelope.requestId}" is already active.`,
			});
			return;
		}
		if (this.#inboundRequests.size >= this.limits.maxConcurrentRequests) {
			this.#sendRequestError(envelope, {
				code: "REQUEST_LIMIT_EXCEEDED",
				message: "The remote endpoint has reached its concurrent request limit.",
			});
			return;
		}

		const remainingMs = envelope.deadlineAt - Date.now();
		if (remainingMs <= 0) {
			this.#sendRequestError(envelope, {
				code: "DEADLINE_EXCEEDED",
				message: "The request deadline had already expired.",
			});
			return;
		}
		if (remainingMs > this.limits.maxRequestTimeoutMs) {
			this.#sendRequestError(envelope, {
				code: "INVALID_DEADLINE",
				message: `The request deadline exceeds the ${this.limits.maxRequestTimeoutMs}ms limit.`,
			});
			return;
		}

		const inbound: InboundRequest = {
			requestId: envelope.requestId,
			traceId: envelope.traceId,
			controller: new AbortController(),
			timer: null,
			responseEligible: true,
		};
		this.#inboundRequests.set(envelope.requestId, inbound);
		inbound.timer = setTimeout(() => {
			if (!this.#claimInboundResponse(inbound)) {
				return;
			}
			inbound.controller.abort(new RpcTimeoutError(envelope.requestId, remainingMs));
			this.#sendRequestError(envelope, {
				code: "DEADLINE_EXCEEDED",
				message: "The request handler exceeded its deadline.",
			});
		}, remainingMs);

		void this.#runRequestHandler(envelope, inbound, handler);
	}

	async #runRequestHandler(
		envelope: RpcRequestEnvelope,
		inbound: InboundRequest,
		handler: RpcRequestHandler,
	): Promise<void> {
		try {
			const payload = await handler(envelope.payload, {
				peer: this,
				remoteIdentity: this.remoteIdentity,
				requestId: envelope.requestId,
				traceId: envelope.traceId,
				method: envelope.method,
				deadlineAt: envelope.deadlineAt,
				signal: inbound.controller.signal,
			});
			if (!this.#claimInboundResponse(inbound)) {
				return;
			}

			const parsedPayload = rpcJsonValueSchema.safeParse(payload);
			if (!parsedPayload.success) {
				this.#sendRequestError(envelope, {
					code: "INVALID_HANDLER_RESULT",
					message: "The request handler returned a non-JSON payload.",
				});
				return;
			}
			try {
				this.#sendEnvelope({
					...this.#envelopeBase(),
					type: "response",
					requestId: envelope.requestId,
					traceId: envelope.traceId,
					result: {
						ok: true,
						payload: parsedPayload.data,
					},
				});
			} catch (sendError) {
				if (isEnvelopeEncodingError(sendError)) {
					this.#sendRequestError(envelope, {
						code: "RESPONSE_TOO_LARGE",
						message: "The request result exceeded the configured frame limit.",
					});
				} else {
					this.#terminate(1011, "Failed to send an RPC response.", sendError);
				}
			}
		} catch (error) {
			if (!this.#claimInboundResponse(inbound)) {
				return;
			}
			if (error instanceof RpcHandlerError) {
				this.#sendRequestError(envelope, {
					code: error.code,
					message: error.message,
					...(error.data === undefined ? {} : { data: error.data }),
				});
				return;
			}

			this.#reportError(error);
			this.#sendRequestError(envelope, {
				code: "INTERNAL_ERROR",
				message: "The request handler failed.",
			});
		} finally {
			this.#releaseInboundRequest(inbound);
		}
	}

	#handleResponse(envelope: Extract<RpcEnvelope, { type: "response" }>): void {
		const pending = this.#pendingRequests.get(envelope.requestId);
		if (pending === undefined) {
			return;
		}
		if (pending.traceId !== envelope.traceId) {
			this.rejectProtocol(
				"IDENTITY_MISMATCH",
				`Response trace did not match request "${envelope.requestId}".`,
				true,
				envelope.requestId,
			);
			return;
		}

		this.#deletePendingRequest(pending);
		if (envelope.result.ok) {
			pending.resolve(envelope.result.payload);
		} else {
			pending.reject(new RpcRemoteError(envelope.requestId, envelope.result.error));
		}
	}

	#handleEvent(envelope: RpcEventEnvelope): void {
		if (!this.#allowedEvents.has(envelope.method)) {
			this.rejectProtocol(
				"METHOD_NOT_ALLOWED",
				`Event "${envelope.method}" is not allowed for role "${this.remoteIdentity.role}".`,
				false,
				envelope.eventId,
			);
			return;
		}

		const handler = getOwnHandler(this.#eventHandlers, envelope.method);
		if (handler === undefined) {
			this.rejectProtocol(
				"METHOD_NOT_ALLOWED",
				`No event handler is registered for "${envelope.method}".`,
				false,
				envelope.eventId,
			);
			return;
		}
		if (this.#inboundEvents.size >= this.limits.maxConcurrentEvents) {
			this.rejectProtocol(
				"EVENT_LIMIT_EXCEEDED",
				"The remote endpoint has reached its concurrent event limit.",
				true,
				envelope.eventId,
			);
			return;
		}

		const inbound: InboundEvent = { controller: new AbortController() };
		this.#inboundEvents.add(inbound);
		this.#runEventHandler(envelope, inbound, handler);
	}

	#runEventHandler(
		envelope: RpcEventEnvelope,
		inbound: InboundEvent,
		handler: RpcEventHandler,
	): void {
		let result: unknown;
		try {
			result = handler(envelope.payload, {
				peer: this,
				remoteIdentity: this.remoteIdentity,
				eventId: envelope.eventId,
				traceId: envelope.traceId,
				method: envelope.method,
				signal: inbound.controller.signal,
			});
		} catch (error) {
			this.#inboundEvents.delete(inbound);
			this.#handleEventHandlerFailure(envelope, error);
			return;
		}

		let then: unknown;
		try {
			then =
				result !== null && (typeof result === "object" || typeof result === "function")
					? Reflect.get(result, "then")
					: undefined;
		} catch (error) {
			this.#inboundEvents.delete(inbound);
			this.#handleEventHandlerFailure(envelope, error);
			return;
		}
		if (typeof then !== "function") {
			this.#inboundEvents.delete(inbound);
			return;
		}

		const settled = new Promise<void>((resolve, reject) => {
			Reflect.apply(then, result, [resolve, reject]);
		});
		settled.then(
			() => {
				this.#inboundEvents.delete(inbound);
			},
			(error: unknown) => {
				this.#inboundEvents.delete(inbound);
				this.#handleEventHandlerFailure(envelope, error);
			},
		);
	}

	#handleEventHandlerFailure(envelope: RpcEventEnvelope, error: unknown): void {
		this.#reportError(error);
		this.rejectProtocol(
			"EVENT_HANDLER_FAILED",
			`Event handler for "${envelope.method}" failed.`,
			false,
			envelope.eventId,
		);
	}

	#handleCancel(envelope: RpcCancelEnvelope): void {
		const inbound = this.#inboundRequests.get(envelope.requestId);
		if (inbound === undefined) {
			return;
		}
		if (inbound.traceId !== envelope.traceId) {
			this.rejectProtocol(
				"IDENTITY_MISMATCH",
				`Cancellation trace did not match request "${envelope.requestId}".`,
				true,
				envelope.requestId,
			);
			return;
		}

		this.#suppressInboundResponse(inbound);
		inbound.controller.abort(
			new RpcCancelledError(
				envelope.requestId,
				envelope.reason ?? "The remote endpoint cancelled the request.",
			),
		);
	}

	#handleHeartbeat(envelope: Extract<RpcEnvelope, { type: "heartbeat" }>): void {
		if (envelope.kind === "pong") {
			return;
		}
		this.#sendEnvelope({
			...this.#envelopeBase(),
			type: "heartbeat",
			heartbeatId: envelope.heartbeatId,
			kind: "pong",
			sentAt: Date.now(),
		});
	}

	#sendRequestError(envelope: RpcRequestEnvelope, error: RpcResponseError): void {
		try {
			this.#sendErrorEnvelope(envelope, error);
		} catch (sendError) {
			if (!isEnvelopeEncodingError(sendError)) {
				this.#terminate(1011, "Failed to send an RPC response.", sendError);
				return;
			}

			try {
				this.#sendErrorEnvelope(envelope, {
					code: "RESPONSE_ERROR_UNENCODABLE",
					message: "The request failed, but its error payload could not be encoded.",
				});
			} catch (fallbackError) {
				this.#terminate(1011, "Failed to send an RPC response.", fallbackError);
			}
		}
	}

	#sendErrorEnvelope(envelope: RpcRequestEnvelope, error: RpcResponseError): void {
		this.#sendEnvelope({
			...this.#envelopeBase(),
			type: "response",
			requestId: envelope.requestId,
			traceId: envelope.traceId,
			result: {
				ok: false,
				error,
			},
		});
	}

	#cancelPendingRequest(requestId: string, error: ProcessRpcError, reason: string): void {
		const pending = this.#pendingRequests.get(requestId);
		if (pending === undefined) {
			return;
		}
		this.#deletePendingRequest(pending);
		pending.reject(error);

		if (!pending.sent || this.#isClosed) {
			return;
		}
		try {
			this.#sendEnvelope({
				...this.#envelopeBase(),
				type: "cancel",
				requestId,
				traceId: pending.traceId,
				reason,
			});
		} catch (sendError) {
			this.#terminate(1011, "Failed to send RPC cancellation.", sendError);
		}
	}

	#deletePendingRequest(pending: PendingRequest): void {
		this.#pendingRequests.delete(pending.requestId);
		if (pending.timer !== null) {
			clearTimeout(pending.timer);
			pending.timer = null;
		}
		if (pending.signal !== undefined && pending.abortListener !== null) {
			pending.signal.removeEventListener("abort", pending.abortListener);
			pending.abortListener = null;
		}
	}

	#claimInboundResponse(inbound: InboundRequest): boolean {
		if (!inbound.responseEligible) {
			return false;
		}
		this.#suppressInboundResponse(inbound);
		return true;
	}

	#suppressInboundResponse(inbound: InboundRequest): void {
		inbound.responseEligible = false;
		if (inbound.timer !== null) {
			clearTimeout(inbound.timer);
			inbound.timer = null;
		}
	}

	#releaseInboundRequest(inbound: InboundRequest): void {
		this.#suppressInboundResponse(inbound);
		if (this.#inboundRequests.get(inbound.requestId) === inbound) {
			this.#inboundRequests.delete(inbound.requestId);
		}
	}

	#startHeartbeat(): void {
		if (this.limits.heartbeatIntervalMs === 0) {
			return;
		}

		this.#heartbeatTimer = setInterval(() => {
			if (this.#isClosed) {
				return;
			}
			if (Date.now() - this.#lastReceivedAt > this.limits.heartbeatTimeoutMs) {
				this.close(1001, "RPC heartbeat timed out.");
				return;
			}

			try {
				this.#sendEnvelope({
					...this.#envelopeBase(),
					type: "heartbeat",
					heartbeatId: crypto.randomUUID(),
					kind: "ping",
					sentAt: Date.now(),
				});
			} catch (error) {
				this.#terminate(1011, "Failed to send RPC heartbeat.", error);
			}
		}, this.limits.heartbeatIntervalMs);
	}

	#sendEnvelope(envelope: RpcEnvelope): void {
		this.#assertOpen();
		this.#transport.send(this.#encodeEnvelope(envelope));
	}

	#encodeEnvelope(envelope: RpcEnvelope): string {
		const parsed = rpcEnvelopeSchema.safeParse(envelope);
		if (!parsed.success) {
			throw new ProcessRpcError(
				"INVALID_OUTBOUND_FRAME",
				"Outbound value did not match the process RPC envelope schema.",
				{ cause: parsed.error },
			);
		}

		const text = JSON.stringify(parsed.data);
		const frameBytes = getTextBytes(text);
		if (frameBytes > this.limits.maxFrameBytes) {
			throw new RpcFrameTooLargeError(frameBytes, this.limits.maxFrameBytes);
		}
		return text;
	}

	#envelopeBase(): {
		schemaVersion: typeof PROCESS_RPC_SCHEMA_VERSION;
		protocol: RpcProtocolVersion;
	} {
		return {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: this.protocol,
		};
	}

	#createRequestId(): string {
		const requestId = `${this.#requestIdPrefix}:${this.#nextRequestSequence}`;
		this.#nextRequestSequence += 1n;
		return requestId;
	}

	#assertOpen(): void {
		if (this.#isClosed || !this.#transport.isOpen()) {
			throw new RpcConnectionClosedError(1006, "WebSocket is not open.");
		}
	}

	#terminate(code: number, reason: string, error: unknown): void {
		this.#reportError(error);
		if (this.#isClosed) {
			return;
		}
		this.#forceTerminateTransport();
		this.handleTransportClose(code, reason);
	}

	#rejectMalformedFrame(message: string, error?: unknown): void {
		if (error !== undefined) {
			this.#reportError(error);
		}
		this.#rejectInboundFrame("MALFORMED_FRAME", message);
	}

	#rejectInboundFrame(code: RpcProtocolErrorCode, message: string): void {
		this.rejectProtocol(code, message, true);
	}

	#forceTerminateTransport(): void {
		try {
			this.#transport.terminate();
		} catch (error) {
			this.#reportError(error);
		}
	}

	#reportError(error: unknown): void {
		if (this.#onError === undefined) {
			return;
		}
		invokeRpcCallback(() => this.#onError?.(error, this));
	}

	#reportCallbackError(error: unknown): void {
		if (this.#onError === undefined) {
			reportRpcCallbackError(error);
			return;
		}
		this.#reportError(error);
	}
}

function getOwnHandler<T>(handlers: Readonly<Record<string, T>>, method: string): T | undefined {
	return Object.hasOwn(handlers, method) ? handlers[method] : undefined;
}

function getAbortReason(reason: unknown): string {
	if (typeof reason === "string" && reason.length > 0) {
		return reason;
	}
	if (reason instanceof Error && reason.message.length > 0) {
		return reason.message;
	}
	return "RPC request was cancelled.";
}

function getTextBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

function assertValidWebSocketCloseCode(code: number): void {
	const isProtocolCode =
		code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
	const isApplicationCode = code >= 3000 && code <= 4999;
	if (!Number.isInteger(code) || (!isProtocolCode && !isApplicationCode)) {
		throw new RangeError(`Invalid WebSocket close code: ${code}.`);
	}
}

function isEnvelopeEncodingError(error: unknown): boolean {
	return (
		error instanceof RpcFrameTooLargeError ||
		(error instanceof ProcessRpcError && error.code === "INVALID_OUTBOUND_FRAME")
	);
}
