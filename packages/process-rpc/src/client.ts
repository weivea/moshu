import type { RpcHandshakeHeadersProvider } from "./authentication";
import { RpcHandshakeError } from "./errors";
import { hasSafeRpcJsonStructure } from "./json-structure";
import { type ResolvedRpcLimits, resolveRpcLimits } from "./limits";
import { type RpcEndpointOptions, RpcPeer, type RpcSocketTransport } from "./peer";
import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	hasUnsupportedRpcSchemaVersion,
	isSameRpcPeerIdentity,
	PROCESS_RPC_SCHEMA_VERSION,
	type RpcEnvelope,
	type RpcHelloAckEnvelope,
	type RpcHelloEnvelope,
	type RpcPeerIdentity,
	type RpcPeerRole,
	type RpcProtocolErrorCode,
	type RpcProtocolVersion,
	rpcEnvelopeSchema,
	rpcHelloAckEnvelopeSchema,
	rpcPeerIdentitySchema,
	rpcProtocolErrorEnvelopeSchema,
	rpcProtocolVersionSchema,
} from "./protocol";
import {
	RpcWebSocketClient,
	type RpcWebSocketClient as RpcWebSocketClientInstance,
	type RpcWebSocketRawData,
} from "./rpc-websocket-client";
import {
	connectStreamingWebSocketClient,
	type StreamingWebSocketConnection,
} from "./streaming-websocket-client";

export interface ConnectRpcClientOptions extends RpcEndpointOptions {
	readonly url: string | URL;
	readonly identity: RpcPeerIdentity;
	readonly protocol?: RpcProtocolVersion;
	/**
	 * Requires the hello acknowledgement to contain this exact authenticated server identity before
	 * any peer handlers are activated.
	 */
	readonly expectedServerIdentity?: RpcPeerIdentity;
	/** @deprecated Prefer `expectedServerIdentity` when the server identity is known. */
	readonly expectedServerRole?: RpcPeerRole;
	/** @deprecated Prefer `expectedServerIdentity` when the server identity is known. */
	readonly expectedServerPeerId?: string;
	readonly signal?: AbortSignal;
	/**
	 * Produces sensitive HTTP upgrade headers at connection time. Post-upgrade listeners do not
	 * retain the provider or returned object, and headers are never serialized into RPC envelopes.
	 */
	readonly getHandshakeHeaders?: RpcHandshakeHeadersProvider;
}

interface ResolvedClientOptions {
	readonly endpoint: RpcEndpointOptions;
	readonly expectedServerIdentity: RpcPeerIdentity | undefined;
	readonly expectedServerPeerId: string | undefined;
	readonly expectedServerRole: RpcPeerRole;
	readonly identity: RpcPeerIdentity;
	readonly limits: ResolvedRpcLimits;
	readonly protocol: RpcProtocolVersion;
	readonly signal: AbortSignal | undefined;
	readonly url: string;
}

const textEncoder = new TextEncoder();

/**
 * Connects to an agents server, completes the authenticated versioned handshake, and returns an
 * `RpcPeer`. The `ws` adapter enforces `maxFrameBytes` while frames are assembled.
 */
export function connectRpcClient(options: ConnectRpcClientOptions): Promise<RpcPeer> {
	const resolved = resolveClientOptions(options);
	const connection = openStreamingConnection(
		resolved.url,
		resolved.limits,
		options.getHandshakeHeaders,
		resolved.signal,
	);
	return finishClientConnection(connection, resolved);
}

function resolveClientOptions(options: ConnectRpcClientOptions): ResolvedClientOptions {
	const endpoint: RpcEndpointOptions = {
		...(options.handlers === undefined ? {} : { handlers: options.handlers }),
		...(options.methodAllowlist === undefined ? {} : { methodAllowlist: options.methodAllowlist }),
		...(options.onClose === undefined ? {} : { onClose: options.onClose }),
		...(options.onError === undefined ? {} : { onError: options.onError }),
		...(options.onProtocolError === undefined ? {} : { onProtocolError: options.onProtocolError }),
	};

	return {
		endpoint,
		expectedServerIdentity:
			options.expectedServerIdentity === undefined
				? undefined
				: rpcPeerIdentitySchema.parse(options.expectedServerIdentity),
		expectedServerPeerId: options.expectedServerPeerId,
		expectedServerRole: options.expectedServerRole ?? "agents",
		identity: rpcPeerIdentitySchema.parse(options.identity),
		limits: resolveRpcLimits(options.limits),
		protocol: rpcProtocolVersionSchema.parse(options.protocol ?? CURRENT_PROCESS_RPC_PROTOCOL),
		signal: options.signal,
		url: options.url.toString(),
	};
}

