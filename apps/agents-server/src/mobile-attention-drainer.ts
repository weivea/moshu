import {
	type MobileAttentionOutboxRepository,
	mobileAttentionOutboxProcessedRetentionMs,
	type MobileAttentionRepository,
	projectOutboxRecord,
} from "@moshu/database";

// Minimum gap between retention prunes so a burst of appends can never trigger O(events) prune work.
// A prune is opportunistically attempted after each drain but is throttled to this interval (plus a
// little jitter) and additionally forced by the bounded periodic backstop.
export const mobileAttentionPruneMinIntervalMs = 60_000;
// Bounded periodic backstop: even with no traffic, retention runs at least this often so aged-out
// events and processed outbox rows are reclaimed.
export const mobileAttentionPrunePeriodicMs = 60 * 60 * 1_000;

export interface MobileAttentionOutboxDrainerOptions {
	attention: MobileAttentionRepository;
	outbox: MobileAttentionOutboxRepository;
	// Invoked once per drain that projected at least one NEW feed row, so the caller can push the
	// mobile-only `attention.changed` live hint. Losing this hint never affects durable recovery —
	// the phone still recovers missed unread from the feed on reconnect.
	onAppended?: () => void;
	reportDiagnostic?: (message: string) => void;
	now?: () => number;
	setInterval?: (handler: () => void, ms: number) => { unref?: () => void };
	clearInterval?: (handle: { unref?: () => void }) => void;
}

export interface MobileAttentionDrainResult {
	appended: number;
	failed: number;
	processed: number;
}

// Independent, idempotent drainer for the Mobile attention transactional outbox. It claims not-yet-
// projected rows, projects each into the durable feed (idempotent by dedupe key), and marks it
// processed. A projection failure is retained with an incremented attempt count and a recorded
// diagnostic — never swallowed as success — so a transient fault is retried on the next drain or the
// periodic backstop rather than permanently losing unread.
export class MobileAttentionOutboxDrainer {
	readonly #attention: MobileAttentionRepository;
	readonly #outbox: MobileAttentionOutboxRepository;
	readonly #onAppended: (() => void) | undefined;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #now: () => number;
	readonly #setInterval: (handler: () => void, ms: number) => { unref?: () => void };
	readonly #clearInterval: (handle: { unref?: () => void }) => void;

	#draining = false;
	#rerunRequested = false;
	#lastPruneMs = 0;
	#timer: { unref?: () => void } | undefined;

	constructor(options: MobileAttentionOutboxDrainerOptions) {
		this.#attention = options.attention;
		this.#outbox = options.outbox;
		this.#onAppended = options.onAppended;
		this.#reportDiagnostic = options.reportDiagnostic ?? (() => {});
		this.#now = options.now ?? (() => Date.now());
		this.#setInterval =
			options.setInterval ??
			((handler, ms) => {
				const handle = setInterval(handler, ms);
				return { unref: () => handle.unref?.() };
			});
		this.#clearInterval =
			options.clearInterval ??
			((handle) => {
				clearInterval(handle as unknown as ReturnType<typeof setInterval>);
			});
	}

	// Startup: drain any rows left behind by a crash before wiring the live triggers, force an initial
	// retention pass, and install the bounded periodic backstop. Returns a disposer.
	start(): { stop: () => void } {
		this.drain();
		this.prune(true);
		this.#timer = this.#setInterval(() => {
			this.drain();
			this.prune(true);
		}, mobileAttentionPrunePeriodicMs);
		this.#timer.unref?.();
		return {
			stop: () => {
				if (this.#timer !== undefined) {
					this.#clearInterval(this.#timer);
					this.#timer = undefined;
				}
			},
		};
	}

	// Project all currently-pending outbox rows. Reentrancy-guarded: a drain requested while one is in
	// flight coalesces into a single follow-up pass so live triggers can call this freely.
	drain(): MobileAttentionDrainResult {
		if (this.#draining) {
			this.#rerunRequested = true;
			return { appended: 0, failed: 0, processed: 0 };
		}
		this.#draining = true;
		let appended = 0;
		let failed = 0;
		let processed = 0;
		try {
			for (;;) {
				const batch = this.#outbox.claimPending();
				if (batch.length === 0) {
					break;
				}
				let progressed = false;
				for (const record of batch) {
					try {
						if (projectOutboxRecord(this.#attention, record)) {
							appended += 1;
						}
						this.#outbox.markProcessed(record.id);
						processed += 1;
						progressed = true;
					} catch (error) {
						failed += 1;
						const message =
							error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
						this.#outbox.markFailed(record.id, message);
						this.#reportDiagnostic(
							`Mobile attention outbox row ${record.id} projection failed (attempt ${
								record.attempts + 1
							}); retained for retry: ${message}`,
						);
					}
				}
				// If an entire batch failed, stop looping to avoid a hot retry spin; the periodic
				// backstop retries it. Otherwise keep draining until the outbox is empty.
				if (!progressed) {
					break;
				}
			}
		} finally {
			this.#draining = false;
		}
		if (appended > 0) {
			this.#onAppended?.();
		}
		// Opportunistic, throttled retention so the feed never grows unbounded between periodic passes.
		this.prune(false);
		if (this.#rerunRequested) {
			this.#rerunRequested = false;
			const rerun = this.drain();
			appended += rerun.appended;
			failed += rerun.failed;
			processed += rerun.processed;
		}
		return { appended, failed, processed };
	}

	// Enforce retention (30 days / per-feed cap) plus bounded cleanup of processed outbox rows. Throttled
	// to `mobileAttentionPruneMinIntervalMs` (with jitter) unless `force` is set, so it is never O(events).
	prune(force: boolean): number {
		const now = this.#now();
		if (!force) {
			const jitter = mobileAttentionPruneMinIntervalMs * 0.25 * Math.random();
			if (now - this.#lastPruneMs < mobileAttentionPruneMinIntervalMs + jitter) {
				return 0;
			}
		}
		this.#lastPruneMs = now;
		let removed = 0;
		try {
			removed = this.#attention.prune(now);
			this.#outbox.deleteProcessedBefore(now - mobileAttentionOutboxProcessedRetentionMs);
		} catch (error) {
			const message = error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
			this.#reportDiagnostic(`Mobile attention retention prune failed: ${message}`);
		}
		return removed;
	}

	pendingCount(): number {
		return this.#outbox.pendingCount();
	}
}
