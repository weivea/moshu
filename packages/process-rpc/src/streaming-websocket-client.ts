import { createHash, randomBytes } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

import { RpcHandshakeError } from "@moshu/process-rpc-core";

import {
	RpcWebSocketClient,
	type RpcWebSocketClient as RpcWebSocketClientInstance,
} from "./rpc-websocket-client";

const MAX_HTTP_UPGRADE_BYTES = 16 * 1024;
const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// RPC messages should be coarse JSON frames; these bounds tolerate normal network segmentation
// while terminating pathological fragment and buffered-chunk amplification.
export const RPC_WEBSOCKET_MAX_BUFFERED_CHUNKS = 1_024;
export const RPC_WEBSOCKET_MAX_FRAGMENTS = 128;
const reservedHeaders = new Set([
	"connection",
	"host",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-protocol",
	"sec-websocket-version",
	"upgrade",
]);

export interface StreamingWebSocketClientOptions {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly handshakeTimeoutMs: number;
	readonly maxPayloadBytes: number;
	readonly signal?: AbortSignal;
}

export interface StreamingWebSocketConnection {
	readonly socket: RpcWebSocketClientInstance;
	resume(): void;
}

/**
 * Opens the HTTP upgrade over a raw socket, then delegates frame streaming and payload limits to
 * the pinned `ws` receiver. This avoids Bun's unbounded native client message assembly.
 */
export function connectStreamingWebSocketClient(
	options: StreamingWebSocketClientOptions,
): Promise<StreamingWebSocketConnection> {
	const { url: inputUrl, headers, handshakeTimeoutMs, maxPayloadBytes, signal } = options;
	if (signal?.aborted === true) {
		return Promise.reject(createConnectionAbortedError(signal.reason));
	}
	const url = parseWebSocketUrl(inputUrl);
	const port = getPort(url);
	const websocketKey = randomBytes(16).toString("base64");
	const expectedAccept = createHash("sha1")
		.update(`${websocketKey}${WEBSOCKET_ACCEPT_GUID}`, "ascii")
		.digest("base64");
	const request = createUpgradeRequest(url, websocketKey, headers);

	return connectUpgradedSocket({
		expectedAccept,
		handshakeTimeoutMs,
		maxPayloadBytes,
		port,
		request,
		signal,
		url,
	});
}

interface UpgradeConnectionOptions {
	readonly expectedAccept: string;
	readonly handshakeTimeoutMs: number;
	readonly maxPayloadBytes: number;
	readonly port: number;
	readonly request: string;
	readonly signal: AbortSignal | undefined;
	readonly url: URL;
}

