import { productRpcMaxBufferedOutboundBytes, productRpcMaxFrameBytes } from "@moshu/contracts";
import { resolveRpcLimits, type RpcPeer } from "@moshu/process-rpc-core";
import {
	getMobileTransport,
	type MobileTransportBinding,
	type MobileTransportPlugin,
	MobileTransportUnavailableError,
} from "../native";
import { MobileEventBus } from "./events";
import { completeMobileHandshake } from "./handshake";
import { NativeRpcConnection } from "./native-transport";
import {
	buildMobileRpcHandlers,
	MobileProductClient,
	mobileInboundAllowlist,
} from "./product-client";

export type FatalConnectionCode =
	| "auth-revoked"
	| "auth-failed"
	| "protocol-mismatch"
	| "identity-mismatch"
	| "url-invalid"
	| "pairing-rejected";

export interface PairingWaitingInfo {
	readonly pairingId: string;
	readonly deviceDisplayName: string;
	readonly serverPublicKeyFingerprint: string;
}

export type ConnectionState =
	| { readonly kind: "initializing" }
	| { readonly kind: "unpaired" }
	| { readonly kind: "pairing"; readonly step: "claiming" }
	| { readonly kind: "waiting"; readonly info: PairingWaitingInfo }
	| { readonly kind: "connecting"; readonly binding: MobileTransportBinding }
	| { readonly kind: "reconnecting"; readonly binding: MobileTransportBinding }
	| { readonly kind: "offline"; readonly binding: MobileTransportBinding }
	| {
			readonly kind: "connected";
			readonly binding: MobileTransportBinding;
			readonly client: MobileProductClient;
			readonly bus: MobileEventBus;
	  }
	| {
			readonly kind: "error";
			readonly code: FatalConnectionCode;
			readonly binding?: MobileTransportBinding;
	  };

type Listener = (state: ConnectionState) => void;

interface ErrorWithCode {
	readonly code?: string;
}

function errorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const value = (error as ErrorWithCode).code;
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

// Native reject codes → fatal UI states. Anything not listed is treated as a transient network
// failure (offline/reconnecting) and retried; we never fake a "connected" state on failure.
const fatalCodeMap: Record<string, FatalConnectionCode> = {
	AUTH_REVOKED: "auth-revoked",
	AUTH_FAILED: "auth-failed",
	PROTOCOL_MISMATCH: "protocol-mismatch",
	IDENTITY_MISMATCH: "identity-mismatch",
	URL_INVALID: "url-invalid",
	PAIRING_REJECTED: "pairing-rejected",
};

// Stable native close-reason tokens (from `TransportStateEvent.fatalReason`) → fatal UI states.
// These arrive on the WebSocket close path (server revoke / rejected upgrade), which does NOT surface
// as a native reject code, so they must be consulted separately when a connection drops or a
// handshake fails.
const fatalReasonMap: Record<string, FatalConnectionCode> = {
	AUTH_REVOKED: "auth-revoked",
	AUTH_FAILED: "auth-failed",
	PROTOCOL_MISMATCH: "protocol-mismatch",
};

const rpcLimits = resolveRpcLimits({
	maxFrameBytes: productRpcMaxFrameBytes,
	maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
});

export interface ConnectionControllerOptions {
	readonly transport?: MobileTransportPlugin;
	readonly deviceDisplayName?: string;
	/** Base reconnect backoff in ms (first attempt); overridable for deterministic tests. */
	readonly reconnectDelayMs?: number;
	/** Upper bound for the exponential backoff in ms. */
	readonly reconnectMaxDelayMs?: number;
	/** Fractional jitter (0..1) added on top of each backoff delay to de-synchronize reconnects. */
	readonly reconnectJitterRatio?: number;
	/** Randomness source for jitter; overridable for deterministic tests. */
	readonly random?: () => number;
	/** Pairing poll interval in ms. */
	readonly pollIntervalMs?: number;
	/**
	 * Handshake implementation. Defaults to {@link completeMobileHandshake}; overridable so tests can
	 * exercise the state machine without standing up a full process-rpc frame exchange.
	 */
	readonly handshake?: typeof completeMobileHandshake;
}

/**
 * Framework-agnostic connection state machine. Owns the native transport lifecycle, the RPC peer,
 * the product client, and the event bus. It is the single source of truth for whether business data
 * may exist: only the `connected` state exposes a `client`. Every transition to a non-connected
 * state drops the client so the UI clears business state and shows offline/reconnect/onboarding
 * instead of stale cached content.
 */
