import type { AckMobileAttentionOutput, ListMobileAttentionOutput } from "@moshu/contracts";
import type { MobileEventBus } from "./events";
import {
	type LocalNotificationScheduler,
	noopNotificationScheduler,
	notificationIdForSeq,
} from "../native/notifications";

// ---------------------------------------------------------------------------
// AttentionController
//
// Owns the phone-side view of the Agent Server's durable attention/unread feed. It never persists
// business events: it reads the feed from the server, tracks the unread badge from the server-side
// per-device ack cursor, and recovers missed unread after a reconnect.
//
// Notification policy (best-effort, no cloud push):
//   * On (re)connect it takes a recovery snapshot and updates the badge, but NEVER replays historical
//     events as system notifications — a reconnect after being offline/suspended must not spam the
//     lock screen with a backlog. The snapshot only re-baselines "what we've already seen".
//   * Only a LIVE `attention.changed` hint (received while a still-live short-background socket is up)
//     can schedule a single generic, localized notification, and only when the app is not active and
//     the user has enabled notifications. When the app IS active we update the Activity badge instead.
//   * The notification id is stably derived from the newest sequence so the OS coalesces duplicates.
// ---------------------------------------------------------------------------

/** The subset of {@link MobileProductClient} the controller needs, for easy testing. */
export interface AttentionFeedClient {
	listAttention(input?: { cursor?: string; limit?: number }): Promise<ListMobileAttentionOutput>;
	ackAttention(input: { seq: number }): Promise<AckMobileAttentionOutput>;
}

/** Generic, already-localized notification copy. Must never contain business content. */
export interface AttentionNotificationText {
	readonly title: string;
	readonly body: string;
}

export interface AttentionControllerOptions {
	/** Local notification scheduler; defaults to a no-op so non-iOS builds are safe. */
	readonly scheduler?: LocalNotificationScheduler;
	/** Whether the app is currently active/foreground. Live hints only notify when this is false. */
	readonly isAppActive: () => boolean;
	/** True only after the user explicitly enabled notifications AND permission is granted. */
	readonly isNotificationsEnabled?: () => boolean;
	/** Supplies the generic localized notification copy (kept a callback so language changes apply). */
	readonly notificationText: () => AttentionNotificationText;
	/** Notified whenever the unread count changes, so a badge/Activity view can re-render. */
	readonly onUnreadChange?: (snapshot: AttentionSnapshot) => void;
}

/** An immutable view of the current attention state for UI consumers. */
export interface AttentionSnapshot {
	readonly unreadCount: number;
	readonly ackSeq: number;
	readonly latestSeq: number;
	/** True when a retention gap means the client must trust the server snapshot, not a delta. */
	readonly resyncRequired: boolean;
}

export class AttentionController {
	readonly #scheduler: LocalNotificationScheduler;
	readonly #isAppActive: () => boolean;
	readonly #isNotificationsEnabled: () => boolean;
	readonly #notificationText: () => AttentionNotificationText;
	readonly #onUnreadChange?: (snapshot: AttentionSnapshot) => void;

	#client: AttentionFeedClient | null = null;
	#unsubscribe: (() => void) | null = null;
	// The highest sequence we've already observed. Live events beyond this baseline are the only ones
	// eligible to raise a system notification; a reconnect snapshot re-baselines without notifying.
	#seenSeq = 0;
	#unreadCount = 0;
	#ackSeq = 0;
	#latestSeq = 0;
	#resyncRequired = false;
	// Serializes async refreshes so overlapping hints/snapshots never interleave badge writes.
	#queue: Promise<void> = Promise.resolve();

	constructor(options: AttentionControllerOptions) {
		this.#scheduler = options.scheduler ?? noopNotificationScheduler;
		this.#isAppActive = options.isAppActive;
		this.#isNotificationsEnabled = options.isNotificationsEnabled ?? (() => true);
		this.#notificationText = options.notificationText;
		this.#onUnreadChange = options.onUnreadChange;
	}

	get snapshot(): AttentionSnapshot {
		return {
			unreadCount: this.#unreadCount,
			ackSeq: this.#ackSeq,
			latestSeq: this.#latestSeq,
			resyncRequired: this.#resyncRequired,
		};
	}

	get unreadCount(): number {
		return this.#unreadCount;
	}

	/**
	 * Bind to a freshly connected session. Subscribes to live `attention.changed` hints and takes a
	 * recovery snapshot (badge only, NO historical notification replay).
	 */
	attach(client: AttentionFeedClient, bus: MobileEventBus): void {
		this.detach();
		this.#client = client;
		this.#unsubscribe = bus.on("mobileAttentionChanged", () => {
			this.#enqueue(() => this.#refresh({ notify: true }));
		});
		this.#enqueue(() => this.#refresh({ notify: false }));
	}

	/** Unbind from the current session (on disconnect). Keeps the last known unread for the badge. */
	detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#client = null;
	}

	/** Acknowledge every event up to and including `seq` (monotonic on the server). */
	async ackUpTo(seq: number): Promise<void> {
		await this.#enqueue(async () => {
			const client = this.#client;
			if (!client) {
				return;
			}
			const result = await client.ackAttention({ seq });
			this.#ackSeq = result.ackSeq;
			this.#unreadCount = result.unreadCount;
			this.#latestSeq = result.latestSeq;
			this.#seenSeq = Math.max(this.#seenSeq, result.latestSeq);
			this.#resyncRequired = false;
			await this.#applyBadge();
			this.#emit();
		});
	}

	/** Acknowledge the entire feed (mark all read). */
	async ackAll(): Promise<void> {
		await this.ackUpTo(this.#latestSeq);
	}

	/** Force a fresh snapshot without notifying (e.g. when opening the Activity screen). */
	async refresh(): Promise<void> {
		await this.#enqueue(() => this.#refresh({ notify: false }));
	}

	/** Resolves when all currently-queued refresh/ack work has settled. Primarily for tests. */
	whenSettled(): Promise<void> {
		return this.#queue;
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		this.#queue = this.#queue.then(task, task);
		return this.#queue;
	}

	async #refresh({ notify }: { notify: boolean }): Promise<void> {
		const client = this.#client;
		if (!client) {
			return;
		}
		const page = await client.listAttention();
		this.#unreadCount = page.unreadCount;
		this.#ackSeq = page.ackSeq;
		this.#latestSeq = page.latestSeq;
		this.#resyncRequired = page.resyncRequired;

		if (notify && page.latestSeq > this.#seenSeq) {
			await this.#maybeNotify(page.latestSeq);
		}
		// Whether or not we notified, everything up to latestSeq is now "seen": a later reconnect
		// snapshot must not resurface these as notifications.
		this.#seenSeq = Math.max(this.#seenSeq, page.latestSeq);

		await this.#applyBadge();
		this.#emit();
	}

	async #maybeNotify(latestSeq: number): Promise<void> {
		// Active app → Activity badge only, no lock-screen banner.
		if (this.#isAppActive() || !this.#isNotificationsEnabled()) {
			return;
		}
		const text = this.#notificationText();
		await this.#scheduler.schedule({
			id: notificationIdForSeq(latestSeq),
			title: text.title,
			body: text.body,
		});
	}

	async #applyBadge(): Promise<void> {
		await this.#scheduler.setBadge(this.#unreadCount);
	}

	#emit(): void {
		this.#onUnreadChange?.(this.snapshot);
	}
}