async function openStreamingConnection(
	url: string,
	limits: ResolvedRpcLimits,
	provider: RpcHandshakeHeadersProvider | undefined,
	signal: AbortSignal | undefined,
): Promise<StreamingWebSocketConnection> {
	const headers = await resolveHandshakeHeadersWithAbort(provider, signal);
	return connectStreamingWebSocketClient({
		url,
		handshakeTimeoutMs: limits.handshakeTimeoutMs,
		maxPayloadBytes: limits.maxFrameBytes,
		...(headers === undefined ? {} : { headers }),
		...(signal === undefined ? {} : { signal }),
	});
}

function resolveHandshakeHeadersWithAbort(
	provider: RpcHandshakeHeadersProvider | undefined,
	signal: AbortSignal | undefined,
): Promise<Readonly<Record<string, string>> | undefined> {
	if (signal === undefined) {
		return resolveHandshakeHeaders(provider);
	}
	if (signal.aborted) {
		return Promise.reject(createClientAbortError(signal.reason));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(createClientAbortError(signal.reason));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		resolveHandshakeHeaders(provider).then(
			(headers) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(headers);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
		}
	});
}

function createClientAbortError(reason: unknown): RpcHandshakeError {
	return new RpcHandshakeError(
		"INTERNAL_ERROR",
		"RPC client connection was aborted.",
		reason === undefined ? undefined : { cause: reason },
	);
}

async function finishClientConnection(
	connectionPromise: Promise<StreamingWebSocketConnection>,
	options: ResolvedClientOptions,
): Promise<RpcPeer> {
	let connection: StreamingWebSocketConnection;
	try {
		connection = await connectionPromise;
	} catch (error) {
		throw error instanceof RpcHandshakeError
			? error
			: new RpcHandshakeError("INTERNAL_ERROR", "Failed to create the WebSocket client.", {
					cause: error,
				});
	}
	return completeRpcHandshake(connection, options);
}

