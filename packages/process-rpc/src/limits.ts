export interface RpcLimits {
	readonly maxFrameBytes?: number;
	readonly maxBufferedOutboundBytes?: number;
	readonly maxPendingRequests?: number;
	readonly maxConcurrentRequests?: number;
	/** Maximum event handlers that may remain unsettled for one connection. */
	readonly maxConcurrentEvents?: number;
	readonly requestTimeoutMs?: number;
	readonly maxRequestTimeoutMs?: number;
	readonly handshakeTimeoutMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
}

export interface ResolvedRpcLimits {
	readonly maxFrameBytes: number;
	readonly maxBufferedOutboundBytes: number;
	readonly maxPendingRequests: number;
	readonly maxConcurrentRequests: number;
	readonly maxConcurrentEvents: number;
	readonly requestTimeoutMs: number;
	readonly maxRequestTimeoutMs: number;
	readonly handshakeTimeoutMs: number;
	readonly heartbeatIntervalMs: number;
	readonly heartbeatTimeoutMs: number;
}

// Keeps allocation limits well below the signed 32-bit maximum used by the pinned `ws` receiver.
export const MAX_RPC_FRAME_BYTES = 64 * 1024 * 1024;
// Covers the maximally escaped, schema-bounded hello-ack and protocol-error envelopes.
export const MIN_RPC_FRAME_BYTES = 8 * 1024;
export const MAX_RPC_TIMER_MS = 0x7fffffff;

export const DEFAULT_RPC_LIMITS: ResolvedRpcLimits = Object.freeze({
	maxFrameBytes: 1024 * 1024,
	maxBufferedOutboundBytes: 4 * 1024 * 1024,
	maxPendingRequests: 256,
	maxConcurrentRequests: 128,
	maxConcurrentEvents: 128,
	requestTimeoutMs: 30_000,
	maxRequestTimeoutMs: 5 * 60_000,
	handshakeTimeoutMs: 5_000,
	heartbeatIntervalMs: 15_000,
	heartbeatTimeoutMs: 45_000,
});

export function resolveRpcLimits(input: RpcLimits = {}): ResolvedRpcLimits {
	const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_RPC_LIMITS.maxFrameBytes;
	const limits: ResolvedRpcLimits = {
		maxFrameBytes,
		maxBufferedOutboundBytes:
			input.maxBufferedOutboundBytes ??
			Math.max(DEFAULT_RPC_LIMITS.maxBufferedOutboundBytes, maxFrameBytes),
		maxPendingRequests: input.maxPendingRequests ?? DEFAULT_RPC_LIMITS.maxPendingRequests,
		maxConcurrentRequests: input.maxConcurrentRequests ?? DEFAULT_RPC_LIMITS.maxConcurrentRequests,
		maxConcurrentEvents: input.maxConcurrentEvents ?? DEFAULT_RPC_LIMITS.maxConcurrentEvents,
		requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_RPC_LIMITS.requestTimeoutMs,
		maxRequestTimeoutMs: input.maxRequestTimeoutMs ?? DEFAULT_RPC_LIMITS.maxRequestTimeoutMs,
		handshakeTimeoutMs: input.handshakeTimeoutMs ?? DEFAULT_RPC_LIMITS.handshakeTimeoutMs,
		heartbeatIntervalMs: input.heartbeatIntervalMs ?? DEFAULT_RPC_LIMITS.heartbeatIntervalMs,
		heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? DEFAULT_RPC_LIMITS.heartbeatTimeoutMs,
	};

	assertPositiveInteger("maxFrameBytes", limits.maxFrameBytes);
	assertPositiveInteger("maxBufferedOutboundBytes", limits.maxBufferedOutboundBytes);
	assertPositiveInteger("maxPendingRequests", limits.maxPendingRequests);
	assertPositiveInteger("maxConcurrentRequests", limits.maxConcurrentRequests);
	assertPositiveInteger("maxConcurrentEvents", limits.maxConcurrentEvents);
	assertPositiveInteger("requestTimeoutMs", limits.requestTimeoutMs);
	assertPositiveInteger("maxRequestTimeoutMs", limits.maxRequestTimeoutMs);
	assertPositiveInteger("handshakeTimeoutMs", limits.handshakeTimeoutMs);
	assertNonnegativeInteger("heartbeatIntervalMs", limits.heartbeatIntervalMs);
	assertPositiveInteger("heartbeatTimeoutMs", limits.heartbeatTimeoutMs);

	if (limits.maxFrameBytes < MIN_RPC_FRAME_BYTES) {
		throw new RangeError(`maxFrameBytes must be at least ${MIN_RPC_FRAME_BYTES}.`);
	}
	if (limits.maxFrameBytes > MAX_RPC_FRAME_BYTES) {
		throw new RangeError(`maxFrameBytes cannot exceed ${MAX_RPC_FRAME_BYTES}.`);
	}
	if (limits.maxBufferedOutboundBytes < limits.maxFrameBytes) {
		throw new RangeError("maxBufferedOutboundBytes cannot be less than maxFrameBytes.");
	}
	if (limits.maxBufferedOutboundBytes > MAX_RPC_FRAME_BYTES) {
		throw new RangeError(`maxBufferedOutboundBytes cannot exceed ${MAX_RPC_FRAME_BYTES}.`);
	}
	assertTimerRange("requestTimeoutMs", limits.requestTimeoutMs);
	assertTimerRange("maxRequestTimeoutMs", limits.maxRequestTimeoutMs);
	assertTimerRange("handshakeTimeoutMs", limits.handshakeTimeoutMs);
	assertTimerRange("heartbeatIntervalMs", limits.heartbeatIntervalMs);
	assertTimerRange("heartbeatTimeoutMs", limits.heartbeatTimeoutMs);
	if (limits.requestTimeoutMs > limits.maxRequestTimeoutMs) {
		throw new RangeError("requestTimeoutMs cannot exceed maxRequestTimeoutMs.");
	}

	function assertTimerRange(name: string, value: number): void {
		if (value > MAX_RPC_TIMER_MS) {
			throw new RangeError(`${name} cannot exceed ${MAX_RPC_TIMER_MS}.`);
		}
	}
	if (limits.heartbeatIntervalMs > 0 && limits.heartbeatTimeoutMs <= limits.heartbeatIntervalMs) {
		throw new RangeError("heartbeatTimeoutMs must exceed heartbeatIntervalMs when enabled.");
	}

	return Object.freeze(limits);
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer.`);
	}
}

function assertNonnegativeInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a nonnegative safe integer.`);
	}
}