export class ConnectionController {
	readonly #transport: MobileTransportPlugin;
	readonly #deviceDisplayName: string;
	readonly #reconnectDelayMs: number;
	readonly #reconnectMaxDelayMs: number;
	readonly #reconnectJitterRatio: number;
	readonly #random: () => number;
	readonly #pollIntervalMs: number;
	readonly #handshake: typeof completeMobileHandshake;
	readonly #listeners = new Set<Listener>();

	#state: ConnectionState = { kind: "initializing" };
	#connection: NativeRpcConnection | null = null;
	#peer: RpcPeer | null = null;
	#bus: MobileEventBus | null = null;
	#generationToken = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#pollTimer: ReturnType<typeof setTimeout> | null = null;
	#disposed = false;
	// Consecutive failed reconnect attempts; drives the exponential backoff and is reset to 0 the
	// moment a connection becomes stable (reaches `connected`).
	#reconnectAttempt = 0;
	// True while the App is backgrounded. In the background we never start a NEW reconnect (the OS
	// gives us only a short, best-effort window and no way to keep flapping a socket alive); we just
	// let any still-live socket run until the system expiration handler tears it down. Foreground
	// resumes with an immediate, backoff-reset reconnect.
	#backgrounded = false;

	constructor(options: ConnectionControllerOptions = {}) {
		this.#transport = options.transport ?? getMobileTransport();
		this.#deviceDisplayName = options.deviceDisplayName ?? "iPhone";
		this.#reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
		this.#reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
		this.#reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
		this.#random = options.random ?? Math.random;
		this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
		this.#handshake = options.handshake ?? completeMobileHandshake;
	}

