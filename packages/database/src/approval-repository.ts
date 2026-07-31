import {
	type ActionRisk,
	type ApprovalActionSummary,
	type ApprovalDecision,
	type ApprovalDecisionKind,
	type ApprovalState,
	actionRiskSchema,
	approvalActionSummarySchema,
	approvalDecisionSchema,
	type DecisionSource,
} from "@moshu/contracts";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { AppDrizzleDatabase } from "./database";
import { buildApprovalPendingAttentionInput } from "./mobile-attention-copy";
import type { MobileAttentionOutboxWriter } from "./mobile-attention-outbox-repository";
import { actionApprovalRequestsTable, sessionApprovalPoliciesTable } from "./schema";

// ---------------------------------------------------------------------------
// Durable Tool/Action approval persistence.
//
// The repository owns the approval state machine and its optimistic-concurrency
// (revision/CAS) and idempotency guarantees. Every state transition bumps the
// revision; a decision carries an idempotency key so retries are safe and only
// one of two racing clients ever "wins". Session "Allow all" policies are
// session-scoped and revisioned here as well.
// ---------------------------------------------------------------------------

export interface ApprovalRequestRecord {
	id: string;
	sessionId: string;
	runId: string;
	actionId: string;
	toolCallId: string;
	action: ApprovalActionSummary;
	risk: ActionRisk;
	state: ApprovalState;
	revision: number;
	createdAtMs: number;
	expiresAtMs: number;
	decidedAtMs?: number;
	decision?: ApprovalDecision;
	policyEvidence?: { allowAllRevision: number };
}

export interface SessionApprovalPolicyRecord {
	sessionId: string;
	allowAll: boolean;
	revision: number;
	updatedAtMs: number;
	updatedBy?: DecisionSource;
}

export interface CreateApprovalRequestInput {
	id: string;
	sessionId: string;
	runId: string;
	actionId: string;
	toolCallId: string;
	action: ApprovalActionSummary;
	risk: ActionRisk;
	createdAtMs: number;
	expiresAtMs: number;
	// When present, the request is created already approved because a Session
	// "Allow all" policy covered it. Only overridable risk may be auto-approved;
	// the caller (ApprovalService) enforces that invariant.
	policyApproval?: { allowAllRevision: number };
}

export interface DecideApprovalRequestInput {
	approvalId: string;
	expectedRevision: number;
	decision: ApprovalDecisionKind;
	idempotencyKey: string;
	source: DecisionSource;
	nowMs?: number;
}

export type DecideApprovalOutcome = "applied" | "idempotent" | "superseded";

export interface DecideApprovalRequestResult {
	outcome: DecideApprovalOutcome;
	record: ApprovalRequestRecord;
}

export interface ListApprovalRequestsFilter {
	sessionId?: string;
	states?: readonly ApprovalState[];
	limit?: number;
}

export interface ListApprovalRequestsResult {
	items: ApprovalRequestRecord[];
	policies: SessionApprovalPolicyRecord[];
}

export interface UpdateSessionApprovalPolicyDbInput {
	sessionId: string;
	allowAll: boolean;
	expectedRevision: number;
	idempotencyKey: string;
	updatedBy: DecisionSource;
	nowMs?: number;
}

export type UpdateSessionApprovalPolicyOutcome = "applied" | "idempotent";

export interface UpdateSessionApprovalPolicyResult {
	outcome: UpdateSessionApprovalPolicyOutcome;
	policy: SessionApprovalPolicyRecord;
}

export class ApprovalRequestNotFoundError extends Error {
	constructor(approvalId: string) {
		super(`Approval request ${approvalId} was not found.`);
		this.name = "ApprovalRequestNotFoundError";
	}
}

export class ApprovalRevisionConflictError extends Error {
	readonly currentRevision: number;
	constructor(currentRevision: number) {
		super(`Approval request revision conflict; current revision is ${currentRevision}.`);
		this.name = "ApprovalRevisionConflictError";
		this.currentRevision = currentRevision;
	}
}

