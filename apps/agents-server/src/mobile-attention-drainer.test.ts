import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type AppDatabase,
	buildApprovalPendingAttentionInput,
	type MobileAttentionOutboxRepository,
	type MobileAttentionRepository,
	openAppDatabase,
} from "@moshu/database";

import { MobileAttentionOutboxDrainer, mobileAttentionPruneMinIntervalMs } from "./mobile-attention-drainer";

let db: AppDatabase;

function enqueue(database: AppDatabase, approvalId: string): void {
	database.mobileAttentionOutbox.enqueue(
		buildApprovalPendingAttentionInput({ approvalId, sessionId: "session-1" }),
	);
}

beforeEach(() => {
	db = openAppDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("MobileAttentionOutboxDrainer", () => {
	test("projects pending outbox rows into the durable feed and is idempotent", () => {
		enqueue(db, "a1");
		enqueue(db, "a2");
		let hints = 0;
		const drainer = new MobileAttentionOutboxDrainer({
			attention: db.mobileAttention,
			outbox: db.mobileAttentionOutbox,
			onAppended: () => {
				hints += 1;
			},
		});

		const first = drainer.drain();
		expect(first.appended).toBe(2);
		expect(db.mobileAttention.latestSeq()).toBe(2);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);
		expect(hints).toBe(1);

		// Re-draining finds nothing new: no duplicate feed rows, no spurious hint.
		const second = drainer.drain();
		expect(second.appended).toBe(0);
		expect(db.mobileAttention.latestSeq()).toBe(2);
		expect(hints).toBe(1);
	});

	test("a crash between append and markProcessed replays idempotently (exactly-once effect)", () => {
		enqueue(db, "a1");
		let failNextMark = true;
		const outbox: MobileAttentionOutboxRepository = {
			enqueue: (input) => db.mobileAttentionOutbox.enqueue(input),
			claimPending: (limit) => db.mobileAttentionOutbox.claimPending(limit),
			markProcessed: (id, at) => {
				if (failNextMark) {
					failNextMark = false;
					throw new Error("crash after append, before mark");
				}
				db.mobileAttentionOutbox.markProcessed(id, at);
			},
			markFailed: (id, error) => db.mobileAttentionOutbox.markFailed(id, error),
			pendingCount: () => db.mobileAttentionOutbox.pendingCount(),
			deleteProcessedBefore: (cutoff) => db.mobileAttentionOutbox.deleteProcessedBefore(cutoff),
		};
		const diagnostics: string[] = [];
		const drainer = new MobileAttentionOutboxDrainer({
			attention: db.mobileAttention,
			outbox,
			reportDiagnostic: (message) => diagnostics.push(message),
		});

		// First drain: append succeeds, markProcessed throws → row retained as failed, diagnostic recorded.
		const first = drainer.drain();
		expect(first.appended).toBe(1);
		expect(first.failed).toBe(1);
		expect(db.mobileAttention.latestSeq()).toBe(1);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(1);
		expect(diagnostics).toHaveLength(1);

		// Second drain: append is idempotent (no new feed row), markProcessed now succeeds → processed.
		const second = drainer.drain();
		expect(second.appended).toBe(0);
		expect(db.mobileAttention.latestSeq()).toBe(1);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);
	});

	test("a projection failure is retained and retried, never swallowed as success", () => {
		enqueue(db, "a1");
		let failNextAppend = true;
		const attention: MobileAttentionRepository = {
			append: (input) => {
				if (failNextAppend) {
					failNextAppend = false;
					throw new Error("transient append failure");
				}
				return db.mobileAttention.append(input);
			},
			list: (id, options) => db.mobileAttention.list(id, options),
			ack: (id, seq) => db.mobileAttention.ack(id, seq),
			deleteAckCursor: (id) => db.mobileAttention.deleteAckCursor(id),
			prune: (now) => db.mobileAttention.prune(now),
			latestSeq: () => db.mobileAttention.latestSeq(),
		};
		const drainer = new MobileAttentionOutboxDrainer({
			attention,
			outbox: db.mobileAttentionOutbox,
		});

		const first = drainer.drain();
		expect(first.failed).toBe(1);
		expect(first.appended).toBe(0);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(1);

		const second = drainer.drain();
		expect(second.appended).toBe(1);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);
	});

	test("start() drains rows a crash left behind and forces an initial retention pass", () => {
		enqueue(db, "a1");
		let pruneCalls = 0;
		const attention: MobileAttentionRepository = {
			append: (input) => db.mobileAttention.append(input),
			list: (id, options) => db.mobileAttention.list(id, options),
			ack: (id, seq) => db.mobileAttention.ack(id, seq),
			deleteAckCursor: (id) => db.mobileAttention.deleteAckCursor(id),
			prune: (now) => {
				pruneCalls += 1;
				return db.mobileAttention.prune(now);
			},
			latestSeq: () => db.mobileAttention.latestSeq(),
		};
		const timers: Array<() => void> = [];
		const drainer = new MobileAttentionOutboxDrainer({
			attention,
			outbox: db.mobileAttentionOutbox,
			setInterval: (handler) => {
				timers.push(handler);
				return {};
			},
			clearInterval: () => {},
		});

		const handle = drainer.start();
		// Startup replayed the crash-left row and forced a retention prune.
		expect(db.mobileAttention.latestSeq()).toBe(1);
		expect(pruneCalls).toBeGreaterThanOrEqual(1);
		// The bounded periodic backstop is installed.
		expect(timers).toHaveLength(1);
		handle.stop();
	});

	test("retention prune after a drain is throttled and forced explicitly", () => {
		let nowMs = 1_000_000;
		let pruneCalls = 0;
		const attention: MobileAttentionRepository = {
			append: (input) => db.mobileAttention.append(input),
			list: (id, options) => db.mobileAttention.list(id, options),
			ack: (id, seq) => db.mobileAttention.ack(id, seq),
			deleteAckCursor: (id) => db.mobileAttention.deleteAckCursor(id),
			prune: (now) => {
				pruneCalls += 1;
				return db.mobileAttention.prune(now);
			},
			latestSeq: () => db.mobileAttention.latestSeq(),
		};
		const drainer = new MobileAttentionOutboxDrainer({
			attention,
			outbox: db.mobileAttentionOutbox,
			now: () => nowMs,
		});

		enqueue(db, "a1");
		drainer.drain(); // first drain forces a prune (lastPruneMs starts at 0)
		const afterFirst = pruneCalls;
		expect(afterFirst).toBeGreaterThanOrEqual(1);

		// A second drain in the same instant is throttled: no additional prune.
		enqueue(db, "a2");
		drainer.drain();
		expect(pruneCalls).toBe(afterFirst);

		// A forced prune ignores the throttle.
		drainer.prune(true);
		expect(pruneCalls).toBe(afterFirst + 1);

		// Once the throttle window elapses, an opportunistic prune runs again.
		nowMs += mobileAttentionPruneMinIntervalMs * 2;
		drainer.prune(false);
		expect(pruneCalls).toBe(afterFirst + 2);
	});
});
