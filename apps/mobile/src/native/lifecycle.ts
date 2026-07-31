import { Capacitor } from "@capacitor/core";

// ---------------------------------------------------------------------------
// App lifecycle bridge (NO background modes, NO fake keep-alive).
//
// A thin, injectable adapter over `@capacitor/app`'s `appStateChange`. It only reports foreground /
// background transitions so the connection controller can (a) reconnect + resnapshot on foreground
// and (b) stop scheduling new reconnects on background — letting any still-live socket run out its
// short, OS-granted window without us forging a background task or declaring a background mode.
// ---------------------------------------------------------------------------

export interface AppLifecycleObserver {
	/** App became active/foreground. */
	onActive(): void;
	/** App resigned active/entered background. */
	onBackground(): void;
}

export interface AppLifecycle {
	/** Subscribe to foreground/background transitions. Returns an unsubscribe function. */
	subscribe(observer: AppLifecycleObserver): () => void;
}

/** A lifecycle source that never fires — used on web/test where there is no native app state. */
export const noopAppLifecycle: AppLifecycle = {
	subscribe() {
		return () => {};
	},
};

/**
 * Capacitor-backed lifecycle. On iOS it listens to `@capacitor/app`'s `appStateChange`; elsewhere it
 * falls back to `document.visibilitychange` so `vite dev` still exercises foreground/background paths.
 * The plugin is imported lazily so importing this module never runs native code under test.
 */
export class CapacitorAppLifecycle implements AppLifecycle {
	subscribe(observer: AppLifecycleObserver): () => void {
		if (Capacitor.getPlatform() === "ios") {
			return this.#subscribeNative(observer);
		}
		return this.#subscribeWeb(observer);
	}

	#subscribeNative(observer: AppLifecycleObserver): () => void {
		let removed = false;
		let remove: (() => void) | null = null;
		void (async () => {
			try {
				const { App } = await import("@capacitor/app");
				const handle = await App.addListener("appStateChange", ({ isActive }) => {
					if (isActive) {
						observer.onActive();
					} else {
						observer.onBackground();
					}
				});
				if (removed) {
					await handle.remove();
				} else {
					remove = () => {
						void handle.remove();
					};
				}
			} catch {
				// Plugin unavailable: no lifecycle events. The controller still works on manual retry.
			}
		})();
		return () => {
			removed = true;
			remove?.();
		};
	}

	#subscribeWeb(observer: AppLifecycleObserver): () => void {
		if (typeof document === "undefined") {
			return () => {};
		}
		const handler = () => {
			if (document.visibilityState === "visible") {
				observer.onActive();
			} else {
				observer.onBackground();
			}
		};
		document.addEventListener("visibilitychange", handler);
		return () => {
			document.removeEventListener("visibilitychange", handler);
		};
	}
}
