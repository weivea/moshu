import {
	type RpcHandshakeAuthenticator,
	RpcHandshakeHttpError,
	type RpcHttpRequestContext,
} from "./authentication";
import { invokeRpcCallback } from "./callback-errors";
import { RpcHandshakeError } from "./errors";
import {
	InMemoryRpcGenerationFence,
	type RpcGenerationFence,
	type RpcGenerationLease,
} from "./generation-fence";
import { hasSafeRpcJsonStructure } from "./json-structure";
import { type ResolvedRpcLimits, resolveRpcLimits } from "./limits";
import { type RpcEndpointOptions, RpcPeer, type RpcSocketTransport } from "./peer";
import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	hasUnsupportedRpcSchemaVersion,
	isSameRpcPeerIdentity,
	negotiateRpcProtocol,
	PROCESS_RPC_SCHEMA_VERSION,
	type RpcEnvelope,
	type RpcHelloAckEnvelope,
	type RpcPeerIdentity,
	type RpcPeerRole,
	type RpcProtocolErrorCode,
	type RpcProtocolErrorEnvelope,
	type RpcProtocolVersion,
	rpcEnvelopeSchema,
	rpcHelloEnvelopeSchema,
	rpcPeerIdentitySchema,
	rpcProtocolVersionSchema,
} from "./protocol";
import { truncateWebSocketCloseReason } from "./websocket-utils";

export interface RpcServerBaseOptions extends RpcEndpointOptions {
	readonly identity: RpcPeerIdentity;
	readonly hostname?: string;
	readonly port?: number;
	readonly path?: string;
	readonly maxRequestBodyBytes?: number;
	readonly protocol?: RpcProtocolVersion;
	readonly acceptedPeerRoles?: readonly RpcPeerRole[];
	readonly generationFence?: RpcGenerationFence;
	readonly onConnection?: (peer: RpcPeer) => void | Promise<void>;
	readonly handleHttpRequest?: (
		request: Request,
		context: RpcHttpRequestContext,
	) => Response | undefined | Promise<Response | undefined>;
}

export type RpcServerOptions = RpcServerBaseOptions &
	(
		| {
				/**
				 * Authenticates the HTTP upgrade and returns the connection's canonical identity.
				 */
				readonly authenticate: RpcHandshakeAuthenticator;
				readonly dangerouslyAllowUnauthenticated?: never;
		  }
		| {
				readonly authenticate?: never;
				/**
				 * Disables peer authentication. Intended only for isolated tests.
				 */
				readonly dangerouslyAllowUnauthenticated: true;
		  }
	);

interface RpcServerSocketData {
	phase: "awaiting-hello" | "validating" | "open" | "closed";
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	peer: RpcPeer | null;
	generationLease: RpcGenerationLease | null;
	authenticatedIdentity: RpcPeerIdentity | null;
}

const textEncoder = new TextEncoder();

/**
 * Bun WebSocket RPC server. It binds to loopback and a dynamic port by default.
 */
export class RpcServer {
	readonly identity: RpcPeerIdentity;
	readonly protocol: RpcProtocolVersion;
	readonly limits: ResolvedRpcLimits;
	readonly hostname: string;
	readonly path: string;
	readonly #server: Bun.Server<RpcServerSocketData>;
	readonly #acceptedPeerRoles: ReadonlySet<RpcPeerRole>;
	readonly #generationFence: RpcGenerationFence;
	readonly #options: RpcServerOptions;
	readonly #peers = new Set<RpcPeer>();
	#stopped = false;