function completeRpcHandshake(
	connection: StreamingWebSocketConnection,
	options: ResolvedClientOptions,
): Promise<RpcPeer> {
	return new Promise<RpcPeer>((resolve, reject) => {
		let settled = false;
		let connectedPeer: RpcPeer | null = null;
		let failedSocketSinkAttached = false;
		const socket = connection.socket;
		const handshakeTimer = setTimeout(() => {
			failHandshake("HANDSHAKE_TIMEOUT", "Timed out waiting for the hello acknowledgement.");
		}, options.limits.handshakeTimeoutMs);

		const cleanupFailedSocketSink = (): void => {
			if (!failedSocketSinkAttached) {
				return;
			}
			failedSocketSinkAttached = false;
			socket.off("error", onFailedSocketError);
			socket.off("close", onFailedSocketClose);
		};
		const onFailedSocketError = (): void => undefined;
		const onFailedSocketClose = (): void => cleanupFailedSocketSink();
		const armFailedSocketSink = (): void => {
			if (failedSocketSinkAttached) {
				return;
			}
			failedSocketSinkAttached = true;
			socket.on("error", onFailedSocketError);
			socket.once("close", onFailedSocketClose);
		};
		const cleanupHandshakeListeners = (removePingListener: boolean): void => {
			clearTimeout(handshakeTimer);
			socket.off("message", onHandshakeMessage);
			socket.off("error", onHandshakeError);
			socket.off("close", onHandshakeClose);
			if (removePingListener) {
				socket.off("ping", onPing);
			}
			options.signal?.removeEventListener("abort", onAbort);
		};

		const failHandshake = (code: RpcProtocolErrorCode, message: string, cause?: unknown): void => {
			if (settled) {
				return;
			}
			settled = true;
			armFailedSocketSink();
			let closeFailure: unknown;
			try {
				if (socket.readyState !== RpcWebSocketClient.CLOSED) {
					socket.terminate();
				}
			} catch (error) {
				closeFailure = error;
			}
			cleanupHandshakeListeners(true);
			if (socket.readyState === RpcWebSocketClient.CLOSED) {
				queueMicrotask(cleanupFailedSocketSink);
			}
			let rejectionCause = cause;
			if (closeFailure !== undefined) {
				rejectionCause =
					cause === undefined
						? closeFailure
						: new AggregateError(
								[cause, closeFailure],
								"RPC handshake and WebSocket cleanup both failed.",
							);
			}
			reject(
				new RpcHandshakeError(
					code,
					message,
					rejectionCause === undefined ? undefined : { cause: rejectionCause },
				),
			);
		};

		const finishHandshake = (ack: RpcHelloAckEnvelope): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanupHandshakeListeners(false);
			const peer = new RpcPeer({
				localIdentity: options.identity,
				remoteIdentity: ack.peer,
				protocol: ack.protocol,
				resolvedLimits: options.limits,
				transport: createClientTransport(socket, options.limits.maxBufferedOutboundBytes),
				...options.endpoint,
			});
			connectedPeer = peer;
			attachPeerListeners(socket, peer);
			resolve(peer);
		};

		const onHandshakeMessage = (data: RpcWebSocketRawData, isBinary: boolean): void => {
			try {
				processHandshakeMessage(data, isBinary);
			} catch (error) {
				failHandshake("MALFORMED_FRAME", "Handshake response validation failed.", error);
			}
		};
		const processHandshakeMessage = (data: RpcWebSocketRawData, isBinary: boolean): void => {
			if (isBinary) {
				failHandshake("MALFORMED_FRAME", "Handshake response must be a text frame.");
				return;
			}

			const text = rawDataToText(data);
			if (!hasSafeRpcJsonStructure(text)) {
				failHandshake("MALFORMED_FRAME", "Handshake response exceeded the JSON structural limits.");
				return;
			}
			let decoded: unknown;
			try {
				decoded = JSON.parse(text);
			} catch (error) {
				failHandshake("MALFORMED_FRAME", "Handshake response was not valid JSON.", error);
				return;
			}
			if (hasUnsupportedRpcSchemaVersion(decoded)) {
				failHandshake("UNSUPPORTED_SCHEMA", "Server selected an unsupported schema version.");
				return;
			}

			const protocolError = rpcProtocolErrorEnvelopeSchema.safeParse(decoded);
			if (protocolError.success) {
				failHandshake(protocolError.data.code, protocolError.data.message);
				return;
			}
			const ack = rpcHelloAckEnvelopeSchema.safeParse(decoded);
			if (!ack.success) {
				failHandshake("MALFORMED_FRAME", "Handshake response was not a valid hello-ack envelope.");
				return;
			}
			if (
				ack.data.protocol.major !== options.protocol.major ||
				ack.data.protocol.minor > options.protocol.minor
			) {
				failHandshake("UNSUPPORTED_PROTOCOL", "Server selected an incompatible protocol version.");
				return;
			}
			if (!isSameRpcPeerIdentity(ack.data.acceptedPeer, options.identity)) {
				failHandshake(
					"IDENTITY_MISMATCH",
					"Server acknowledgement did not echo the client identity.",
				);
				return;
			}
			const exactIdentityMismatch =
				options.expectedServerIdentity !== undefined &&
				!isSameRpcPeerIdentity(ack.data.peer, options.expectedServerIdentity);
			const legacyIdentityMismatch =
				options.expectedServerIdentity === undefined &&
				(ack.data.peer.role !== options.expectedServerRole ||
					(options.expectedServerPeerId !== undefined &&
						ack.data.peer.peerId !== options.expectedServerPeerId));
			if (exactIdentityMismatch || legacyIdentityMismatch) {
				failHandshake("IDENTITY_MISMATCH", "Server identity did not match the expected peer.");
				return;
			}

			finishHandshake(ack.data);
		};
		const onHandshakeError = (error: Error): void => {
			failHandshake("INTERNAL_ERROR", "WebSocket failed during the RPC handshake.", error);
		};
		const onHandshakeClose = (code: number, reason: Buffer): void => {
			failHandshake(
				"INTERNAL_ERROR",
				`WebSocket closed during the RPC handshake (${code}): ${reason.toString("utf8")}`,
			);
		};
		const onAbort = (): void => {
			failHandshake("INTERNAL_ERROR", "RPC client connection was aborted.", options.signal?.reason);
		};
		const onPing = (data: Buffer): void => {
			try {
				sendBudgetedClientData(
					socket,
					data,
					options.limits.maxBufferedOutboundBytes,
					"WebSocket pong",
					() => socket.pong(data, true),
				);
			} catch (error) {
				if (connectedPeer === null) {
					failHandshake("INTERNAL_ERROR", "Failed to send a budgeted WebSocket pong.", error);
					return;
				}
				connectedPeer.handleTransportError(error);
				try {
					socket.terminate();
				} catch (terminateError) {
					connectedPeer.handleTransportError(terminateError);
				}
			}
		};

		socket.on("ping", onPing);
		socket.on("message", onHandshakeMessage);
		socket.on("error", onHandshakeError);
		socket.on("close", onHandshakeClose);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted === true) {
			onAbort();
			return;
		}

		const hello: RpcHelloEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: options.protocol,
			type: "hello",
			peer: options.identity,
		};
		try {
			sendClientEnvelope(socket, hello, options.limits);
			connection.resume();
		} catch (error) {
			failHandshake("INTERNAL_ERROR", "Failed to send the hello envelope.", error);
		}
	});
}

