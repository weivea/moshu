/**
 * Transport abstraction the {@link RpcPeer} writes to and reads through. It is intentionally free
 * of any Node, Bun, or `ws` dependency so the browser-safe core can drive an already-open,
 * frame-delimited, text WebSocket connection provided by any host.
 *
 * The Bun server and the Node/Bun raw client in `@moshu/process-rpc` each supply their own
 * implementation. A future Swift/Capacitor bridge (WKWebView) can implement the same contract to
 * carry RPC frames without pulling in any native socket, crypto, byte-buffer, or WebSocket library.
 *
 * Implementations must:
 * - deliver every inbound text frame to {@link RpcPeer.handleTextFrame} and binary frames to
 *   {@link RpcPeer.handleBinaryFrame};
 * - surface transport failures via {@link RpcPeer.handleTransportError} and closure via
 *   {@link RpcPeer.handleTransportClose};
 * - treat {@link RpcSocketTransport.send} as best-effort back-pressure aware: throw when the frame
 *   cannot be enqueued so the peer can fail the corresponding request.
 */
export interface RpcSocketTransport {
	/** Sends a single UTF-8 text frame. Throws if the frame cannot be enqueued. */
	send(text: string): void;
	/** Initiates a graceful close with a WebSocket close code and reason. */
	close(code: number, reason: string): void;
	/** Immediately tears down the underlying connection without a close handshake. */
	terminate(): void;
	/** Reports whether the connection is currently open for sending. */
	isOpen(): boolean;
}
