import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionRisk, ApprovalActionSummary } from "@moshu/contracts";
import {
	type AppDatabase,
	buildApprovalPendingAttentionInput,
	buildRunTerminalAttentionInput,
	createUuidV7,
	type MobileAttentionOutboxWriter,
	openAppDatabase,
	SqliteApprovalRepository,
} from "../src";

let db: AppDatabase;

const mediumRisk: ActionRisk = { tier: "medium", overridable: true, reasons: ["edit"] };

function makeSummary(): ApprovalActionSummary {
	return {
		tool: "bash",
		operation: "bash",
		target: { kind: "runtime-box", id: "box-1" },
		command: "echo secret-command",
		redactedParams: {},
	};
}

function makeProviderInput() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		thinkingLevel: "medium" as const,
	};
}

function seedRun(database: AppDatabase) {
	const session = database.sessions.create({ title: "Outbox Session" }).session;
	const created = database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId: session.id,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "Test prompt",
		assistantMessageId: createUuidV7(),
	});
	return { sessionId: session.id, run: created.run };
}

function createPendingApproval(database: AppDatabase, sessionId: string, runId: string): string {
	const now = Date.now();
	const id = crypto.randomUUID();
	database.approvals.create({
		id,
		sessionId,
		runId,
		actionId: crypto.randomUUID(),
		toolCallId: `call-${Math.random()}`,
		action: makeSummary(),
		risk: mediumRisk,
		createdAtMs: now,
		expiresAtMs: now + 60_000,
	});
	return id;
}

beforeEach(() => {
	db = openAppDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("mobile attention copy builders (desensitization)", () => {
	test("approval builder emits only opaque ids and localization keys", () => {
		const input = buildApprovalPendingAttentionInput({
			approvalId: "approval-1",
			sessionId: "session-1",
			runId: "run-1",
			createdAtMs: 1_000,
		});
		expect(input).toEqual({
			type: "approval_required",
			dedupeKey: "approval:approval-1",
			sessionId: "session-1",
			runId: "run-1",
			approvalId: "approval-1",
			titleKey: "attention.approvalRequired.title",
			bodyKey: "attention.approvalRequired.body",
			createdAtMs: 1_000,
		});
		// No free-form business content anywhere in the payload.
		expect(JSON.stringify(input)).not.toContain("echo");
	});

	test("run terminal builder maps each terminal status and ignores non-terminal", () => {
		expect(
			buildRunTerminalAttentionInput({ status: "completed", runId: "r", sessionId: "s" })?.type,
		).toBe("run_completed");
		expect(
			buildRunTerminalAttentionInput({ status: "failed", runId: "r", sessionId: "s" })?.type,
		).toBe("run_failed");
		expect(
			buildRunTerminalAttentionInput({ status: "cancelled", runId: "r", sessionId: "s" })?.type,
		).toBe("run_cancelled");
		expect(
			buildRunTerminalAttentionInput({ status: "running", runId: "r", sessionId: "s" }),
		).toBeUndefined();
	});
});

describe("mobile attention outbox: transactional enqueue", () => {
	test("a pending approval enqueues exactly one desensitized outbox row atomically", () => {
		const { sessionId, run } = seedRun(db);
		const approvalId = createPendingApproval(db, sessionId, run.id);

		const pending = db.mobileAttentionOutbox.claimPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.dedupeKey).toBe(`approval:${approvalId}`);
		expect(pending[0]?.input.type).toBe("approval_required");
		expect(pending[0]?.input.approvalId).toBe(approvalId);
		// Never carries the raw command / business content.
		expect(JSON.stringify(pending[0]?.input)).not.toContain("secret-command");
	});

	test("an auto-approved approval enqueues nothing", () => {
		const { sessionId, run } = seedRun(db);
		const now = Date.now();
		db.approvals.updatePolicy({
			sessionId,
			allowAll: true,
			expectedRevision: 0,
			idempotencyKey: crypto.randomUUID(),
		});
		db.approvals.create({
			id: crypto.randomUUID(),
			sessionId,
			runId: run.id,
			actionId: crypto.randomUUID(),
			toolCallId: `call-${Math.random()}`,
			action: makeSummary(),
			risk: mediumRisk,
			createdAtMs: now,
			expiresAtMs: now + 60_000,
			policyApproval: { allowAllRevision: 1 },
		});
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);
	});

	test("a Run terminal transition enqueues one row; a duplicate terminal is idempotent", () => {
		const { run } = seedRun(db);
		const assistantMessageId = run.assistantMessageId;
		db.runs.updateStatus({ runId: run.id, status: "running" });
		const first = db.runs.commitTerminal({
			runId: run.id,
			message: { messageId: assistantMessageId, status: "complete", content: "done" },
		});
		expect(first.committed).toBe(true);
		// Re-committing the same terminal message is a no-op transition and must not enqueue again.
		db.runs.commitTerminal({
			runId: run.id,
			message: { messageId: assistantMessageId, status: "complete", content: "done" },
		});
		const pending = db.mobileAttentionOutbox.claimPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.dedupeKey).toBe(`run:${run.id}`);
		expect(pending[0]?.input.type).toBe("run_completed");
	});

	test("a failing outbox enqueue rolls back the business write (atomicity)", () => {
		const { sessionId, run } = seedRun(db);
		const throwingOutbox: MobileAttentionOutboxWriter = {
			enqueue() {
				throw new Error("simulated outbox failure");
			},
		};
		const approvals = new SqliteApprovalRepository(db.orm, { now: Date.now }, throwingOutbox);
		const id = crypto.randomUUID();
		const now = Date.now();
		expect(() =>
			approvals.create({
				id,
				sessionId,
				runId: run.id,
				actionId: crypto.randomUUID(),
				toolCallId: `call-${Math.random()}`,
				action: makeSummary(),
				risk: mediumRisk,
				createdAtMs: now,
				expiresAtMs: now + 60_000,
			}),
		).toThrow("simulated outbox failure");
		// The approval insert and the outbox enqueue share one transaction: the failure rolled BOTH back.
		expect(db.approvals.get(id)).toBeUndefined();
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);
	});
});

