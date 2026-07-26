import type { JsonValue, RpcProtocolErrorCode, RpcResponseError } from "./protocol";

export class ProcessRpcError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProcessRpcError";
		this.code = code;
	}
}

export class RpcHandshakeError extends ProcessRpcError {
	declare readonly code: RpcProtocolErrorCode;

	constructor(code: RpcProtocolErrorCode, message: string, options?: ErrorOptions) {
		super(code, message, options);
		this.name = "RpcHandshakeError";
	}
}

export class RpcConnectionClosedError extends ProcessRpcError {
	readonly closeCode: number;
	readonly reason: string;

	constructor(closeCode: number, reason: string, options?: ErrorOptions) {
		super("CONNECTION_CLOSED", `RPC connection closed (${closeCode}): ${reason}`, options);
		this.name = "RpcConnectionClosedError";
		this.closeCode = closeCode;
		this.reason = reason;
	}
}

export class RpcTimeoutError extends ProcessRpcError {
	readonly requestId: string;
	readonly timeoutMs: number;

	constructor(requestId: string, timeoutMs: number) {
		super("DEADLINE_EXCEEDED", `RPC request "${requestId}" exceeded its ${timeoutMs}ms deadline.`);
		this.name = "RpcTimeoutError";
		this.requestId = requestId;
		this.timeoutMs = timeoutMs;
	}
}

export class RpcCancelledError extends ProcessRpcError {
	readonly requestId: string;

	constructor(requestId: string, reason = "RPC request was cancelled.") {
		super("CANCELLED", reason);
		this.name = "RpcCancelledError";
		this.requestId = requestId;
	}
}

export class RpcRemoteError extends ProcessRpcError {
	readonly requestId: string;
	readonly data: JsonValue | undefined;

	constructor(requestId: string, error: RpcResponseError) {
		super(error.code, error.message);
		this.name = "RpcRemoteError";
		this.requestId = requestId;
		this.data = error.data;
	}
}

export class RpcHandlerError extends ProcessRpcError {
	readonly data: JsonValue | undefined;

	constructor(code: string, message: string, data?: JsonValue) {
		super(code, message);
		this.name = "RpcHandlerError";
		this.data = data;
	}
}

export class RpcRequestLimitError extends ProcessRpcError {
	constructor(limit: number) {
		super("REQUEST_LIMIT_EXCEEDED", `RPC pending request limit of ${limit} was reached.`);
		this.name = "RpcRequestLimitError";
	}
}

export class RpcFrameTooLargeError extends ProcessRpcError {
	readonly frameBytes: number;
	readonly maxFrameBytes: number;

	constructor(frameBytes: number, maxFrameBytes: number) {
		super(
			"FRAME_TOO_LARGE",
			`RPC frame is ${frameBytes} bytes; the configured maximum is ${maxFrameBytes} bytes.`,
		);
		this.name = "RpcFrameTooLargeError";
		this.frameBytes = frameBytes;
		this.maxFrameBytes = maxFrameBytes;
	}
}