export class SessionApprovalPolicyRevisionConflictError extends Error {
	readonly currentRevision: number;
	constructor(currentRevision: number) {
		super(`Session approval policy revision conflict; current revision is ${currentRevision}.`);
		this.name = "SessionApprovalPolicyRevisionConflictError";
		this.currentRevision = currentRevision;
	}
}

type ApprovalRow = typeof actionApprovalRequestsTable.$inferSelect;
type PolicyRow = typeof sessionApprovalPoliciesTable.$inferSelect;

export interface ApprovalRepository {
	create(input: CreateApprovalRequestInput): ApprovalRequestRecord;
	get(approvalId: string): ApprovalRequestRecord | undefined;
	getOrThrow(approvalId: string): ApprovalRequestRecord;
	list(filter?: ListApprovalRequestsFilter): ListApprovalRequestsResult;
	decide(input: DecideApprovalRequestInput): DecideApprovalRequestResult;
	cancel(approvalId: string, source: DecisionSource, nowMs?: number): ApprovalRequestRecord;
	expireDue(nowMs?: number): ApprovalRequestRecord[];
	recoverOnStartup(nowMs?: number): { expired: number; policiesReset: number };
	getPolicy(sessionId: string, nowMs?: number): SessionApprovalPolicyRecord;
	updatePolicy(input: UpdateSessionApprovalPolicyDbInput): UpdateSessionApprovalPolicyResult;
	resetForSession(sessionId: string, nowMs?: number): void;
}

