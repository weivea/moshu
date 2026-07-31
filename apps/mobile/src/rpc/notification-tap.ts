import type { LocalNotificationScheduler, NotificationRoute } from "../native/notifications";

// ---------------------------------------------------------------------------
// NotificationTapCoordinator
//
// Owns what happens when the user taps a delivered local notification. A tap carries only an opaque
// route (sessionId/approvalId/attentionEventId) — never business content — so navigation MUST NOT
// surface anything until the app is back on a trusted footing:
//
//   * If the session is unpaired or in a fatal state, we show a safe status and DO NOT navigate.
//   * Otherwise we wait for an authenticated connection AND a fresh attention snapshot to succeed,
//     and only then navigate using the opaque route. If readiness never arrives (the session drops
//     to unpaired/fatal, or times out), we fall back to the safe state instead of showing stale UI.
//
// The coordinator registers exactly one native tap listener via the injected scheduler and disposes
// it on teardown, so re-mounting never leaks a listener or double-handles a tap.
// ---------------------------------------------------------------------------

/** High-level readiness derived from the connection state machine at the moment of a tap. */
export type NotificationTapReadiness = "ready" | "connecting" | "unpaired" | "fatal";

export interface NotificationTapDeps {
	/** The scheduler whose native tap listener we register against. */
	readonly scheduler: LocalNotificationScheduler;
	/** Snapshot of connection readiness at tap time (unpaired/fatal short-circuit to a safe state). */
	readonly readiness: () => NotificationTapReadiness;
	/**
	 * Resolve `true` once an authenticated connection is established AND a fresh attention snapshot has
	 * been taken, so navigation can never show stale/cached content. Resolve `false` if the session
	 * becomes unpaired/fatal (or times out) before it is ready.
	 */
	readonly waitUntilReady: () => Promise<boolean>;
	/** Navigate to the opaque route. Invoked ONLY after readiness + a fresh snapshot. */
	readonly navigate: (route: NotificationRoute) => void;
	/** Show a safe, non-navigating state (unpaired/fatal/aborted). Never surfaces stale content. */
	readonly showSafeState: (route: NotificationRoute) => void;
}

export class NotificationTapCoordinator {
	readonly #deps: NotificationTapDeps;
	#dispose: (() => void) | null = null;

	constructor(deps: NotificationTapDeps) {
		this.#deps = deps;
	}

	/** Register the native tap listener. Idempotent: a second call is a no-op while already started. */
	start(): void {
		if (this.#dispose) {
			return;
		}
		this.#dispose = this.#deps.scheduler.onTap((route) => {
			void this.#handleTap(route);
		});
	}

	/** Remove the native tap listener. Idempotent and safe to call when never started. */
	dispose(): void {
		this.#dispose?.();
		this.#dispose = null;
	}

	async #handleTap(route: NotificationRoute): Promise<void> {
		const readiness = this.#deps.readiness();
		if (readiness === "unpaired" || readiness === "fatal") {
			// Not paired or fatally disconnected: show a safe status, never stale business content.
			this.#deps.showSafeState(route);
			return;
		}
		// Paired but possibly offline/reconnecting: wait for an authenticated connection AND a fresh
		// attention snapshot before we act on the opaque route.
		const ready = await this.#deps.waitUntilReady();
		if (!ready) {
			this.#deps.showSafeState(route);
			return;
		}
		this.#deps.navigate(route);
	}
}