describe("mobile attention outbox: drainer bookkeeping surface", () => {
	test("claimPending/markProcessed/markFailed/deleteProcessedBefore behave monotonically", () => {
		const { sessionId, run } = seedRun(db);
		createPendingApproval(db, sessionId, run.id);
		const [row] = db.mobileAttentionOutbox.claimPending();
		expect(row).toBeDefined();
		if (row === undefined) return;

		// A failure keeps the row pending and increments attempts.
		db.mobileAttentionOutbox.markFailed(row.id, "boom");
		const afterFail = db.mobileAttentionOutbox.claimPending();
		expect(afterFail).toHaveLength(1);
		expect(afterFail[0]?.attempts).toBe(1);

		// Marking processed removes it from the pending set.
		db.mobileAttentionOutbox.markProcessed(row.id, 5_000);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(0);

		// Bounded cleanup only removes processed rows older than the cutoff.
		expect(db.mobileAttentionOutbox.deleteProcessedBefore(4_000)).toBe(0);
		expect(db.mobileAttentionOutbox.deleteProcessedBefore(6_000)).toBe(1);
	});

	test("enqueue is idempotent per dedupe key", () => {
		const input = buildApprovalPendingAttentionInput({
			approvalId: "dupe",
			sessionId: "s",
		});
		db.mobileAttentionOutbox.enqueue(input);
		db.mobileAttentionOutbox.enqueue(input);
		expect(db.mobileAttentionOutbox.pendingCount()).toBe(1);
	});
});

describe("mobile attention outbox: crash durability", () => {
	test("a committed outbox row survives a restart and can still be drained", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-outbox-"));
		const databasePath = join(directory, "app.db");
		try {
			const first = openAppDatabase(databasePath);
			const { sessionId, run } = seedRun(first);
			const approvalId = createPendingApproval(first, sessionId, run.id);
			// Simulate a crash BEFORE the drainer projected the row: close without projecting.
			expect(first.mobileAttentionOutbox.pendingCount()).toBe(1);
			expect(first.mobileAttention.latestSeq()).toBe(0);
			first.close();

			const reopened = openAppDatabase(databasePath);
			const pending = reopened.mobileAttentionOutbox.claimPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.dedupeKey).toBe(`approval:${approvalId}`);
			reopened.close();
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
