import { Capacitor, registerPlugin } from "@capacitor/core";
import type {
	MobileTransportListenerHandle,
	MobileTransportPlugin,
	MobileTransportStatus,
} from "./transport-plugin";

export * from "./transport-plugin";

/**
 * Thrown when a native-only transport operation is attempted on a platform without the plugin
 * (browser dev, jsdom tests, or a Capacitor web build). Callers surface this as a benign
 * "open on iPhone" state rather than a crash.
 */
export class MobileTransportUnavailableError extends Error {
	constructor() {
		super("The Moshu native transport is only available on the iOS app.");
		this.name = "MobileTransportUnavailableError";
	}
}

// Web fallback: there is no device Keychain or native socket in a browser, so pairing/connecting
// are unavailable. It reports "unpaired" and no-ops teardown so shared UI can render its onboarding
// state during `vite dev` without a device. Tests override the transport entirely (see below).
const webTransport: MobileTransportPlugin = {
	async getStatus(): Promise<MobileTransportStatus> {
		return { state: "unpaired" };
	},
	async scanPairingQr() {
		return { status: "unavailable" as const };
	},
	async beginPairing() {
		throw new MobileTransportUnavailableError();
	},
	async pollPairing() {
		throw new MobileTransportUnavailableError();
	},
	async cancelPairing() {
		// nothing to clean up on web
	},
	async connect() {
		throw new MobileTransportUnavailableError();
	},
	async send() {
		throw new MobileTransportUnavailableError();
	},
	async close() {
		// nothing to close on web
	},
	async unpair() {
		// nothing to unpair on web
	},
	addListener(): MobileTransportListenerHandle {
		return { remove() {} };
	},
};

const nativeTransport = registerPlugin<MobileTransportPlugin>("MoshuMobileTransport", {
	web: webTransport,
});

let override: MobileTransportPlugin | null = null;

/** Returns the active transport: a test override if set, otherwise the platform plugin. */
export function getMobileTransport(): MobileTransportPlugin {
	return override ?? nativeTransport;
}

/** Test/dev seam: replace the transport with a fake implementing the same contract. */
export function setMobileTransport(transport: MobileTransportPlugin | null): void {
	override = transport;
}

export function isNativeTransportAvailable(): boolean {
	return Capacitor.getPlatform() === "ios";
}