function connectUpgradedSocket({
	expectedAccept,
	handshakeTimeoutMs,
	maxPayloadBytes,
	port,
	request,
	signal,
	url,
}: UpgradeConnectionOptions): Promise<StreamingWebSocketConnection> {
	return new Promise<StreamingWebSocketConnection>((resolve, reject) => {
		let settled = false;
		let failureSinkAttached = false;
		let received = Buffer.alloc(0);
		let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
		const connectEvent = url.protocol === "wss:" ? "secureConnect" : "connect";
		const socket =
			url.protocol === "wss:"
				? connectTls({
						host: stripIpv6Brackets(url.hostname),
						port,
						servername: stripIpv6Brackets(url.hostname),
					})
				: connectTcp({
						host: stripIpv6Brackets(url.hostname),
						port,
					});

		const cleanup = (): void => {
			if (deadlineTimer !== null) {
				clearTimeout(deadlineTimer);
				deadlineTimer = null;
			}
			socket.setTimeout(0);
			socket.off(connectEvent, onConnect);
			socket.off("timeout", onTimeout);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
			socket.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};

		const cleanupFailureSink = (): void => {
			if (!failureSinkAttached) {
				return;
			}
			failureSinkAttached = false;
			socket.off("error", onFailureSocketError);
			socket.off("close", onFailureSocketClose);
		};
		const onFailureSocketError = (): void => undefined;
		const onFailureSocketClose = (): void => cleanupFailureSink();
		const armFailureSink = (): void => {
			if (failureSinkAttached) {
				return;
			}
			failureSinkAttached = true;
			socket.on("error", onFailureSocketError);
			socket.once("close", onFailureSocketClose);
		};
		const fail = (error: RpcHandshakeError): void => {
			if (settled) {
				return;
			}
			settled = true;
			armFailureSink();
			socket.destroy();
			cleanup();
			if (socket.closed) {
				queueMicrotask(cleanupFailureSink);
			}
			reject(error);
		};

		const onConnect = (): void => {
			try {
				socket.write(request);
			} catch (error) {
				fail(
					new RpcHandshakeError(
						"INTERNAL_ERROR",
						"WebSocket transport failed while sending the HTTP upgrade.",
						{ cause: error },
					),
				);
			}
		};
		const onTimeout = (): void => {
			fail(
				new RpcHandshakeError(
					"HANDSHAKE_TIMEOUT",
					"Timed out waiting for the WebSocket HTTP upgrade.",
				),
			);
		};
		const onError = (error: Error): void => {
			fail(
				new RpcHandshakeError(
					"INTERNAL_ERROR",
					"WebSocket transport failed during the HTTP upgrade.",
					{ cause: error },
				),
			);
		};
		const onEnd = (): void => {
			fail(
				new RpcHandshakeError(
					"INTERNAL_ERROR",
					"WebSocket transport ended during the HTTP upgrade.",
				),
			);
		};
		const onClose = (): void => {
			fail(
				new RpcHandshakeError(
					"INTERNAL_ERROR",
					"WebSocket transport closed during the HTTP upgrade.",
				),
			);
		};
		const onAbort = (): void => {
			fail(createConnectionAbortedError(signal?.reason));
		};
		const onData = (chunk: Buffer): void => {
			received = Buffer.concat([received, chunk]);
			const headerEnd = received.indexOf("\r\n\r\n");
			if (
				(headerEnd === -1 && received.byteLength > MAX_HTTP_UPGRADE_BYTES) ||
				headerEnd + 4 > MAX_HTTP_UPGRADE_BYTES
			) {
				fail(
					new RpcHandshakeError(
						"FRAME_TOO_LARGE",
						"WebSocket HTTP upgrade response exceeded its header limit.",
					),
				);
				return;
			}

			if (headerEnd === -1) {
				return;
			}

			const headerText = received.subarray(0, headerEnd).toString("latin1");
			const head = received.subarray(headerEnd + 4);
			let response: UpgradeResponse;
			try {
				response = parseUpgradeResponse(headerText);
				validateUpgradeResponse(response, expectedAccept);
			} catch (error) {
				fail(
					error instanceof RpcHandshakeError
						? error
						: new RpcHandshakeError(
								"INTERNAL_ERROR",
								"WebSocket HTTP upgrade response was invalid.",
								{ cause: error },
							),
				);
				return;
			}

			cleanup();
			socket.pause();
			let websocket: RpcWebSocketClientInstance;
			try {
				websocket = createWebSocketOverSocket(socket, head, maxPayloadBytes);
			} catch (error) {
				fail(
					new RpcHandshakeError(
						"INTERNAL_ERROR",
						"Failed to initialize the streaming WebSocket receiver.",
						{ cause: error },
					),
				);
				return;
			}
			settled = true;
			resolve(createStreamingConnection(websocket, socket));
		};

		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("end", onEnd);
		socket.once("close", onClose);
		socket.once("timeout", onTimeout);
		socket.setTimeout(handshakeTimeoutMs);
		socket.once(connectEvent, onConnect);
		signal?.addEventListener("abort", onAbort, { once: true });
		deadlineTimer = setTimeout(onTimeout, handshakeTimeoutMs);
		if (signal?.aborted === true) {
			onAbort();
		}
	});
}

function createConnectionAbortedError(reason: unknown): RpcHandshakeError {
	return new RpcHandshakeError(
		"INTERNAL_ERROR",
		"RPC WebSocket connection was aborted.",
		reason === undefined ? undefined : { cause: reason },
	);
}

function createStreamingConnection(
	websocket: RpcWebSocketClientInstance,
	socket: Socket,
): StreamingWebSocketConnection {
	return {
		socket: websocket,
		resume() {
			socket.resume();
		},
	};
}

interface UpgradeResponse {
	readonly statusCode: number;
	readonly headers: ReadonlyMap<string, string>;
}

