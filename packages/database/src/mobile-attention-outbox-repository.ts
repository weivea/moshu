import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import type {
	AppendMobileAttentionInput,
	MobileAttentionRepository,
} from "./mobile-attention-repository";
import { mobileAttentionOutboxTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

// The minimal write surface the approval / Run repositories depend on. Both call `enqueue` from inside
// their own business transaction; because better-sqlite3 is a single synchronous connection, the insert
// joins that transaction and is atomic with the business write.
export interface MobileAttentionOutboxWriter {
	enqueue(input: AppendMobileAttentionInput): void;
}

// A claimed, not-yet-projected outbox row. Carries exactly the desensitized attention payload plus the
// bookkeeping the drainer needs (id, attempts) — never any business content.
export interface MobileAttentionOutboxRecord {
	id: number;
	dedupeKey: string;
	input: AppendMobileAttentionInput;
	attempts: number;
}

export interface MobileAttentionOutboxRepository extends MobileAttentionOutboxWriter {
	claimPending(limit?: number): MobileAttentionOutboxRecord[];
	markProcessed(id: number, processedAtMs?: number): void;
	markFailed(id: number, error: string): void;
	pendingCount(): number;
	deleteProcessedBefore(cutoffMs: number): number;
}

// How many rows the drainer projects per drain pass. Bounded so a burst can never monopolize the event
// loop; the drainer keeps looping until `pendingCount()` reaches zero.
export const mobileAttentionOutboxDrainBatchSize = 100;

interface OutboxRow {
	id: number;
	dedupeKey: string;
	type: AppendMobileAttentionInput["type"];
	sessionId: string | null;
	runId: string | null;
	approvalId: string | null;
	titleKey: string;
	bodyKey: string;
	createdAtMs: number;
	attempts: number;
}

export class SqliteMobileAttentionOutboxRepository implements MobileAttentionOutboxRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	enqueue(input: AppendMobileAttentionInput): void {
		if (input.dedupeKey.length === 0 || input.dedupeKey.length > 256) {
			throw new TypeError("Mobile attention dedupe key must be between 1 and 256 characters.");
		}
		const now = this.clock.now();
		this.orm
			.insert(mobileAttentionOutboxTable)
			.values({
				dedupeKey: input.dedupeKey,
				type: input.type,
				sessionId: input.sessionId ?? null,
				runId: input.runId ?? null,
				approvalId: input.approvalId ?? null,
				titleKey: input.titleKey,
				bodyKey: input.bodyKey,
				createdAtMs: input.createdAtMs ?? now,
				enqueuedAtMs: now,
				processedAtMs: null,
				attempts: 0,
				lastError: null,
			})
			// A retried business transaction (or a duplicate delivery) must not enqueue twice; the
			// unique dedupe key makes the enqueue idempotent within the caller's transaction.
			.onConflictDoNothing({ target: mobileAttentionOutboxTable.dedupeKey })
			.run();
	}

	claimPending(limit: number = mobileAttentionOutboxDrainBatchSize): MobileAttentionOutboxRecord[] {
		const rows = this.orm
			.select()
			.from(mobileAttentionOutboxTable)
			.where(isNull(mobileAttentionOutboxTable.processedAtMs))
			.orderBy(asc(mobileAttentionOutboxTable.id))
			.limit(Math.max(1, Math.trunc(limit)))
			.all() as OutboxRow[];
		return rows.map(toRecord);
	}

	markProcessed(id: number, processedAtMs?: number): void {
		this.orm
			.update(mobileAttentionOutboxTable)
			.set({ processedAtMs: processedAtMs ?? this.clock.now(), lastError: null })
			.where(eq(mobileAttentionOutboxTable.id, id))
			.run();
	}

	markFailed(id: number, error: string): void {
		this.orm
			.update(mobileAttentionOutboxTable)
			.set({
				attempts: sql`${mobileAttentionOutboxTable.attempts} + 1`,
				lastError: error.slice(0, 512),
			})
			.where(eq(mobileAttentionOutboxTable.id, id))
			.run();
	}

	pendingCount(): number {
		const row = this.orm
			.select({ value: sql<number>`count(*)` })
			.from(mobileAttentionOutboxTable)
			.where(isNull(mobileAttentionOutboxTable.processedAtMs))
			.get();
		return row?.value ?? 0;
	}

	deleteProcessedBefore(cutoffMs: number): number {
		const result = this.orm
			.delete(mobileAttentionOutboxTable)
			.where(
				and(
					sql`${mobileAttentionOutboxTable.processedAtMs} IS NOT NULL`,
					lt(mobileAttentionOutboxTable.processedAtMs, cutoffMs),
				),
			)
			.run();
		return Number(result.changes ?? 0);
	}
}

function toRecord(row: OutboxRow): MobileAttentionOutboxRecord {
	const input: AppendMobileAttentionInput = {
		type: row.type,
		dedupeKey: row.dedupeKey,
		titleKey: row.titleKey,
		bodyKey: row.bodyKey,
		createdAtMs: row.createdAtMs,
		...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
		...(row.runId === null ? {} : { runId: row.runId }),
		...(row.approvalId === null ? {} : { approvalId: row.approvalId }),
	};
	return { id: row.id, dedupeKey: row.dedupeKey, input, attempts: row.attempts };
}

// How long a processed outbox row is retained for diagnostics before the bounded cleanup removes it.
// Idempotency against double-projection lives in `mobile_attention_events.dedupe_key`, so a processed
// row can be safely dropped once it has aged out.
export const mobileAttentionOutboxProcessedRetentionMs = 24 * 60 * 60 * 1_000;

// Convenience used by the drainer: project a single claimed row into the durable feed. Kept here so the
// production drainer and tests share one idempotent projection path. Returns whether a NEW feed row was
// written (so the caller knows whether to emit the live `attention.changed` hint).
export function projectOutboxRecord(
	attention: MobileAttentionRepository,
	record: MobileAttentionOutboxRecord,
): boolean {
	return attention.append(record.input).appended;
}