export class SqliteApprovalRepository implements ApprovalRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: { now(): number } = { now: Date.now },
		// Optional transactional outbox. When present, a newly-pending approval enqueues a desensitized
		// Mobile attention row in the SAME transaction as the approval insert, so a crash between the
		// two can never permanently lose the phone's unread signal.
		private readonly attentionOutbox?: MobileAttentionOutboxWriter,
	) {}

	create(input: CreateApprovalRequestInput): ApprovalRequestRecord {
		const action = approvalActionSummarySchema.parse(input.action);
		const risk = actionRiskSchema.parse(input.risk);
		if (input.policyApproval !== undefined && !risk.overridable) {
			throw new TypeError("Non-overridable risk cannot be auto-approved by policy.");
		}
		const approved = input.policyApproval !== undefined;
		const decision: ApprovalDecision | undefined = approved
			? {
					kind: "approve_once",
					source: { kind: "policy" },
					decidedAt: new Date(input.createdAtMs).toISOString(),
				}
			: undefined;
		return this.orm.transaction((transaction) => {
			transaction
				.insert(actionApprovalRequestsTable)
				.values({
					id: input.id,
					sessionId: input.sessionId,
					runId: input.runId,
					actionId: input.actionId,
					toolCallId: input.toolCallId,
					tool: action.tool,
					operation: action.operation,
					actionSummaryJson: JSON.stringify(action),
					riskTier: risk.tier,
					riskOverridable: risk.overridable ? 1 : 0,
					riskJson: JSON.stringify(risk),
					state: approved ? "approved" : "pending",
					revision: 1,
					decisionIdempotencyKey: null,
					decisionJson: decision === undefined ? null : JSON.stringify(decision),
					policyEvidenceJson:
						input.policyApproval === undefined ? null : JSON.stringify(input.policyApproval),
					createdAtMs: input.createdAtMs,
					expiresAtMs: input.expiresAtMs,
					decidedAtMs: approved ? input.createdAtMs : null,
				})
				.run();
			if (!approved) {
				this.attentionOutbox?.enqueue(
					buildApprovalPendingAttentionInput({
						approvalId: input.id,
						sessionId: input.sessionId,
						runId: input.runId,
						createdAtMs: input.createdAtMs,
					}),
				);
			}
			return this.getOrThrow(input.id);
		});
	}

	get(approvalId: string): ApprovalRequestRecord | undefined {
		const row = this.orm
			.select()
			.from(actionApprovalRequestsTable)
			.where(eq(actionApprovalRequestsTable.id, approvalId))
			.get();
		return row === undefined ? undefined : mapApprovalRow(row);
	}

	getOrThrow(approvalId: string): ApprovalRequestRecord {
		const record = this.get(approvalId);
		if (record === undefined) {
			throw new ApprovalRequestNotFoundError(approvalId);
		}
		return record;
	}

	list(filter: ListApprovalRequestsFilter = {}): ListApprovalRequestsResult {
		const conditions = [];
		if (filter.sessionId !== undefined) {
			conditions.push(eq(actionApprovalRequestsTable.sessionId, filter.sessionId));
		}
		if (filter.states !== undefined && filter.states.length > 0) {
			conditions.push(inArray(actionApprovalRequestsTable.state, [...filter.states]));
		}
		const limit = Math.min(Math.max(filter.limit ?? 200, 1), 200);
		const rows = this.orm
			.select()
			.from(actionApprovalRequestsTable)
			.where(conditions.length === 0 ? undefined : and(...conditions))
			.orderBy(desc(actionApprovalRequestsTable.createdAtMs))
			.limit(limit)
			.all();
		const items = rows.map(mapApprovalRow);
		if (filter.sessionId !== undefined) {
			const policyRows = this.orm
				.select()
				.from(sessionApprovalPoliciesTable)
				.where(eq(sessionApprovalPoliciesTable.sessionId, filter.sessionId))
				.all();
			const policies = policyRows.map(mapPolicyRow);
			if (policies.length === 0) {
				policies.push(this.#defaultPolicy(filter.sessionId));
			}
			return { items, policies };
		}
		// Unscoped list: only return policies for the sessions represented in the
		// bounded item page. The item page is already capped at `limit` (<=200), so
		// the distinct session set — and therefore the policy list — can never exceed
		// the wire contract's max regardless of how many sessions have a policy.
		const sessionIds = [...new Set(items.map((item) => item.sessionId))];
		const policies =
			sessionIds.length === 0
				? []
				: this.orm
						.select()
						.from(sessionApprovalPoliciesTable)
						.where(inArray(sessionApprovalPoliciesTable.sessionId, sessionIds))
						.all()
						.map(mapPolicyRow);
		return { items, policies };
	}

	decide(input: DecideApprovalRequestInput): DecideApprovalRequestResult {
		const now = input.nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const row = transaction
				.select()
				.from(actionApprovalRequestsTable)
				.where(eq(actionApprovalRequestsTable.id, input.approvalId))
				.get();
			if (row === undefined) {
				throw new ApprovalRequestNotFoundError(input.approvalId);
			}
			// Same decision retried (idempotency): return the prior authoritative result.
			if (row.decisionIdempotencyKey === input.idempotencyKey) {
				return { outcome: "idempotent", record: mapApprovalRow(row) };
			}
			// Already resolved by another decision or policy/expiry: authoritative final.
			if (row.state !== "pending") {
				return { outcome: "superseded", record: mapApprovalRow(row) };
			}
			// Lazily expire a request whose deadline has passed rather than deciding it.
			if (row.expiresAtMs <= now) {
				const expired = this.#applyTerminal(transaction, row, "expired", now, undefined, undefined);
				return { outcome: "superseded", record: expired };
			}
			if (input.expectedRevision !== row.revision) {
				throw new ApprovalRevisionConflictError(row.revision);
			}
			const nextState: ApprovalState = input.decision === "approve_once" ? "approved" : "rejected";
			const decision: ApprovalDecision = {
				kind: input.decision,
				source: input.source,
				decidedAt: new Date(now).toISOString(),
			};
			const record = this.#applyTerminal(
				transaction,
				row,
				nextState,
				now,
				decision,
				input.idempotencyKey,
			);
			return { outcome: "applied", record };
		});
	}

	cancel(approvalId: string, source: DecisionSource, nowMs?: number): ApprovalRequestRecord {
		const now = nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const row = transaction
				.select()
				.from(actionApprovalRequestsTable)
				.where(eq(actionApprovalRequestsTable.id, approvalId))
				.get();
			if (row === undefined) {
				throw new ApprovalRequestNotFoundError(approvalId);
			}
			if (row.state !== "pending") {
				return mapApprovalRow(row);
			}
			const decision: ApprovalDecision = {
				kind: "reject",
				source,
				decidedAt: new Date(now).toISOString(),
			};
			return this.#applyTerminal(transaction, row, "cancelled", now, decision, undefined);
		});
	}

	expireDue(nowMs?: number): ApprovalRequestRecord[] {
		const now = nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const rows = transaction
				.select()
				.from(actionApprovalRequestsTable)
				.where(
					and(
						eq(actionApprovalRequestsTable.state, "pending"),
						lte(actionApprovalRequestsTable.expiresAtMs, now),
					),
				)
				.all();
			return rows.map((row) =>
				this.#applyTerminal(transaction, row, "expired", now, undefined, undefined),
			);
		});
	}

	recoverOnStartup(nowMs?: number): { expired: number; policiesReset: number } {
		const now = nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const rows = transaction
				.select()
				.from(actionApprovalRequestsTable)
				.where(eq(actionApprovalRequestsTable.state, "pending"))
				.all();
			for (const row of rows) {
				this.#applyTerminal(transaction, row, "expired", now, undefined, undefined);
			}
			// SEC-003: a Session "Allow all" policy must never survive an Agent Server
			// restart and silently keep auto-approving new Actions. In the same
			// transaction, reset every enabled policy to allowAll=false with a revision
			// bump and a system-restart attribution. This is naturally idempotent: a
			// second recovery finds no enabled policies (and no pending requests) left.
			const enabledPolicies = transaction
				.select()
				.from(sessionApprovalPoliciesTable)
				.where(eq(sessionApprovalPoliciesTable.allowAll, 1))
				.all();
			const updatedByJson = JSON.stringify(systemRestartSource());
			for (const policy of enabledPolicies) {
				const nextRevision = policy.revision + 1;
				transaction
					.update(sessionApprovalPoliciesTable)
					.set({
						allowAll: 0,
						revision: nextRevision,
						updatedByJson,
						lastIdempotencyKey: `system-restart:${policy.sessionId}:${nextRevision}`,
						updatedAtMs: now,
					})
					.where(eq(sessionApprovalPoliciesTable.sessionId, policy.sessionId))
					.run();
			}
			return { expired: rows.length, policiesReset: enabledPolicies.length };
		});
	}

	getPolicy(sessionId: string, nowMs?: number): SessionApprovalPolicyRecord {
		const row = this.orm
			.select()
			.from(sessionApprovalPoliciesTable)
			.where(eq(sessionApprovalPoliciesTable.sessionId, sessionId))
			.get();
		return row === undefined ? this.#defaultPolicy(sessionId, nowMs) : mapPolicyRow(row);
	}

	updatePolicy(input: UpdateSessionApprovalPolicyDbInput): UpdateSessionApprovalPolicyResult {
		const now = input.nowMs ?? this.clock.now();
		return this.orm.transaction((transaction) => {
			const row = transaction
				.select()
				.from(sessionApprovalPoliciesTable)
				.where(eq(sessionApprovalPoliciesTable.sessionId, input.sessionId))
				.get();
			if (row !== undefined && row.lastIdempotencyKey === input.idempotencyKey) {
				return { outcome: "idempotent", policy: mapPolicyRow(row) };
			}
			const currentRevision = row?.revision ?? 0;
			if (input.expectedRevision !== currentRevision) {
				throw new SessionApprovalPolicyRevisionConflictError(currentRevision);
			}
			const nextRevision = currentRevision + 1;
			const updatedByJson = JSON.stringify(input.updatedBy);
			if (row === undefined) {
				transaction
					.insert(sessionApprovalPoliciesTable)
					.values({
						sessionId: input.sessionId,
						allowAll: input.allowAll ? 1 : 0,
						revision: nextRevision,
						updatedByJson,
						lastIdempotencyKey: input.idempotencyKey,
						updatedAtMs: now,
					})
					.run();
			} else {
				transaction
					.update(sessionApprovalPoliciesTable)
					.set({
						allowAll: input.allowAll ? 1 : 0,
						revision: nextRevision,
						updatedByJson,
						lastIdempotencyKey: input.idempotencyKey,
						updatedAtMs: now,
					})
					.where(eq(sessionApprovalPoliciesTable.sessionId, input.sessionId))
					.run();
			}
			return {
				outcome: "applied",
				policy: {
					sessionId: input.sessionId,
					allowAll: input.allowAll,
					revision: nextRevision,
					updatedAtMs: now,
					updatedBy: input.updatedBy,
				},
			};
		});
	}

	resetForSession(sessionId: string, nowMs?: number): void {
		const now = nowMs ?? this.clock.now();
		this.orm.transaction((transaction) => {
			const rows = transaction
				.select()
				.from(actionApprovalRequestsTable)
				.where(
					and(
						eq(actionApprovalRequestsTable.sessionId, sessionId),
						eq(actionApprovalRequestsTable.state, "pending"),
					),
				)
				.all();
			for (const row of rows) {
				this.#applyTerminal(transaction, row, "cancelled", now, undefined, undefined);
			}
			transaction
				.delete(sessionApprovalPoliciesTable)
				.where(eq(sessionApprovalPoliciesTable.sessionId, sessionId))
				.run();
		});
	}

	#applyTerminal(
		transaction: Pick<AppDrizzleDatabase, "update">,
		row: ApprovalRow,
		state: ApprovalState,
		nowMs: number,
		decision: ApprovalDecision | undefined,
		idempotencyKey: string | undefined,
	): ApprovalRequestRecord {
		const nextRevision = row.revision + 1;
		transaction
			.update(actionApprovalRequestsTable)
			.set({
				state,
				revision: nextRevision,
				decidedAtMs: nowMs,
				...(decision === undefined ? {} : { decisionJson: JSON.stringify(decision) }),
				...(idempotencyKey === undefined ? {} : { decisionIdempotencyKey: idempotencyKey }),
			})
			.where(eq(actionApprovalRequestsTable.id, row.id))
			.run();
		return mapApprovalRow({
			...row,
			state,
			revision: nextRevision,
			decidedAtMs: nowMs,
			decisionJson: decision === undefined ? row.decisionJson : JSON.stringify(decision),
			decisionIdempotencyKey:
				idempotencyKey === undefined ? row.decisionIdempotencyKey : idempotencyKey,
		});
	}

	#defaultPolicy(sessionId: string, nowMs?: number): SessionApprovalPolicyRecord {
		return {
			sessionId,
			allowAll: false,
			revision: 0,
			updatedAtMs: nowMs ?? this.clock.now(),
		};
	}
}

