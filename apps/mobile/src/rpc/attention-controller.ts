import type { AckMobileAttentionOutput, ListMobileAttentionOutput } from "@moshu/contracts";
import {
	type LocalNotificationScheduler,
	type NotificationRoute,
	noopNotificationScheduler,
	notificationIdForSeq,
} from "../native/notifications";
import type { MobileEventBus } from "./events";

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

// Hard upper bound on how many extra pages the notification-route lookup will walk to locate the
// newest event. The durable feed is capped at 500 events / 100 per page, so the newest event is at
// most ~5 pages deep; this cap (with margin) keeps the walk strictly bounded even if the feed grows
// between calls, so a busy feed never triggers an unbounded page crawl.
const MAX_ROUTE_LOOKUP_PAGES = 12;

// The id-less route carried by a Moshu-owned notification when the durable feed hit a retention gap
// or the bounded route lookup was exhausted, so no trustworthy opaque id could be resolved. A tap on
// such a notification stays actionable (it is not silently dropped) but lands on the safe Activity hub
// after auth + a fresh snapshot, never navigating with a stale/guessed opaque id.
const SAFE_ACTIVITY_ROUTE: NotificationRoute = { safeActivity: true };

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
	// Monotonic id for the currently-bound connection/client. Bumped on every attach and detach so a
	// long-running async route lookup that outlives its connection (app foregrounded, socket replaced,
	// or detached) can detect the change and refuse to fire a stale notification.
	#generation = 0;
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
		this.#generation += 1;
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
		this.#generation += 1;
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
		// Capture the connection identity that owns this refresh. If it is replaced (detach/re-attach)
		// while we await the network, we must abandon rather than write another connection's state.
		const generation = this.#generation;
		const page = await client.listAttention();
		if (this.#generation !== generation || this.#client !== client) {
			return;
		}
		this.#unreadCount = page.unreadCount;
		this.#ackSeq = page.ackSeq;
		this.#latestSeq = page.latestSeq;
		this.#resyncRequired = page.resyncRequired;

		if (notify && page.latestSeq > this.#seenSeq) {
			await this.#maybeNotify(page, generation, client);
		}
		// Whether or not we notified, everything up to latestSeq is now "seen": a later reconnect
		// snapshot must not resurface these as notifications.
		this.#seenSeq = Math.max(this.#seenSeq, page.latestSeq);

		await this.#applyBadge();
		this.#emit();
	}

	async #maybeNotify(
		firstPage: ListMobileAttentionOutput,
		generation: number,
		client: AttentionFeedClient,
	): Promise<void> {
		// Gate at decision time: active app → Activity badge only, no lock-screen banner.
		if (this.#isAppActive() || !this.#isNotificationsEnabled()) {
			return;
		}
		const text = this.#notificationText();
		// The route resolves the NEWEST event, which is on the LAST page (feed is ascending). This walk
		// is async and may span multiple pages, during which the app can foreground, notifications can
		// be disabled, or the connection can be replaced.
		const route = await this.#resolveRoute(firstPage, generation, client);
		// Re-validate EVERY gate after the async lookup: an old lookup completing after the app returned
		// to the foreground, after the user disabled notifications, or on a superseded connection must
		// NOT fire a (now stale) system notification.
		if (
			this.#isAppActive() ||
			!this.#isNotificationsEnabled() ||
			this.#generation !== generation ||
			this.#client !== client
		) {
			return;
		}
		await this.#scheduler.schedule({
			id: notificationIdForSeq(firstPage.latestSeq),
			title: text.title,
			body: text.body,
			route,
		});
	}

	/**
	 * Resolve the opaque tap route for the newest event (`firstPage.latestSeq`). The feed lists events
	 * in ascending seq order starting at the retention floor, so on a feed with more than one page the
	 * newest event is NOT on the first page. We follow the server-issued opaque `nextCursor` forward — a
	 * strictly bounded walk (the feed is capped at {@link mobileAttentionRetentionMaxEvents}) — until we
	 * reach the page containing the target seq.
	 *
	 * Retention-gap / exhaustion safety: if any page reports `resyncRequired`, the bounded walk runs out
	 * of pages, or the connection is replaced mid-walk, the opaque ids we hold may be stale/foreign, so
	 * we return the id-less {@link SAFE_ACTIVITY_ROUTE}. The notification stays actionable but a tap
	 * lands on a safe Activity state that re-snapshots the server feed rather than navigating with a
	 * stale/guessed id.
	 */
	async #resolveRoute(
		firstPage: ListMobileAttentionOutput,
		generation: number,
		client: AttentionFeedClient,
	): Promise<NotificationRoute> {
		if (this.#client !== client || this.#generation !== generation || firstPage.resyncRequired) {
			return SAFE_ACTIVITY_ROUTE;
		}
		const targetSeq = firstPage.latestSeq;
		const direct = firstPage.items.find((item) => item.seq === targetSeq);
		if (direct) {
			return this.#buildRoute(direct);
		}
		let cursor = firstPage.nextCursor;
		for (let page = 0; page < MAX_ROUTE_LOOKUP_PAGES && cursor !== undefined; page += 1) {
			// The connection was replaced while we were walking: never surface a route resolved against a
			// superseded/foreign connection.
			if (this.#client !== client || this.#generation !== generation) {
				return SAFE_ACTIVITY_ROUTE;
			}
			const next: ListMobileAttentionOutput = await client.listAttention({ cursor });
			// A gap opening up mid-walk means our opaque ids may be stale: fail safe, never guess.
			if (next.resyncRequired) {
				return SAFE_ACTIVITY_ROUTE;
			}
			const found = next.items.find((item) => item.seq === targetSeq);
			if (found) {
				return this.#buildRoute(found);
			}
			cursor = next.nextCursor;
		}
		// Bounded walk exhausted without locating the target (e.g. it aged out between pages): safe hub.
		return SAFE_ACTIVITY_ROUTE;
	}

	/**
	 * Build the opaque tap route for a specific event. Only server-issued ids are carried
	 * (sessionId/approvalId + the stable attention eventId); never any business content.
	 */
	#buildRoute(event: ListMobileAttentionOutput["items"][number]): NotificationRoute {
		const route: { -readonly [K in keyof NotificationRoute]: NotificationRoute[K] } = {
			attentionEventId: event.eventId,
		};
		if (event.sessionId) {
			route.sessionId = event.sessionId;
		}
		if (event.approvalId) {
			route.approvalId = event.approvalId;
		}
		return route;
	}

	async #applyBadge(): Promise<void> {
		await this.#scheduler.setBadge(this.#unreadCount);
	}

	#emit(): void {
		this.#onUnreadChange?.(this.snapshot);
	}
}
