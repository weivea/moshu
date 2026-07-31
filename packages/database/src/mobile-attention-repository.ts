import {
	type ListMobileAttentionOutput,
	type MobileAttentionEvent,
	type MobileAttentionEventType,
	mobileAttentionEventSchema,
	mobileAttentionListPageSize,
} from "@moshu/contracts";
import { asc, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import {
	mobileAttentionAckCursorsTable,
	mobileAttentionEventsTable,
	mobileAttentionFeedMetaTable,
} from "./schema";

interface RepositoryClock {
	now(): number;
}

type AppDatabaseReader = Pick<AppDrizzleDatabase, "select">;

// Retention: keep at most this many days and this many rows. Both floors are enforced together — the
// feed can never grow without bound even under a burst, and stale events age out. A client whose ack
// cursor falls behind the retention floor is told to resnapshot (never silently shown "no unread").
export const mobileAttentionRetentionMaxAgeMs = 30 * 24 * 60 * 60 * 1_000;
export const mobileAttentionRetentionMaxEvents = 500;

export interface AppendMobileAttentionInput {
	type: MobileAttentionEventType;
	// A stable business identity so the same approval/Run terminal can never append twice
	// (transactional idempotency), even across a restart or a duplicate event delivery.
	dedupeKey: string;
	sessionId?: string;
	runId?: string;
	approvalId?: string;
	titleKey: string;
	bodyKey: string;
	createdAtMs?: number;
}

export interface AppendMobileAttentionResult {
	event: MobileAttentionEvent;
	appended: boolean;
}

export interface ListMobileAttentionOptions {
	cursor?: string | undefined;
	limit?: number | undefined;
}

export interface AckMobileAttentionResult {
	ackSeq: number;
	unreadCount: number;
	latestSeq: number;
}

export class MobileAttentionCursorError extends Error {
	constructor() {
		super("Mobile attention list cursor is malformed.");
		this.name = "MobileAttentionCursorError";
	}
}

export interface MobileAttentionRepository {
	append(input: AppendMobileAttentionInput): AppendMobileAttentionResult;
	list(mobileClientId: string, options?: ListMobileAttentionOptions): ListMobileAttentionOutput;
	ack(mobileClientId: string, seq: number): AckMobileAttentionResult;
	deleteAckCursor(mobileClientId: string): void;
	prune(nowMs?: number): number;
	latestSeq(): number;
}

interface AttentionEventRow {
	seq: number;
	eventId: string;
	type: MobileAttentionEventType;
	sessionId: string | null;
	runId: string | null;
	approvalId: string | null;
	titleKey: string;
	bodyKey: string;
	createdAtMs: number;
}

interface FeedMeta {
	nextSeq: number;
	prunedThroughSeq: number;
}

export class SqliteMobileAttentionRepository implements MobileAttentionRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	append(input: AppendMobileAttentionInput): AppendMobileAttentionResult {
		if (input.dedupeKey.length === 0 || input.dedupeKey.length > 256) {
			throw new TypeError("Mobile attention dedupe key must be between 1 and 256 characters.");
		}
		return this.orm.transaction((transaction) => {
			const existing = transaction
				.select()
				.from(mobileAttentionEventsTable)
				.where(eq(mobileAttentionEventsTable.dedupeKey, input.dedupeKey))
				.get();
			if (existing !== undefined) {
				return { event: buildEvent(existing), appended: false };
			}
			const meta = readFeedMeta(transaction);
			const seq = meta.nextSeq;
			const createdAtMs = input.createdAtMs ?? this.clock.now();
			const row = {
				seq,
				eventId: createUuidV7(createdAtMs),
				dedupeKey: input.dedupeKey,
				type: input.type,
				sessionId: input.sessionId ?? null,
				runId: input.runId ?? null,
				approvalId: input.approvalId ?? null,
				titleKey: input.titleKey,
				bodyKey: input.bodyKey,
				createdAtMs,
			};
			transaction.insert(mobileAttentionEventsTable).values(row).run();
			transaction
				.update(mobileAttentionFeedMetaTable)
				.set({ nextSeq: seq + 1 })
				.where(eq(mobileAttentionFeedMetaTable.id, 1))
				.run();
			return { event: buildEvent(row), appended: true };
		});
	}

	list(
		mobileClientId: string,
		options: ListMobileAttentionOptions = {},
	): ListMobileAttentionOutput {
		const limit =
			options.limit === undefined
				? mobileAttentionListPageSize
				: Math.min(Math.max(Math.trunc(options.limit), 1), mobileAttentionListPageSize);
		const cursorSeq = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
		return this.orm.transaction((transaction) => {
			const meta = readFeedMeta(transaction);
			const latestSeq = Math.max(meta.nextSeq - 1, 0);
			const ackedSeq = readAckedSeq(transaction, mobileClientId);
			// A retention gap exists when the client (or its page cursor) sits behind the retention
			// floor: events it never acknowledged were pruned, so an incremental unread delta would be
			// wrong. Surface `resyncRequired` and skip forward to the floor rather than fake "no unread".
			const ackGap = ackedSeq < meta.prunedThroughSeq;
			const cursorGap = cursorSeq !== undefined && cursorSeq < meta.prunedThroughSeq;
			const afterSeq = Math.max(cursorSeq ?? 0, meta.prunedThroughSeq);
			const rows = transaction
				.select()
				.from(mobileAttentionEventsTable)
				.where(gt(mobileAttentionEventsTable.seq, afterSeq))
				.orderBy(asc(mobileAttentionEventsTable.seq))
				.limit(limit + 1)
				.all();
			const hasMore = rows.length > limit;
			const pageRows = hasMore ? rows.slice(0, limit) : rows;
			const unreadCount = countUnread(transaction, ackedSeq);
			const lastRow = pageRows.at(-1);
			return {
				schemaVersion: 1 as const,
				items: pageRows.map(buildEvent),
				unreadCount,
				ackSeq: ackedSeq,
				latestSeq,
				resyncRequired: ackGap || cursorGap,
				...(hasMore && lastRow !== undefined ? { nextCursor: encodeCursor(lastRow.seq) } : {}),
			};
		});
	}

	ack(mobileClientId: string, seq: number): AckMobileAttentionResult {
		if (!Number.isSafeInteger(seq) || seq < 0) {
			throw new TypeError("Mobile attention ack sequence must be a nonnegative safe integer.");
		}
		return this.orm.transaction((transaction) => {
			const meta = readFeedMeta(transaction);
			const latestSeq = Math.max(meta.nextSeq - 1, 0);
			// Clamp to the highest assigned seq (a client can never ack past the feed) and never regress
			// the stored cursor (monotonic CAS). Idempotent: re-acking the same/lower seq is a no-op.
			const clamped = Math.min(seq, latestSeq);
			const current = readAckedSeq(transaction, mobileClientId);
			const nextAcked = Math.max(current, clamped);
			if (nextAcked !== current) {
				const updatedAtMs = this.clock.now();
				transaction
					.insert(mobileAttentionAckCursorsTable)
					.values({ mobileClientId, ackedSeq: nextAcked, updatedAtMs })
					.onConflictDoUpdate({
						target: mobileAttentionAckCursorsTable.mobileClientId,
						set: { ackedSeq: nextAcked, updatedAtMs },
					})
					.run();
			}
			return {
				ackSeq: nextAcked,
				unreadCount: countUnread(transaction, nextAcked),
				latestSeq,
			};
		});
	}

	deleteAckCursor(mobileClientId: string): void {
		this.orm
			.delete(mobileAttentionAckCursorsTable)
			.where(eq(mobileAttentionAckCursorsTable.mobileClientId, mobileClientId))
			.run();
	}

	prune(nowMs?: number): number {
		const now = nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const ageCutoffMs = now - mobileAttentionRetentionMaxAgeMs;
			const ageFloorSeq =
				transaction
					.select({ value: sql<number>`coalesce(max(${mobileAttentionEventsTable.seq}), 0)` })
					.from(mobileAttentionEventsTable)
					.where(lte(mobileAttentionEventsTable.createdAtMs, ageCutoffMs))
					.get()?.value ?? 0;
			// The highest seq to drop for the count cap is the (maxEvents+1)-th newest row's seq: keep
			// the newest `maxEvents`, prune everything at-or-below that boundary.
			const countBoundary = transaction
				.select({ seq: mobileAttentionEventsTable.seq })
				.from(mobileAttentionEventsTable)
				.orderBy(desc(mobileAttentionEventsTable.seq))
				.limit(1)
				.offset(mobileAttentionRetentionMaxEvents)
				.get();
			const countFloorSeq = countBoundary?.seq ?? 0;
			const pruneThroughSeq = Math.max(ageFloorSeq, countFloorSeq);
			if (pruneThroughSeq <= 0) {
				return 0;
			}
			const removed =
				transaction
					.select({ value: count() })
					.from(mobileAttentionEventsTable)
					.where(lte(mobileAttentionEventsTable.seq, pruneThroughSeq))
					.get()?.value ?? 0;
			transaction
				.delete(mobileAttentionEventsTable)
				.where(lte(mobileAttentionEventsTable.seq, pruneThroughSeq))
				.run();
			const meta = readFeedMeta(transaction);
			if (pruneThroughSeq > meta.prunedThroughSeq) {
				transaction
					.update(mobileAttentionFeedMetaTable)
					.set({ prunedThroughSeq: pruneThroughSeq })
					.where(eq(mobileAttentionFeedMetaTable.id, 1))
					.run();
			}
			return removed;
		});
	}

	latestSeq(): number {
		return Math.max(readFeedMeta(this.orm).nextSeq - 1, 0);
	}
}