function attachPeerListeners(socket: RpcWebSocketClientInstance, peer: RpcPeer): void {
	socket.on("message", (data, isBinary) => {
		try {
			if (isBinary) {
				peer.handleBinaryFrame();
				return;
			}
			peer.handleTextFrame(rawDataToText(data));
		} catch (error) {
			peer.handleTransportError(error);
			peer.rejectProtocol("MALFORMED_FRAME", "Frame decoding failed.", true);
		}
	});
	socket.on("error", (error) => {
		peer.handleTransportError(error);
		if (socket.readyState !== RpcWebSocketClient.CLOSED) {
			try {
				socket.terminate();
			} catch (terminateError) {
				peer.handleTransportError(terminateError);
			}
		}
	});
	socket.on("close", (code, reason) => {
		peer.handleTransportClose(code, reason.toString("utf8"));
	});
}

function createClientTransport(
	socket: RpcWebSocketClientInstance,
	maxBufferedOutboundBytes: number,
): RpcSocketTransport {
	return {
		send(text) {
			if (socket.readyState !== RpcWebSocketClient.OPEN) {
				throw new Error("Client WebSocket is not open.");
			}
			sendBudgetedClientData(socket, text, maxBufferedOutboundBytes, "RPC frame", () =>
				socket.send(text),
			);
		},
		close(code, reason) {
			socket.close(code, reason);
		},
		terminate() {
			socket.terminate();
		},
		isOpen() {
			return socket.readyState === RpcWebSocketClient.OPEN;
		},
	};
}

function sendClientEnvelope(
	socket: RpcWebSocketClientInstance,
	envelope: RpcEnvelope,
	limits: ResolvedRpcLimits,
): void {
	const parsed = rpcEnvelopeSchema.parse(envelope);
	const text = JSON.stringify(parsed);
	if (textEncoder.encode(text).byteLength > limits.maxFrameBytes) {
		throw new RangeError("Handshake frame exceeds maxFrameBytes.");
	}
	sendBudgetedClientData(socket, text, limits.maxBufferedOutboundBytes, "RPC handshake", () =>
		socket.send(text),
	);
}

function sendBudgetedClientData(
	socket: RpcWebSocketClientInstance,
	data: string | Buffer,
	maxBufferedOutboundBytes: number,
	description: string,
	send: () => void,
): void {
	const payloadBytes =
		typeof data === "string" ? textEncoder.encode(data).byteLength : data.byteLength;
	if (socket.bufferedAmount + payloadBytes > maxBufferedOutboundBytes) {
		socket.terminate();
		throw new Error(`${description} exceeded the outbound buffered-byte limit.`);
	}
	send();
}

async function resolveHandshakeHeaders(
	provider: RpcHandshakeHeadersProvider | undefined,
): Promise<Readonly<Record<string, string>> | undefined> {
	if (provider === undefined) {
		return undefined;
	}

	let headersInit: Bun.HeadersInit;
	try {
		headersInit = await provider();
	} catch (error) {
		throw new RpcHandshakeError(
			"AUTHENTICATION_FAILED",
			"Failed to prepare RPC handshake credentials.",
			{ cause: error },
		);
	}

	if (isStringHeaderRecord(headersInit)) {
		return headersInit;
	}
	if (Array.isArray(headersInit)) {
		const resolved: Record<string, string> = {};
		for (const entry of headersInit) {
			if (entry.length !== 2 || entry[0] === undefined || entry[1] === undefined) {
				throw new RpcHandshakeError(
					"AUTHENTICATION_FAILED",
					"RPC handshake headers must contain name/value pairs.",
				);
			}
			const existing = resolved[entry[0]];
			resolved[entry[0]] = existing === undefined ? entry[1] : `${existing}, ${entry[1]}`;
		}
		return resolved;
	}
	const resolved: Record<string, string> = {};
	if (headersInit instanceof Headers) {
		headersInit.forEach((value, name) => {
			resolved[name] = value;
		});
		return resolved;
	}
	for (const [name, value] of Object.entries(headersInit)) {
		resolved[name] = typeof value === "string" ? value : value.join(", ");
	}
	return resolved;
}

function isStringHeaderRecord(value: Bun.HeadersInit): value is Readonly<Record<string, string>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.values(value).every((headerValue) => typeof headerValue === "string")
	);
}

function rawDataToText(data: RpcWebSocketRawData): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString("utf8");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}