	getState(): ConnectionState {
		return this.#state;
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#setState(state: ConnectionState): void {
		this.#state = state;
		for (const listener of [...this.#listeners]) {
			listener(state);
		}
	}

	/** Loads the current binding and, if paired, attempts to connect. */
	async init(): Promise<void> {
		const status = await this.#transport.getStatus();
		if (status.state === "unpaired") {
			this.#setState({ kind: "unpaired" });
			return;
		}
		await this.#connect(status.binding);
	}

	/** Called when the App enters the foreground/active. Reconnects a paired-but-dropped session. */
	async onAppActive(): Promise<void> {
		// Leaving the background: resume normal reconnect behavior and, because the user is now looking
		// at the App, make one immediate attempt with a fresh backoff instead of waiting out a timer.
		this.#backgrounded = false;
		this.#reconnectAttempt = 0;
		const kind = this.#state.kind;
		if (kind === "offline" || kind === "reconnecting") {
			await this.#connect(this.#state.binding as MobileTransportBinding, true);
		} else if (kind === "unpaired" || kind === "initializing") {
			await this.init();
		}
	}

	/**
	 * Called when the App leaves the foreground. We do NOT open or schedule any new connection: the OS
	 * only grants a short, best-effort window, and faking keep-alive is out of scope. An already-live
	 * socket is left running so events can still arrive during that window; a pending reconnect timer
	 * is paused so we never burn the background budget flapping a socket.
	 */
	onAppBackground(): void {
		this.#backgrounded = true;
		this.#clearReconnectTimer();
	}

	/**
	 * Called from the OS background-expiration handler. The short window is over: tear the socket down
	 * cleanly and go offline WITHOUT scheduling a reconnect (we are still backgrounded). Foreground
	 * re-entry ({@link onAppActive}) will re-snapshot and reconnect.
	 */
	async onAppBackgroundExpired(): Promise<void> {
		this.#backgrounded = true;
		this.#clearReconnectTimer();
		this.#generationToken += 1;
		const binding = "binding" in this.#state ? this.#state.binding : undefined;
		await this.#teardownConnection();
		if (this.#disposed) {
			return;
		}
		this.#setState(binding ? { kind: "offline", binding } : { kind: "initializing" });
	}

	async #connect(binding: MobileTransportBinding, isRetry = false): Promise<void> {
		this.#clearReconnectTimer();
		await this.#teardownConnection();
		const token = ++this.#generationToken;
		this.#setState(isRetry ? { kind: "reconnecting", binding } : { kind: "connecting", binding });

		try {
			const connection = await NativeRpcConnection.create(this.#transport);
			if (token !== this.#generationToken) {
				await connection.dispose();
				return;
			}
			try {
				const result = await this.#transport.connect();
				if (token !== this.#generationToken) {
					await connection.dispose();
					return;
				}
				connection.bind(result.connectionId);
				const bus = new MobileEventBus();
				const peer = await this.#handshake({
					connection,
					localIdentity: result.localIdentity,
					expectedServerIdentity: result.serverIdentity,
					limits: rpcLimits,
					handlers: buildMobileRpcHandlers(bus),
					methodAllowlist: mobileInboundAllowlist,
					onClose: () => {
						this.#handlePeerClose(token, binding);
					},
				});
				if (token !== this.#generationToken) {
					peer.close(1000, "Superseded.");
					await connection.dispose();
					return;
				}
				this.#connection = connection;
				this.#peer = peer;
				this.#bus = bus;
				// A stable connection resets the backoff so the next drop retries promptly.
				this.#reconnectAttempt = 0;
				this.#setState({ kind: "connected", binding, client: new MobileProductClient(peer), bus });
			} catch (error) {
				// Any failure/abort after the provisional connection exists must dispose it — removing
				// its plugin listeners and closing the native socket — so a failed attempt never leaks
				// listeners or leaves a live socket behind.
				await this.#handleConnectFailure(token, binding, error, connection);
			}
		} catch (error) {
			await this.#handleConnectFailure(token, binding, error, null);
		}
	}

	async #handleConnectFailure(
		token: number,
		binding: MobileTransportBinding,
		error: unknown,
		connection: NativeRpcConnection | null,
	): Promise<void> {
		// A stable native close-reason captured on the provisional connection outranks the thrown
		// error: a fatal WSS close (revoke / rejected upgrade) surfaces to the handshake only as a
		// generic "connection closed" error, so classify it from the token, not the message.
		const fatalReason = connection?.fatalReason ?? null;
		if (connection) {
			await connection.dispose();
		}
		if (token !== this.#generationToken || this.#disposed) {
			return;
		}
		if (fatalReason && fatalReasonMap[fatalReason]) {
			this.#setState({ kind: "error", code: fatalReasonMap[fatalReason], binding });
			return;
		}
		const code = errorCode(error);
		if (code && fatalCodeMap[code]) {
			this.#setState({ kind: "error", code: fatalCodeMap[code], binding });
			return;
		}
		if (error instanceof MobileTransportUnavailableError) {
			// Running on web/dev without the native plugin: present as unpaired onboarding.
			this.#setState({ kind: "unpaired" });
			return;
		}
		// Transient: go offline and schedule a reconnect.
		this.#setState({ kind: "offline", binding });
		this.#scheduleReconnect(binding);
	}

	#handlePeerClose(token: number, binding: MobileTransportBinding): void {
		if (token !== this.#generationToken || this.#disposed) {
			return;
		}
		this.#peer = null;
		this.#bus = null;
		// A stable fatal close-reason (server revoke / rejected upgrade) means the client must stop
		// blind reconnecting, clear business state, and surface a Desktop-reauthorize / unpair prompt.
		const fatalReason = this.#connection?.fatalReason ?? null;
		if (fatalReason && fatalReasonMap[fatalReason]) {
			void this.#teardownConnection();
			this.#setState({ kind: "error", code: fatalReasonMap[fatalReason], binding });
			return;
		}
		// Otherwise re-check the binding: a close could still be a server-side revocation that only
		// shows up as the binding being gone. Anything else is transient — reconnect.
		void this.#transport
			.getStatus()
			.then((status) => {
				if (token !== this.#generationToken || this.#disposed) {
					return;
				}
				if (status.state === "unpaired") {
					void this.#teardownConnection();
					this.#setState({ kind: "error", code: "auth-revoked", binding });
					return;
				}
				this.#setState({ kind: "reconnecting", binding: status.binding });
				this.#scheduleReconnect(status.binding);
			})
			.catch(() => {
				this.#setState({ kind: "offline", binding });
				this.#scheduleReconnect(binding);
			});
	}

	#scheduleReconnect(binding: MobileTransportBinding): void {
		this.#clearReconnectTimer();
		// In the background we intentionally do not arm a reconnect: no new connections off-foreground.
		if (this.#backgrounded || this.#disposed) {
			return;
		}
		const delay = this.#nextReconnectDelayMs();
		this.#reconnectAttempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			void this.#connect(binding, true);
		}, delay);
	}

	// Bounded exponential backoff with additive jitter: base * 2^attempt capped at the max, plus up to
	// `jitterRatio` extra. The attempt counter resets on a stable connection (see `#connect`).
	#nextReconnectDelayMs(): number {
		const exponential = this.#reconnectDelayMs * 2 ** this.#reconnectAttempt;
		const capped = Math.min(exponential, this.#reconnectMaxDelayMs);
		const jitter = capped * this.#reconnectJitterRatio * this.#random();
		return Math.round(capped + jitter);
	}

	#clearReconnectTimer(): void {
		if (this.#reconnectTimer !== null) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
	}

	/** Manual retry from an offline/error state. */
	async retry(): Promise<void> {
		// User-initiated: reset the backoff so an explicit tap connects promptly.
		this.#reconnectAttempt = 0;
		const state = this.#state;
		if (state.kind === "offline" || state.kind === "reconnecting") {
			await this.#connect(state.binding, true);
		} else if (state.kind === "error" && state.binding) {
			await this.#connect(state.binding, true);
		} else {
			await this.init();
		}
	}

	// --- Pairing -----------------------------------------------------------

	/** Presents the native camera scanner (iOS only). The scanned payload stays in memory. */
	async scanQr(): Promise<import("../native").ScanPairingQrResult> {
		return this.#transport.scanPairingQr();
	}

	async beginPairing(qr: string): Promise<void> {
		this.#clearPollTimer();
		this.#setState({ kind: "pairing", step: "claiming" });
		try {
			const result = await this.#transport.beginPairing({
				qr,
				displayName: this.#deviceDisplayName,
			});
			this.#setState({
				kind: "waiting",
				info: {
					pairingId: result.pairingId,
					deviceDisplayName: result.deviceDisplayName,
					serverPublicKeyFingerprint: result.serverPublicKeyFingerprint,
				},
			});
			this.#schedulePoll();
		} catch (error) {
			const code = errorCode(error);
			if (code && fatalCodeMap[code]) {
				this.#setState({ kind: "error", code: fatalCodeMap[code] });
				return;
			}
			// Invalid/expired QR or offline during claim: return to unpaired so the user can rescan.
			this.#setState({ kind: "unpaired" });
			throw error;
		}
	}

	#schedulePoll(): void {
		this.#clearPollTimer();
		this.#pollTimer = setTimeout(() => {
			void this.#poll();
		}, this.#pollIntervalMs);
	}

	async #poll(): Promise<void> {
		if (this.#state.kind !== "waiting") {
			return;
		}
		try {
			const result = await this.#transport.pollPairing();
			if (this.#state.kind !== "waiting") {
				return;
			}
			switch (result.status) {
				case "pending_approval": {
					this.#schedulePoll();
					return;
				}
				case "approved": {
					await this.#connect(result.binding);
					return;
				}
				case "rejected":
				case "fingerprint_mismatch": {
					this.#setState({ kind: "error", code: "pairing-rejected" });
					return;
				}
				case "expired": {
					this.#setState({ kind: "unpaired" });
					return;
				}
				default: {
					this.#schedulePoll();
				}
			}
		} catch {
			// Transient poll failure — keep waiting and try again.
			this.#schedulePoll();
		}
	}

	#clearPollTimer(): void {
		if (this.#pollTimer !== null) {
			clearTimeout(this.#pollTimer);
			this.#pollTimer = null;
		}
	}

	async cancelPairing(): Promise<void> {
		this.#clearPollTimer();
		try {
			await this.#transport.cancelPairing();
		} finally {
			this.#setState({ kind: "unpaired" });
		}
	}

	// --- Unpair / teardown -------------------------------------------------

	async unpair(): Promise<void> {
		this.#generationToken += 1;
		this.#clearReconnectTimer();
		this.#clearPollTimer();
		await this.#teardownConnection();
		await this.#transport.unpair();
		this.#setState({ kind: "unpaired" });
	}

	async #teardownConnection(): Promise<void> {
		if (this.#peer) {
			this.#peer.close(1000, "Client closing.");
			this.#peer = null;
		}
		this.#bus?.clear();
		this.#bus = null;
		if (this.#connection) {
			await this.#connection.dispose();
			this.#connection = null;
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#generationToken += 1;
		this.#clearReconnectTimer();
		this.#clearPollTimer();
		await this.#teardownConnection();
		this.#listeners.clear();
	}
}
