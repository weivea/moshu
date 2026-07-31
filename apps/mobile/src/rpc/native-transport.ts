import type { RpcPeer, RpcSocketTransport } from "@moshu/process-rpc-core";
import { productRpcMaxFrameBytes } from "@moshu/contracts";
import type {
	MobileTransportListenerHandle,
	MobileTransportPlugin,
	TransportFrameEvent,
	TransportStateEvent,
} from "../native";

type FrameSink = (text: string) => void;
type CloseSink = (code: number, reason: string) => void;

/**
 * Hard bounds on the pre-bind frame buffer. Frames can legitimately arrive between `create()` and
 * `bind()` (a handful, at most), so a flood before bind is pathological and is failed closed rather
 * than buffered unboundedly. The per-frame cap is the same Product-RPC limit the native inbound
 * guard and the RpcPeer enforce (`productRpcMaxFrameBytes`, sourced from `@moshu/contracts` so the
 * three stay aligned); the total stays conservative but is kept >= one max frame so a single legal
 * large frame arriving before bind is buffered rather than wrongly rejected.
 */
const MAX_PREBIND_FRAMES = 64;
const MAX_PREBIND_FRAME_BYTES = productRpcMaxFrameBytes;
const MAX_PREBIND_BYTES = 2 * productRpcMaxFrameBytes;

/**
 * Bridges the native `MoshuMobileTransport` plugin to the browser-safe {@link RpcSocketTransport}
 * the {@link RpcPeer} drives. It is created BEFORE `connect()` so it never misses an early frame:
 * it registers the plugin listeners immediately and buffers frames until {@link bind} supplies the
 * authoritative connectionId. Frames from any other connectionId (a stale/previous socket) or with
 * a non-monotonic sequence are dropped, satisfying the "old connection events discarded" rule.
 */
export class NativeRpcConnection implements RpcSocketTransport {
	readonly #plugin: MobileTransportPlugin;
	#connectionId: string | null = null;
	#open = true;
	#lastSeq = 0;
	#frameSink: FrameSink | null = null;
	#closeSink: CloseSink | null = null;
	#buffered: TransportFrameEvent[] = [];
	#bufferedBytes = 0;
	#frameHandle: MobileTransportListenerHandle | null = null;
	#stateHandle: MobileTransportListenerHandle | null = null;
	#pendingClose: TransportStateEvent | null = null;
	#fatalReason: string | null = null;

	private constructor(plugin: MobileTransportPlugin) {
		this.#plugin = plugin;
	}