function buildEvent(row: AttentionEventRow): MobileAttentionEvent {
	return mobileAttentionEventSchema.parse({
		schemaVersion: 1,
		eventId: row.eventId,
		seq: row.seq,
		type: row.type,
		visibility: "mobile-clients",
		...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
		...(row.runId === null ? {} : { runId: row.runId }),
		...(row.approvalId === null ? {} : { approvalId: row.approvalId }),
		createdAt: new Date(row.createdAtMs).toISOString(),
		titleKey: row.titleKey,
		bodyKey: row.bodyKey,
	});
}

function readFeedMeta(db: AppDatabaseReader): FeedMeta {
	const row = db
		.select()
		.from(mobileAttentionFeedMetaTable)
		.where(eq(mobileAttentionFeedMetaTable.id, 1))
		.get();
	if (row === undefined) {
		// The migration seeds row id=1; a missing row means an unmigrated database.
		return { nextSeq: 1, prunedThroughSeq: 0 };
	}
	return { nextSeq: row.nextSeq, prunedThroughSeq: row.prunedThroughSeq };
}

function readAckedSeq(db: AppDatabaseReader, mobileClientId: string): number {
	const row = db
		.select({ ackedSeq: mobileAttentionAckCursorsTable.ackedSeq })
		.from(mobileAttentionAckCursorsTable)
		.where(eq(mobileAttentionAckCursorsTable.mobileClientId, mobileClientId))
		.get();
	return row?.ackedSeq ?? 0;
}

function countUnread(db: AppDatabaseReader, ackedSeq: number): number {
	const row = db
		.select({ value: count() })
		.from(mobileAttentionEventsTable)
		.where(gt(mobileAttentionEventsTable.seq, ackedSeq))
		.get();
	return row?.value ?? 0;
}

function encodeCursor(seq: number): string {
	return Buffer.from(JSON.stringify(["mobile-attention-v1", seq]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new MobileAttentionCursorError();
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 2 ||
		parsed[0] !== "mobile-attention-v1" ||
		typeof parsed[1] !== "number" ||
		!Number.isSafeInteger(parsed[1]) ||
		parsed[1] < 0
	) {
		throw new MobileAttentionCursorError();
	}
	return parsed[1];
}