function parseWebSocketUrl(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new TypeError("RPC client URL must use ws: or wss:.");
	}
	if (url.username !== "" || url.password !== "") {
		throw new TypeError("RPC client URL must not contain credentials.");
	}
	if (url.hash !== "") {
		throw new TypeError("RPC client URL must not contain a fragment.");
	}
	return url;
}

function getPort(url: URL): number {
	if (url.port !== "") {
		return Number(url.port);
	}
	return url.protocol === "wss:" ? 443 : 80;
}

function createUpgradeRequest(
	url: URL,
	websocketKey: string,
	headers: Readonly<Record<string, string>> | undefined,
): string {
	const lines = [
		`GET ${url.pathname}${url.search} HTTP/1.1`,
		`Host: ${url.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${websocketKey}`,
		"Sec-WebSocket-Version: 13",
	];

	if (headers !== undefined) {
		for (const [name, value] of Object.entries(headers)) {
			if (reservedHeaders.has(name.toLowerCase())) {
				throw new TypeError(`RPC handshake header "${name}" is reserved.`);
			}
			if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
				throw new TypeError("RPC handshake headers must not contain line breaks.");
			}
			lines.push(`${name}: ${value}`);
		}
	}

	return `${lines.join("\r\n")}\r\n\r\n`;
}

function parseUpgradeResponse(headerText: string): UpgradeResponse {
	const lines = headerText.split("\r\n");
	const statusLine = lines.shift();
	const statusMatch =
		statusLine === undefined ? null : /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(statusLine);
	if (statusMatch?.[1] === undefined) {
		throw new RpcHandshakeError(
			"INTERNAL_ERROR",
			"WebSocket server returned an invalid HTTP status line.",
		);
	}

	const headers = new Map<string, string>();
	for (const line of lines) {
		const separator = line.indexOf(":");
		if (separator <= 0) {
			throw new RpcHandshakeError(
				"INTERNAL_ERROR",
				"WebSocket server returned an invalid HTTP header.",
			);
		}
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		const previous = headers.get(name);
		headers.set(name, previous === undefined ? value : `${previous}, ${value}`);
	}

	return {
		statusCode: Number(statusMatch[1]),
		headers,
	};
}

function validateUpgradeResponse(response: UpgradeResponse, expectedAccept: string): void {
	if (response.statusCode === 401 || response.statusCode === 403) {
		throw new RpcHandshakeError(
			"AUTHENTICATION_FAILED",
			"RPC server rejected the handshake credentials.",
		);
	}
	if (response.statusCode !== 101) {
		throw new RpcHandshakeError(
			"INTERNAL_ERROR",
			`RPC server rejected the WebSocket upgrade with HTTP ${response.statusCode}.`,
		);
	}
	if (response.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		throw new RpcHandshakeError(
			"INTERNAL_ERROR",
			"WebSocket upgrade response omitted the Upgrade header.",
		);
	}
	const connectionTokens =
		response.headers
			.get("connection")
			?.split(",")
			.map((token) => token.trim().toLowerCase()) ?? [];
	if (!connectionTokens.includes("upgrade")) {
		throw new RpcHandshakeError(
			"INTERNAL_ERROR",
			"WebSocket upgrade response omitted the Connection header.",
		);
	}
	if (response.headers.get("sec-websocket-accept") !== expectedAccept) {
		throw new RpcHandshakeError(
			"INTERNAL_ERROR",
			"WebSocket upgrade response contained an invalid accept value.",
		);
	}
}

function createWebSocketOverSocket(
	socket: Socket,
	head: Buffer,
	maxPayloadBytes: number,
): RpcWebSocketClientInstance {
	const websocket = new RpcWebSocketClient(null, undefined, {
		autoPong: false,
		closeTimeout: 30_000,
	});
	websocket._isServer = false;
	websocket.binaryType = "nodebuffer";
	websocket.setSocket(socket, head, {
		allowSynchronousEvents: true,
		maxBufferedChunks: RPC_WEBSOCKET_MAX_BUFFERED_CHUNKS,
		maxFragments: RPC_WEBSOCKET_MAX_FRAGMENTS,
		maxPayload: maxPayloadBytes,
		skipUTF8Validation: false,
	});
	return websocket;
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