	/** Registers plugin listeners up front so frames emitted right after connect() are captured. */
	static async create(plugin: MobileTransportPlugin): Promise<NativeRpcConnection> {
		const connection = new NativeRpcConnection(plugin);
		connection.#frameHandle = await plugin.addListener("frame", (event) => {
			connection.#onFrame(event);
		});
		connection.#stateHandle = await plugin.addListener("connectionState", (event) => {
			connection.#onState(event);
		});
		return connection;
	}

	/**
	 * The stable fatal-close token (AUTH_REVOKED / AUTH_FAILED / PROTOCOL_MISMATCH) observed on the
	 * native `connectionState` close event, or null for a transient/benign close. The controller
	 * reads this to decide whether to stop reconnecting.
	 */
	get fatalReason(): string | null {
		return this.#fatalReason;
	}

	/** Locks the connection to a specific native connectionId and flushes any buffered frames. */
	bind(connectionId: string): void {
		this.#connectionId = connectionId;
		const buffered = this.#buffered;
		this.#buffered = [];
		this.#bufferedBytes = 0;
		for (const event of buffered) {
			this.#onFrame(event);
		}
		if (this.#pendingClose && this.#pendingClose.connectionId === connectionId) {
			const close = this.#pendingClose;
			this.#pendingClose = null;
			this.#onState(close);
		}
	}

	setFrameSink(sink: FrameSink | null): void {
		this.#frameSink = sink;
	}

	setCloseSink(sink: CloseSink | null): void {
		this.#closeSink = sink;
	}

	attachPeer(peer: RpcPeer): void {
		this.setFrameSink((text) => {
			peer.handleTextFrame(text);
		});
		this.setCloseSink((code, reason) => {
			peer.handleTransportClose(code, reason);
		});
	}

	#onFrame(event: TransportFrameEvent): void {
		if (this.#connectionId === null) {
			// Bound pre-bind buffer: a single oversized frame or a flood past the count/byte caps
			// fails closed rather than accumulating unboundedly.
			const bytes = utf8ByteLength(event.text);
			if (
				bytes > MAX_PREBIND_FRAME_BYTES ||
				this.#buffered.length >= MAX_PREBIND_FRAMES ||
				this.#bufferedBytes + bytes > MAX_PREBIND_BYTES
			) {
				this.#failPrebind(event.connectionId);
				return;
			}
			this.#buffered.push(event);
			this.#bufferedBytes += bytes;
			return;
		}
		if (event.connectionId !== this.#connectionId) {
			return;
		}
		if (event.seq <= this.#lastSeq) {
			return;
		}
		this.#lastSeq = event.seq;
		this.#frameSink?.(event.text);
	}

	/**
	 * A pre-bind buffer overflow is a protocol violation by the peer. Close the offending native
	 * socket and mark this connection unusable so the imminent handshake `send(hello)` throws and the
	 * controller tears the attempt down.
	 */
	#failPrebind(connectionId: string): void {
		this.#open = false;
		this.#buffered = [];
		this.#bufferedBytes = 0;
		void this.#plugin
			.close({ connectionId, code: 1009, reason: "prebind-overflow" })
			.catch(() => {
				// Best-effort; the connection is already logically closed.
			});
	}

	#onState(event: TransportStateEvent): void {
		if (event.state !== "closed") {
			return;
		}
		if (event.fatalReason) {
			this.#fatalReason = event.fatalReason;
		}
		if (this.#connectionId === null) {
			this.#pendingClose = event;
			return;
		}
		if (event.connectionId !== this.#connectionId) {
			return;
		}
		if (!this.#open) {
			return;
		}
		this.#open = false;
		this.#closeSink?.(event.code ?? 1006, event.reason ?? "Connection closed.");
	}

	send(text: string): void {
		if (!this.#open || this.#connectionId === null) {
			throw new Error("Native transport is not open.");
		}
		const connectionId = this.#connectionId;
		// The native send is async; forward failures to the peer since the sync contract can't await.
		void this.#plugin.send({ connectionId, text }).catch((error: unknown) => {
			this.#open = false;
			this.#closeSink?.(1011, error instanceof Error ? error.message : "Native send failed.");
		});
	}

	close(code: number, reason: string): void {
		if (this.#connectionId === null) {
			this.#open = false;
			return;
		}
		this.#open = false;
		void this.#plugin.close({ connectionId: this.#connectionId, code, reason }).catch(() => {
			// Closing is best-effort; a rejected close still leaves us logically closed.
		});
	}

	terminate(): void {
		this.close(1006, "Transport terminated.");
	}

	isOpen(): boolean {
		return this.#open && this.#connectionId !== null;
	}

	async dispose(): Promise<void> {
		this.#open = false;
		this.#frameSink = null;
		this.#closeSink = null;
		this.#buffered = [];
		this.#bufferedBytes = 0;
		// Close the underlying native socket if one was bound, so a disposed (failed/superseded)
		// attempt never leaves a live socket behind.
		if (this.#connectionId !== null) {
			void this.#plugin
				.close({ connectionId: this.#connectionId, code: 1000, reason: "disposed" })
				.catch(() => {
					// Best-effort; the socket may already be gone.
				});
		}
		await Promise.resolve(this.#frameHandle?.remove());
		await Promise.resolve(this.#stateHandle?.remove());
		this.#frameHandle = null;
		this.#stateHandle = null;
	}
}

function utf8ByteLength(text: string): number {
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(text).length;
	}
	// Fallback for environments without TextEncoder: count UTF-8 bytes manually.
	let bytes = 0;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i += 1;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}
