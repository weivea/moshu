import type { RpcPeerIdentity } from "@moshu/process-rpc-core";

/**
 * TypeScript contract for the native `MoshuMobileTransport` Capacitor plugin (Swift). This is the
 * ONLY bridge between the Web layer and the device's secret material. The plugin owns:
 *   - the software Ed25519 device key (generated with CryptoKit, stored in the Keychain with
 *     `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synced to iCloud, never exposed to JS);
 *   - the single-server binding (exact mobile URL, agentServerId, pinned server public key /
 *     fingerprint, mobileClientId, deviceKeyId, protocol, monotonic generation);
 *   - the authenticated WebSocket to the Agent Server (challenge verification, device-signed
 *     upgrade, TLS, frame sequencing / limits).
 *
 * JS only ever sees: opaque identifiers, fingerprints, protocol metadata, and raw RPC *text*
 * frames. It never receives the private key, the claim token, the pairing code, or the raw
 * signature. Every string that could be a secret stays inside the plugin.
 */

export type MobileTransportBindingState = "unpaired" | "paired";

export interface MobileTransportBinding {
	readonly agentServerId: string;
	readonly mobileClientId: string;
	readonly deviceKeyId: string;
	/** Canonical SPKI-DER fingerprint of the pinned Agent Server public key. */
	readonly serverPublicKeyFingerprint: string;
	/** Fingerprint of this device's public key (safe to display; never the private key). */
	readonly devicePublicKeyFingerprint: string;
	readonly protocolVersion: number;
	readonly transportSecurity: string;
	/** Present only for display/diagnostics; the exact URL is pinned inside the plugin. */
	readonly serverLabel: string;
}

export type MobileTransportStatus =
	| { readonly state: "unpaired" }
	| { readonly state: "paired"; readonly binding: MobileTransportBinding };

export interface BeginPairingOptions {
	/** The raw, single-use QR payload string. Never logged or persisted by JS. */
	readonly qr: string;
	readonly displayName: string;
}

export interface BeginPairingResult {
	readonly pairingId: string;
	readonly deviceDisplayName: string;
	readonly serverPublicKeyFingerprint: string;
}

/**
 * Result of the native camera QR scan. The scanned `qr` payload is held only in memory and passed
 * straight to {@link MobileTransportPlugin.beginPairing}; it is never logged or persisted by JS.
 */
export type ScanPairingQrResult =
	| { readonly status: "scanned"; readonly qr: string }
	| { readonly status: "cancelled" }
	| { readonly status: "unavailable" };

export type PairingPollResult =
	| { readonly status: "pending_approval" }
	| { readonly status: "approved"; readonly binding: MobileTransportBinding }
	| { readonly status: "rejected" }
	| { readonly status: "expired" }
	| { readonly status: "fingerprint_mismatch" };

export interface ConnectResult {
	readonly connectionId: string;
	/** The authenticated mobile-client identity JS must present in the process-rpc hello. */
	readonly localIdentity: RpcPeerIdentity;
	/**
	 * The Agent Server RPC identity (role "agents") the plugin verified via the signed challenge.
	 * JS pins this as the expected server identity while validating the process-rpc hello-ack.
	 */
	readonly serverIdentity: RpcPeerIdentity;
	readonly negotiatedProtocolVersion: number;
	readonly transportSecurity: string;
}

export interface SendFrameOptions {
	readonly connectionId: string;
	readonly text: string;
}

export interface CloseOptions {
	readonly connectionId: string;
	readonly code?: number;
	readonly reason?: string;
}

export interface TransportFrameEvent {
	readonly connectionId: string;
	/** Monotonic per-connection frame sequence. JS drops out-of-order or stale-connection frames. */
	readonly seq: number;
	readonly text: string;
}

export type TransportConnectionState = "open" | "closing" | "closed";

export interface TransportStateEvent {
	readonly connectionId: string;
	readonly state: TransportConnectionState;
	readonly code?: number;
	readonly reason?: string;
	/**
	 * A stable, non-localized token classifying a permanent failure the client cannot fix by
	 * retrying: `AUTH_REVOKED` (server closed a live device with WS 1008), `AUTH_FAILED` (upgrade
	 * rejected 401/403), or `PROTOCOL_MISMATCH` (upgrade 426). Absent for transient/benign closes.
	 */
	readonly fatalReason?: string;
}

export type MobileTransportEventName = "frame" | "connectionState";

export interface MobileTransportListenerHandle {
	remove(): Promise<void> | void;
}

/**
 * The Capacitor plugin surface. Mirrors the Swift `CAPPlugin` `@objc` methods plus its two event
 * channels. Kept intentionally small so the security-critical native side is easy to audit.
 */
export interface MobileTransportPlugin {
	getStatus(): Promise<MobileTransportStatus>;
	/** Presents the native AVFoundation camera scanner and resolves with the scanned QR payload. */
	scanPairingQr(): Promise<ScanPairingQrResult>;
	beginPairing(options: BeginPairingOptions): Promise<BeginPairingResult>;
	pollPairing(): Promise<PairingPollResult>;
	cancelPairing(): Promise<void>;
	connect(): Promise<ConnectResult>;
	send(options: SendFrameOptions): Promise<void>;
	close(options: CloseOptions): Promise<void>;
	unpair(): Promise<void>;
	addListener(
		eventName: "frame",
		listener: (event: TransportFrameEvent) => void,
	): Promise<MobileTransportListenerHandle> | MobileTransportListenerHandle;
	addListener(
		eventName: "connectionState",
		listener: (event: TransportStateEvent) => void,
	): Promise<MobileTransportListenerHandle> | MobileTransportListenerHandle;
}
