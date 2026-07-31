import { Capacitor } from "@capacitor/core";

// ---------------------------------------------------------------------------
// Best-effort local notifications (NO cloud push, NO APNs, NO remote/silent push).
//
// This is a thin, injectable adapter over `@capacitor/local-notifications`. The app only ever
// schedules a *generic, localized* local notification while it is NOT active and a still-live short
// background socket actually received a live attention hint. The notification body never carries any
// business content (no prompt/command/path/secret) — only static localized text and an opaque id
// derived from the attention feed's sequence number so the OS coalesces duplicates.
//
// Suspended/terminated apps get NO notification: there is no server-side push relay by design, so we
// cannot wake the process. Missed unread is instead recovered from the durable server feed on the
// next foreground reconnect (badge only, never a backfill of system notifications).
// ---------------------------------------------------------------------------

/** Normalized permission state, independent of the underlying plugin's enum spelling. */
export type NotificationPermissionState = "granted" | "denied" | "prompt" | "unavailable";

export interface LocalNotificationRequest {
	/** Stable 31-bit id derived from the attention sequence; identical ids coalesce in the OS. */
	readonly id: number;
	/** Generic, already-localized title. Must never contain business content. */
	readonly title: string;
	/** Generic, already-localized body. Must never contain business content. */
	readonly body: string;
	/**
	 * Opaque routing hint delivered on tap (e.g. sessionId/approvalId). The app re-authenticates,
	 * reconnects and re-snapshots BEFORE navigating, so a stale/opaque id can never surface cached
	 * business content.
	 */
	readonly route?: Readonly<Record<string, string>>;
}

/**
 * The seam the {@link AttentionController} and Settings screen talk to. A Capacitor-backed default is
 * used on device; tests and non-iOS builds inject a fake or the {@link NoopNotificationScheduler}.
 */
export interface LocalNotificationScheduler {
	/** Current OS permission, without prompting. */
	getPermission(): Promise<NotificationPermissionState>;
	/** Explicit, user-initiated permission request (never on cold start). */
	requestPermission(): Promise<NotificationPermissionState>;
	/** Schedule (or replace, via the stable id) a single generic notification, fired immediately. */
	schedule(request: LocalNotificationRequest): Promise<void>;
	/** Reflect the current unread count on the app icon badge. `0` clears it. */
	setBadge(count: number): Promise<void>;
}

// The maximum 32-bit signed integer. Capacitor notification ids must fit in a native int, so the
// monotonic (and potentially large) attention seq is folded into this range while staying stable for
// a given seq. Collisions across a 2-billion-event feed are irrelevant on a single device.
const MAX_NOTIFICATION_ID = 2_147_483_647;

/** Derives a stable, positive 31-bit notification id from an attention sequence number. */
export function notificationIdForSeq(seq: number): number {
	const normalized = Math.abs(Math.trunc(seq)) % MAX_NOTIFICATION_ID;
	// Reserve 0 as "unset" so a seq that folds to 0 still yields a concrete id.
	return normalized === 0 ? MAX_NOTIFICATION_ID : normalized;
}

/** A scheduler that does nothing, used on web/dev and as a safe default before permission is granted. */
export const noopNotificationScheduler: LocalNotificationScheduler = {
	async getPermission() {
		return "unavailable";
	},
	async requestPermission() {
		return "unavailable";
	},
	async schedule() {
		// no-op
	},
	async setBadge() {
		// no-op
	},
};

function normalizePermission(value: string | undefined): NotificationPermissionState {
	switch (value) {
		case "granted":
			return "granted";
		case "denied":
			return "denied";
		case "prompt":
		case "prompt-with-rationale":
			return "prompt";
		default:
			return "unavailable";
	}
}

/**
 * Capacitor-backed scheduler. The plugin is imported lazily so pulling it in never runs native code
 * on web/test. All methods degrade to a benign no-op / "unavailable" when the plugin is not present.
 */
export class CapacitorNotificationScheduler implements LocalNotificationScheduler {
	async #plugin() {
		if (Capacitor.getPlatform() !== "ios") {
			return null;
		}
		try {
			const module = await import("@capacitor/local-notifications");
			return module.LocalNotifications;
		} catch {
			return null;
		}
	}

	async getPermission(): Promise<NotificationPermissionState> {
		const plugin = await this.#plugin();
		if (!plugin) {
			return "unavailable";
		}
		const status = await plugin.checkPermissions();
		return normalizePermission(status.display);
	}

	async requestPermission(): Promise<NotificationPermissionState> {
		const plugin = await this.#plugin();
		if (!plugin) {
			return "unavailable";
		}
		const status = await plugin.requestPermissions();
		return normalizePermission(status.display);
	}

	async schedule(request: LocalNotificationRequest): Promise<void> {
		const plugin = await this.#plugin();
		if (!plugin) {
			return;
		}
		await plugin.schedule({
			notifications: [
				{
					id: request.id,
					title: request.title,
					body: request.body,
					// `schedule` with no `schedule.at` fires immediately; no repeats, no channels.
					extra: request.route ?? {},
				},
			],
		});
	}

	async setBadge(count: number): Promise<void> {
		const plugin = await this.#plugin();
		if (!plugin) {
			return;
		}
		// The Local Notifications plugin does not expose a direct badge setter; a badge is carried by a
		// scheduled notification. To avoid emitting a visible banner just to move the badge, we only
		// clear delivered notifications when the unread count drops to zero. Non-zero badge values are
		// reflected by the notifications the app schedules while backgrounded.
		if (count <= 0) {
			try {
				const delivered = await plugin.getDeliveredNotifications();
				if (delivered.notifications.length > 0) {
					await plugin.removeDeliveredNotifications(delivered);
				}
			} catch {
				// best-effort
			}
		}
	}
}
