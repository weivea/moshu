import type { RpcPeer, RpcSocketTransport } from "@moshu/process-rpc-core";
import type {
	MobileTransportListenerHandle,
	MobileTransportPlugin,
	TransportFrameEvent,
	TransportStateEvent,
} from "../native";

type FrameSink = (text: string) => void;
type CloseSink = (code: number, reason: string) => void;

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
	#frameHandle: MobileTransportListenerHandle | null = null;
	#stateHandle: MobileTransportListenerHandle | null = null;
	#pendingClose: TransportStateEvent | null = null;

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

	/** Locks the connection to a specific native connectionId and flushes any buffered frames. */
	bind(connectionId: string): void {
		this.#connectionId = connectionId;
		const buffered = this.#buffered;
		this.#buffered = [];
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
			this.#buffered.push(event);
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

	#onState(event: TransportStateEvent): void {
		if (event.state !== "closed") {
			return;
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
		await Promise.resolve(this.#frameHandle?.remove());
		await Promise.resolve(this.#stateHandle?.remove());
		this.#frameHandle = null;
		this.#stateHandle = null;
	}
}