function mapApprovalRow(row: ApprovalRow): ApprovalRequestRecord {
	return {
		id: row.id,
		sessionId: row.sessionId,
		runId: row.runId,
		actionId: row.actionId,
		toolCallId: row.toolCallId,
		action: approvalActionSummarySchema.parse(JSON.parse(row.actionSummaryJson)),
		risk: actionRiskSchema.parse(JSON.parse(row.riskJson)),
		state: row.state,
		revision: row.revision,
		createdAtMs: row.createdAtMs,
		expiresAtMs: row.expiresAtMs,
		...(row.decidedAtMs === null ? {} : { decidedAtMs: row.decidedAtMs }),
		...(row.decisionJson === null
			? {}
			: { decision: approvalDecisionSchema.parse(JSON.parse(row.decisionJson)) }),
		...(row.policyEvidenceJson === null
			? {}
			: { policyEvidence: JSON.parse(row.policyEvidenceJson) as { allowAllRevision: number } }),
	};
}

function mapPolicyRow(row: PolicyRow): SessionApprovalPolicyRecord {
	return {
		sessionId: row.sessionId,
		allowAll: row.allowAll !== 0,
		revision: row.revision,
		updatedAtMs: row.updatedAtMs,
		...(row.updatedByJson === null
			? {}
			: { updatedBy: JSON.parse(row.updatedByJson) as DecisionSource }),
	};
}

// Attribution recorded when an Agent Server restart resets a Session "Allow all"
// policy. It is a server-owned system decision, never a client identity.
function systemRestartSource(): DecisionSource {
	return { kind: "system", clientRole: "restart" };
}
