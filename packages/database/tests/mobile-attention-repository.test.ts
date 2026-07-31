import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	type AppDatabase,
	mobileAttentionRetentionMaxAgeMs,
	mobileAttentionRetentionMaxEvents,
	openAppDatabase,
} from "../src";

let db: AppDatabase;

function appendApproval(
	sequence: number,
	overrides: { approvalId?: string; createdAtMs?: number } = {},
) {
	return db.mobileAttention.append({
		type: "approval_required",
		dedupeKey: `approval:${overrides.approvalId ?? `a${sequence}`}`,
		approvalId:
			overrides.approvalId ??
			`019fb74d-0000-7000-8000-00000000${String(sequence).padStart(4, "0")}`,
		sessionId: "019fb74d-0000-7000-8000-000000000001",
		titleKey: "attention.approvalRequired.title",
		bodyKey: "attention.approvalRequired.body",
		...(overrides.createdAtMs === undefined ? {} : { createdAtMs: overrides.createdAtMs }),
	});
}

beforeEach(() => {
	db = openAppDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("mobile attention repository", () => {
	test("append assigns monotonic seq and is idempotent per dedupe key", () => {
		const first = appendApproval(1, { approvalId: "approval-x" });
		const second = appendApproval(1, { approvalId: "approval-x" });
		expect(first.appended).toBe(true);
		expect(first.event.seq).toBe(1);
		// Same business event → same row, no new seq consumed.
		expect(second.appended).toBe(false);
		expect(second.event.seq).toBe(1);

		const third = db.mobileAttention.append({
			type: "run_completed",
			dedupeKey: "run:run-1",
			runId: "run-1",
			titleKey: "attention.runCompleted.title",
			bodyKey: "attention.runCompleted.body",
		});
		expect(third.appended).toBe(true);
		expect(third.event.seq).toBe(2);
		expect(db.mobileAttention.latestSeq()).toBe(2);
	});

	test("events are desensitized to opaque ids and localization keys only", () => {
		const { event } = appendApproval(1, { approvalId: "approval-y" });
		expect(event.visibility).toBe("mobile-clients");
		expect(event.titleKey).toBe("attention.approvalRequired.title");
		expect(Object.keys(event).sort()).toEqual(
			[
				"approvalId",
				"bodyKey",
				"createdAt",
				"eventId",
				"schemaVersion",
				"seq",
				"sessionId",
				"titleKey",
				"type",
				"visibility",
			].sort(),
		);
	});

	test("list reports unread relative to a per-client ack cursor", () => {
		appendApproval(1);
		appendApproval(2);
		appendApproval(3);

		const initial = db.mobileAttention.list("client-a");
		expect(initial.items).toHaveLength(3);
		expect(initial.unreadCount).toBe(3);
		expect(initial.ackSeq).toBe(0);
		expect(initial.latestSeq).toBe(3);
		expect(initial.resyncRequired).toBe(false);

		// A second client has its own cursor.
		const other = db.mobileAttention.list("client-b");
		expect(other.unreadCount).toBe(3);
	});

	test("ack is monotonic and never regresses", () => {
		appendApproval(1);
		appendApproval(2);
		appendApproval(3);

		const acked = db.mobileAttention.ack("client-a", 2);
		expect(acked.ackSeq).toBe(2);
		expect(acked.unreadCount).toBe(1);

		// A stale/out-of-order lower ack is a no-op.
		const regress = db.mobileAttention.ack("client-a", 1);
		expect(regress.ackSeq).toBe(2);
		expect(regress.unreadCount).toBe(1);

		// Acking past the latest seq clamps to latest.
		const clamped = db.mobileAttention.ack("client-a", 99);
		expect(clamped.ackSeq).toBe(3);
		expect(clamped.unreadCount).toBe(0);
	});

	test("pagination walks forward with a cursor", () => {
		for (let index = 1; index <= 5; index += 1) {
			appendApproval(index);
		}
		const page1 = db.mobileAttention.list("client-a", { limit: 2 });
		expect(page1.items.map((item) => item.seq)).toEqual([1, 2]);
		expect(page1.nextCursor).toBeDefined();

		const page2 = db.mobileAttention.list("client-a", {
			limit: 2,
			cursor: page1.nextCursor,
		});
		expect(page2.items.map((item) => item.seq)).toEqual([3, 4]);

		const page3 = db.mobileAttention.list("client-a", {
			limit: 2,
			cursor: page2.nextCursor,
		});
		expect(page3.items.map((item) => item.seq)).toEqual([5]);
		expect(page3.nextCursor).toBeUndefined();
	});

	test("retention prune by age sets resyncRequired for stale cursors", () => {
		const now = Date.now();
		const old = now - mobileAttentionRetentionMaxAgeMs - 60_000;
		appendApproval(1, { approvalId: "old-1", createdAtMs: old });
		appendApproval(2, { approvalId: "old-2", createdAtMs: old });
		appendApproval(3, { approvalId: "fresh", createdAtMs: now });

		const removed = db.mobileAttention.prune(now);
		expect(removed).toBe(2);

		// A client that never acked the pruned events must be told to resnapshot.
		const listed = db.mobileAttention.list("client-a");
		expect(listed.resyncRequired).toBe(true);
		expect(listed.items.map((item) => item.seq)).toEqual([3]);
		// latestSeq is stable even after pruning.
		expect(listed.latestSeq).toBe(3);
	});

	test("retention prune by count cap keeps only the newest events", () => {
		const total = mobileAttentionRetentionMaxEvents + 5;
		for (let index = 1; index <= total; index += 1) {
			appendApproval(index, { approvalId: `cap-${index}` });
		}
		const removed = db.mobileAttention.prune();
		expect(removed).toBe(5);
		expect(db.mobileAttention.latestSeq()).toBe(total);
		const listed = db.mobileAttention.list("client-a", { limit: 1 });
		expect(listed.latestSeq).toBe(total);
	});

	test("deleteAckCursor clears a revoked device read state", () => {
		appendApproval(1);
		db.mobileAttention.ack("client-a", 1);
		db.mobileAttention.deleteAckCursor("client-a");
		const listed = db.mobileAttention.list("client-a");
		// A fresh cursor means everything is unread again for a re-paired client id.
		expect(listed.ackSeq).toBe(0);
		expect(listed.unreadCount).toBe(1);
	});

	test("malformed cursor is rejected", () => {
		appendApproval(1);
		expect(() => db.mobileAttention.list("client-a", { cursor: "not-a-cursor" })).toThrow();
	});
});