	constructor(options: RpcServerOptions) {
		const hasAuthenticator = options.authenticate !== undefined;
		const allowsUnauthenticated = options.dangerouslyAllowUnauthenticated === true;
		if (hasAuthenticator === allowsUnauthenticated) {
			throw new TypeError(
				"RPC servers require exactly one of authenticate or dangerouslyAllowUnauthenticated.",
			);
		}

		this.identity = rpcPeerIdentitySchema.parse(options.identity);
		this.protocol = rpcProtocolVersionSchema.parse(
			options.protocol ?? CURRENT_PROCESS_RPC_PROTOCOL,
		);
		this.limits = resolveRpcLimits(options.limits);
		this.hostname = options.hostname ?? "127.0.0.1";
		this.path = normalizePath(options.path ?? "/rpc");
		this.#acceptedPeerRoles = new Set(options.acceptedPeerRoles ?? ["client", "runtime-box"]);
		this.#generationFence = options.generationFence ?? new InMemoryRpcGenerationFence();
		this.#options = options;
		if (
			options.maxRequestBodyBytes !== undefined &&
			(!Number.isSafeInteger(options.maxRequestBodyBytes) || options.maxRequestBodyBytes <= 0)
		) {
			throw new TypeError("maxRequestBodyBytes must be a positive safe integer.");
		}

		this.#server = Bun.serve<RpcServerSocketData>({
			hostname: this.hostname,
			port: options.port ?? 0,
			...(options.maxRequestBodyBytes === undefined
				? {}
				: { maxRequestBodySize: options.maxRequestBodyBytes }),
			fetch: async (request, server) => {
				const requestContext: RpcHttpRequestContext = {
					remoteAddress: server.requestIP(request)?.address ?? null,
				};
				const handled = await this.#options.handleHttpRequest?.(request, requestContext);
				if (handled !== undefined) {
					return handled;
				}
				if (new URL(request.url).pathname !== this.path) {
					return new Response("Not found.", { status: 404 });
				}

				let authenticatedIdentity: RpcPeerIdentity | null = null;
				if (this.#options.authenticate !== undefined) {
					let authenticated: RpcPeerIdentity | null;
					try {
						authenticated = await this.#options.authenticate(request, requestContext);
					} catch (error) {
						if (error instanceof RpcHandshakeHttpError) {
							return new Response(error.message, {
								status: error.status,
								headers: {
									"cache-control": "no-store",
									...error.headers,
								},
							});
						}
						throw error;
					}
					if (authenticated === null) {
						return new Response("RPC authentication failed.", {
							status: 401,
							headers: {
								"cache-control": "no-store",
							},
						});
					}
					authenticatedIdentity = rpcPeerIdentitySchema.parse(authenticated);
				}

				const upgraded = server.upgrade(request, {
					data: {
						phase: "awaiting-hello",
						handshakeTimer: null,
						peer: null,
						generationLease: null,
						authenticatedIdentity,
					},
				});
				return upgraded ? undefined : new Response("WebSocket upgrade required.", { status: 426 });
			},
			websocket: {
				maxPayloadLength: this.limits.maxFrameBytes,
				backpressureLimit: this.limits.maxBufferedOutboundBytes,
				closeOnBackpressureLimit: true,
				open: (socket) => {
					socket.binaryType = "nodebuffer";
					socket.data.handshakeTimer = setTimeout(() => {
						if (socket.data.phase === "awaiting-hello") {
							this.#rejectHandshake(
								socket,
								"HANDSHAKE_TIMEOUT",
								"Timed out waiting for the hello envelope.",
							);
						}
					}, this.limits.handshakeTimeoutMs);
				},
				message: (socket, message) => {
					if (socket.data.phase === "open") {
						if (typeof message === "string") {
							socket.data.peer?.handleTextFrame(message);
						} else {
							socket.data.peer?.handleBinaryFrame();
						}
						return;
					}
					if (socket.data.phase !== "awaiting-hello") {
						this.#rejectHandshake(
							socket,
							"UNEXPECTED_MESSAGE",
							"Received another frame while validating the handshake.",
						);
						return;
					}
					if (typeof message !== "string") {
						this.#rejectHandshake(
							socket,
							"MALFORMED_FRAME",
							"Binary WebSocket frames are not supported.",
						);
						return;
					}
					this.#handleHello(socket, message);
				},
				close: (socket, code, reason) => {
					socket.data.phase = "closed";
					this.#clearHandshakeTimer(socket.data);
					if (socket.data.peer !== null) {
						socket.data.peer.handleTransportClose(code, reason);
					} else {
						socket.data.generationLease?.release();
						socket.data.generationLease = null;
					}
				},
			},
		});
	}

	get port(): number {
		const port = this.#server.port;
		if (port === undefined) {
			throw new Error("RPC server is not listening on a TCP port.");
		}
		return port;
	}

	get url(): string {
		return `ws://${formatHostname(this.hostname)}:${this.port}${this.path}`;
	}

	get peers(): readonly RpcPeer[] {
		return [...this.#peers];
	}

	findPeer(role: RpcPeerRole, peerId: string): RpcPeer | undefined {
		return [...this.#peers].find(
			(peer) => peer.remoteIdentity.role === role && peer.remoteIdentity.peerId === peerId,
		);
	}

	stop(): void {
		if (this.#stopped) {
			return;
		}
		this.#stopped = true;
		for (const peer of [...this.#peers]) {
			peer.close(1001, "RPC server stopped.");
		}
		void this.#server.stop(true);
	}

	#handleHello(socket: Bun.ServerWebSocket<RpcServerSocketData>, text: string): void {
		socket.data.phase = "validating";
		this.#clearHandshakeTimer(socket.data);

		try {
			this.#parseHello(socket, text);
		} catch {
			this.#rejectHandshake(socket, "MALFORMED_FRAME", "Handshake validation failed.");
		}
	}

	#parseHello(socket: Bun.ServerWebSocket<RpcServerSocketData>, text: string): void {
		if (textEncoder.encode(text).byteLength > this.limits.maxFrameBytes) {
			this.#rejectHandshake(
				socket,
				"FRAME_TOO_LARGE",
				`Handshake exceeded the ${this.limits.maxFrameBytes}-byte limit.`,
			);
			return;
		}
		if (!hasSafeRpcJsonStructure(text)) {
			this.#rejectHandshake(
				socket,
				"MALFORMED_FRAME",
				"Handshake exceeded the JSON structural limits.",
			);
			return;
		}

		let decoded: unknown;
		try {
			decoded = JSON.parse(text);
		} catch {
			this.#rejectHandshake(socket, "MALFORMED_FRAME", "Handshake was not valid JSON.");
			return;
		}
		if (hasUnsupportedRpcSchemaVersion(decoded)) {
			this.#rejectHandshake(
				socket,
				"UNSUPPORTED_SCHEMA",
				`Schema version must be ${PROCESS_RPC_SCHEMA_VERSION}.`,
			);
			return;
		}

		const parsed = rpcHelloEnvelopeSchema.safeParse(decoded);
		if (!parsed.success) {
			this.#rejectHandshake(
				socket,
				"MALFORMED_FRAME",
				"First frame must be a valid hello envelope.",
			);
			return;
		}

		const authenticatedIdentity = socket.data.authenticatedIdentity;
		if (
			authenticatedIdentity !== null &&
			!isSameRpcPeerIdentity(authenticatedIdentity, parsed.data.peer)
		) {
			this.#rejectHandshake(
				socket,
				"IDENTITY_MISMATCH",
				"Hello identity did not match the authenticated peer.",
			);
			return;
		}
		const canonicalIdentity = authenticatedIdentity ?? parsed.data.peer;

		const negotiated = negotiateRpcProtocol(this.protocol, parsed.data.protocol);
		if (negotiated === null) {
			this.#rejectHandshake(
				socket,
				"UNSUPPORTED_PROTOCOL",
				`Protocol major ${parsed.data.protocol.major} is not supported.`,
			);
			return;
		}
		if (!this.#acceptedPeerRoles.has(canonicalIdentity.role)) {
			this.#rejectHandshake(
				socket,
				"ROLE_NOT_ALLOWED",
				`Role "${canonicalIdentity.role}" is not accepted by this server.`,
			);
			return;
		}

		const generationResult = this.#generationFence.acquire(canonicalIdentity, (replacement) => {
			const peer = socket.data.peer;
			if (peer !== null) {
				peer.rejectProtocol(
					"STALE_GENERATION",
					`Peer generation ${replacement.generation} replaced this connection.`,
					true,
				);
			}
		});
		if (!generationResult.accepted) {
			this.#rejectHandshake(
				socket,
				generationResult.code,
				`Peer generation ${canonicalIdentity.generation} was rejected; current generation is ${generationResult.currentGeneration}.`,
			);
			return;
		}
		socket.data.generationLease = generationResult.lease;

		const ack: RpcHelloAckEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: negotiated,
			type: "hello-ack",
			connectionId: crypto.randomUUID(),
			peer: this.identity,
			acceptedPeer: canonicalIdentity,
		};

		if (!sendServerEnvelope(socket, ack, this.limits)) {
			socket.data.generationLease.release();
			socket.data.generationLease = null;
			socket.data.phase = "closed";
			socket.close(1011, "Failed to send RPC handshake.");
			return;
		}

		const transport = createServerTransport(socket, this.limits.maxBufferedOutboundBytes);
		const peer = new RpcPeer({
			localIdentity: this.identity,
			remoteIdentity: canonicalIdentity,
			protocol: negotiated,
			resolvedLimits: this.limits,
			transport,
			...(this.#options.handlers === undefined ? {} : { handlers: this.#options.handlers }),
			...(this.#options.methodAllowlist === undefined
				? {}
				: { methodAllowlist: this.#options.methodAllowlist }),
			...(this.#options.requestTimeoutLimits === undefined
				? {}
				: { requestTimeoutLimits: this.#options.requestTimeoutLimits }),
			...(this.#options.onProtocolError === undefined
				? {}
				: { onProtocolError: this.#options.onProtocolError }),
			...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
			onClose: (info, closedPeer) => {
				this.#peers.delete(closedPeer);
				socket.data.generationLease?.release();
				socket.data.generationLease = null;
				invokeRpcCallback(
					() => this.#options.onClose?.(info, closedPeer),
					(error) => reportEndpointError(this.#options.onError, error, closedPeer),
				);
			},
		});
		socket.data.peer = peer;
		socket.data.phase = "open";
		this.#peers.add(peer);

		try {
			const connectionResult = this.#options.onConnection?.(peer);
			if (connectionResult !== undefined) {
				Promise.resolve(connectionResult).catch((error: unknown) => {
					reportEndpointError(this.#options.onError, error, peer);
					peer.close(1011, "RPC onConnection callback failed.");
				});
			}
		} catch (error) {
			reportEndpointError(this.#options.onError, error, peer);
			peer.close(1011, "RPC onConnection callback failed.");
		}
	}

	#rejectHandshake(
		socket: Bun.ServerWebSocket<RpcServerSocketData>,
		code: RpcProtocolErrorCode,
		message: string,
	): void {
		if (socket.data.phase === "closed") {
			return;
		}
		socket.data.phase = "closed";
		this.#clearHandshakeTimer(socket.data);
		const envelope: RpcProtocolErrorEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol: this.protocol,
			type: "protocol-error",
			code,
			message,
			fatal: true,
		};
		sendServerEnvelope(socket, envelope, this.limits);
		socket.close(1002, truncateWebSocketCloseReason(`${code}: ${message}`));
	}

	#clearHandshakeTimer(data: RpcServerSocketData): void {
		if (data.handshakeTimer !== null) {
			clearTimeout(data.handshakeTimer);
			data.handshakeTimer = null;
		}
	}
}

export function createRpcServer(options: RpcServerOptions): RpcServer {
	return new RpcServer(options);
}

function createServerTransport(
	socket: Bun.ServerWebSocket<RpcServerSocketData>,
	maxBufferedOutboundBytes: number,
): RpcSocketTransport {
	return {
		send(text) {
			if (socket.readyState !== WebSocket.OPEN) {
				throw new RpcHandshakeError("INTERNAL_ERROR", "Server WebSocket is not open.");
			}
			const frameBytes = textEncoder.encode(text).byteLength;
			if (socket.getBufferedAmount() + frameBytes > maxBufferedOutboundBytes) {
				socket.terminate();
				throw new RpcHandshakeError(
					"INTERNAL_ERROR",
					"Server outbound buffered-byte limit exceeded.",
				);
			}
			if (socket.sendText(text) === 0) {
				socket.terminate();
				throw new RpcHandshakeError("INTERNAL_ERROR", "Server WebSocket dropped a frame.");
			}
		},
		close(code, reason) {
			socket.close(code, reason);
		},
		terminate() {
			socket.terminate();
		},
		isOpen() {
			return socket.readyState === WebSocket.OPEN;
		},
	};
}

function sendServerEnvelope(
	socket: Bun.ServerWebSocket<RpcServerSocketData>,
	envelope: RpcEnvelope,
	limits: ResolvedRpcLimits,
): boolean {
	const parsed = rpcEnvelopeSchema.safeParse(envelope);
	if (!parsed.success) {
		return false;
	}
	const text = JSON.stringify(parsed.data);
	const frameBytes = textEncoder.encode(text).byteLength;
	if (
		frameBytes > limits.maxFrameBytes ||
		socket.getBufferedAmount() + frameBytes > limits.maxBufferedOutboundBytes
	) {
		socket.terminate();
		return false;
	}
	try {
		return socket.sendText(text) !== 0;
	} catch {
		return false;
	}
}

function normalizePath(path: string): string {
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new TypeError("RPC server path must be an absolute URL path without a query or hash.");
	}
	return path;
}

function formatHostname(hostname: string): string {
	return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function reportEndpointError(
	onError: RpcServerOptions["onError"],
	error: unknown,
	peer: RpcPeer,
): void {
	if (onError === undefined) {
		return;
	}
	invokeRpcCallback(() => onError(error, peer));
}
