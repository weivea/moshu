import type {
	ActionRisk,
	ApprovalActionSummary,
	ApprovalDecisionKind,
	ApprovalRequest,
	ApprovalState,
	DecideApprovalOutput,
	DecisionSource,
	ListApprovalsOutput,
	SessionApprovalPolicy,
	UpdateSessionApprovalPolicyOutput,
} from "@moshu/contracts";
import {
	type ApprovalRepository,
	type ApprovalRequestRecord,
	createUuidV7,
	type ListApprovalRequestsFilter,
	type RunJournalRepository,
	type SessionApprovalPolicyRecord,
} from "@moshu/database";

// ---------------------------------------------------------------------------
// Server-authoritative Tool/Action approval orchestration.
//
// The ApprovalService is the seam between the durable approval repository and
// the live execution gate + multi-client event hub. It:
//   * blocks a side-effecting Action until a client decides or a Session
//     "Allow all" policy covers it (requireApproval),
//   * applies decisions with CAS/idempotency and wakes the waiting Action,
//   * emits created/updated/policyChanged events for every visible client.
// It intentionally depends only on @moshu/database, @moshu/contracts and a Run
// snapshot reader, so it is fully testable without the pi agent runtime.
// ---------------------------------------------------------------------------

export interface ApprovalGateRequest {
	runId: string;
	invocationId: string;
	toolCallId: string;
	actionId: string;
	action: ApprovalActionSummary;
	risk: ActionRisk;
}

export interface ActionApprovalGate {
	requireApproval(request: ApprovalGateRequest, options?: { signal?: AbortSignal }): Promise<void>;
}

export class ActionApprovalRejectedError extends Error {
	readonly approvalId: string;
	readonly state: ApprovalState;
	constructor(record: ApprovalRequestRecord) {
		super(`Action approval ${record.id} was ${record.state}.`);
		this.name = "ActionApprovalRejectedError";
		this.approvalId = record.id;
		this.state = record.state;
	}
}

export class ApprovalRunUnavailableError extends Error {
	constructor(runId: string) {
		super(`Approval Run snapshot ${runId} is unavailable.`);
		this.name = "ApprovalRunUnavailableError";
	}
}

export type ApprovalServiceEvent =
	| { type: "approval.created"; request: ApprovalRequest }
	| { type: "approval.updated"; request: ApprovalRequest }
	| { type: "sessionApprovalPolicy.changed"; policy: SessionApprovalPolicy };

export type ApprovalServiceListener = (event: ApprovalServiceEvent) => void;

export interface DecideApprovalServiceInput {
	approvalId: string;
	expectedRevision: number;
	decision: ApprovalDecisionKind;
	idempotencyKey: string;
	source: DecisionSource;
}

export interface UpdateSessionPolicyServiceInput {
	sessionId: string;
	allowAll: boolean;
	expectedRevision: number;
	idempotencyKey: string;
	updatedBy: DecisionSource;
}

interface Waiter {
	sessionId: string;
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

const defaultApprovalLifetimeMs = 10 * 60_000;

export class ApprovalService implements ActionApprovalGate {
	readonly #approvals: ApprovalRepository;
	readonly #runs: Pick<RunJournalRepository, "get">;
	readonly #clock: { now(): number };
	readonly #expiryMs: number;
	readonly #waiters = new Map<string, Waiter>();
	readonly #listeners = new Set<ApprovalServiceListener>();

	constructor(
		approvals: ApprovalRepository,
		runs: Pick<RunJournalRepository, "get">,
		options: { clock?: { now(): number }; approvalLifetimeMs?: number } = {},
	) {
		this.#approvals = approvals;
		this.#runs = runs;
		this.#clock = options.clock ?? { now: Date.now };
		this.#expiryMs = options.approvalLifetimeMs ?? defaultApprovalLifetimeMs;
	}

	subscribe(listener: ApprovalServiceListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async requireApproval(
		request: ApprovalGateRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		const sessionId = this.#resolveSessionId(request.runId);
		const policy = this.#approvals.getPolicy(sessionId);
		// Session "Allow all" only auto-approves overridable Actions; server-classified
		// non-overridable (critical) risk is never bypassed.
		const autoApprove = policy.allowAll && request.risk.overridable;
		const now = this.#clock.now();
		const record = this.#approvals.create({
			id: createUuidV7(now),
			sessionId,
			runId: request.runId,
			actionId: request.actionId,
			toolCallId: request.toolCallId,
			action: request.action,
			risk: request.risk,
			createdAtMs: now,
			expiresAtMs: now + this.#expiryMs,
			...(autoApprove ? { policyApproval: { allowAllRevision: policy.revision } } : {}),
		});
		this.#emit({ type: "approval.created", request: toApprovalRequest(record) });
		if (record.state === "approved") {
			return;
		}
		if (record.state !== "pending") {
			throw new ActionApprovalRejectedError(record);
		}
		if (options.signal?.aborted) {
			const cancelled = this.#approvals.cancel(record.id, systemSource());
			this.#emit({ type: "approval.updated", request: toApprovalRequest(cancelled) });
			throw new ActionApprovalRejectedError(cancelled);
		}
		return await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { sessionId, resolve, reject };
			if (options.signal !== undefined) {
				const signal = options.signal;
				const onAbort = () => {
					if (!this.#waiters.has(record.id)) {
						return;
					}
					this.#waiters.delete(record.id);
					try {
						const cancelled = this.#approvals.cancel(record.id, systemSource());
						this.#emit({ type: "approval.updated", request: toApprovalRequest(cancelled) });
						reject(new ActionApprovalRejectedError(cancelled));
					} catch (error) {
						reject(error as Error);
					}
				};
				waiter.signal = signal;
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.#waiters.set(record.id, waiter);
		});
	}

	listApprovals(filter: ListApprovalRequestsFilter = {}): ListApprovalsOutput {
		const result = this.#approvals.list(filter);
		return {
			schemaVersion: 1,
			items: result.items.map(toApprovalRequest),
			policies: result.policies.map(toSessionApprovalPolicy),
		};
	}

	getApproval(approvalId: string): { request: ApprovalRequest; policy: SessionApprovalPolicy } {
		const record = this.#approvals.getOrThrow(approvalId);
		return {
			request: toApprovalRequest(record),
			policy: toSessionApprovalPolicy(this.#approvals.getPolicy(record.sessionId)),
		};
	}

	getSessionPolicy(sessionId: string): SessionApprovalPolicy {
		return toSessionApprovalPolicy(this.#approvals.getPolicy(sessionId));
	}

	decideApproval(input: DecideApprovalServiceInput): DecideApprovalOutput {
		const result = this.#approvals.decide({
			approvalId: input.approvalId,
			expectedRevision: input.expectedRevision,
			decision: input.decision,
			idempotencyKey: input.idempotencyKey,
			source: input.source,
		});
		const settled = this.#settleWaiter(result.record);
		if (result.outcome === "applied" || settled) {
			this.#emit({ type: "approval.updated", request: toApprovalRequest(result.record) });
		}
		return {
			schemaVersion: 1,
			outcome: result.outcome,
			request: toApprovalRequest(result.record),
		};
	}

	updateSessionPolicy(input: UpdateSessionPolicyServiceInput): UpdateSessionApprovalPolicyOutput {
		const result = this.#approvals.updatePolicy({
			sessionId: input.sessionId,
			allowAll: input.allowAll,
			expectedRevision: input.expectedRevision,
			idempotencyKey: input.idempotencyKey,
			updatedBy: input.updatedBy,
		});
		if (result.outcome === "applied") {
			this.#emit({
				type: "sessionApprovalPolicy.changed",
				policy: toSessionApprovalPolicy(result.policy),
			});
		}
		return { schemaVersion: 1, policy: toSessionApprovalPolicy(result.policy) };
	}

	sweepExpired(nowMs?: number): number {
		const expired = this.#approvals.expireDue(nowMs ?? this.#clock.now());
		for (const record of expired) {
			this.#settleWaiter(record);
			this.#emit({ type: "approval.updated", request: toApprovalRequest(record) });
		}
		return expired.length;
	}

	recoverOnStartup(nowMs?: number): { expired: number; policiesReset: number } {
		return this.#approvals.recoverOnStartup(nowMs ?? this.#clock.now());
	}

	resetForSession(sessionId: string, nowMs?: number): void {
		const now = nowMs ?? this.#clock.now();
		const affected = [...this.#waiters.entries()].filter(
			([, waiter]) => waiter.sessionId === sessionId,
		);
		this.#approvals.resetForSession(sessionId, now);
		for (const [id] of affected) {
			const record = this.#approvals.get(id);
			if (record !== undefined) {
				this.#settleWaiter(record);
				this.#emit({ type: "approval.updated", request: toApprovalRequest(record) });
			}
		}
		this.#emit({
			type: "sessionApprovalPolicy.changed",
			policy: toSessionApprovalPolicy(this.#approvals.getPolicy(sessionId, now)),
		});
	}

	#settleWaiter(record: ApprovalRequestRecord): boolean {
		const waiter = this.#waiters.get(record.id);
		if (waiter === undefined) {
			return false;
		}
		this.#waiters.delete(record.id);
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		if (record.state === "approved") {
			waiter.resolve();
		} else {
			waiter.reject(new ActionApprovalRejectedError(record));
		}
		return true;
	}

	#emit(event: ApprovalServiceEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// A misbehaving subscriber must never break approval state transitions.
			}
		}
	}

	#resolveSessionId(runId: string): string {
		try {
			return this.#runs.get(runId).sessionId;
		} catch {
			throw new ApprovalRunUnavailableError(runId);
		}
	}
}

function systemSource(): DecisionSource {
	return { kind: "system" };
}

export function toApprovalRequest(record: ApprovalRequestRecord): ApprovalRequest {
	return {
		schemaVersion: 1,
		id: record.id,
		sessionId: record.sessionId,
		runId: record.runId,
		actionId: record.actionId,
		toolCallId: record.toolCallId,
		action: record.action,
		risk: record.risk,
		state: record.state,
		revision: record.revision,
		createdAt: new Date(record.createdAtMs).toISOString(),
		expiresAt: new Date(record.expiresAtMs).toISOString(),
		...(record.decidedAtMs === undefined
			? {}
			: { decidedAt: new Date(record.decidedAtMs).toISOString() }),
		...(record.decision === undefined ? {} : { decision: record.decision }),
		...(record.policyEvidence === undefined ? {} : { policyEvidence: record.policyEvidence }),
	};
}

export function toSessionApprovalPolicy(
	record: SessionApprovalPolicyRecord,
): SessionApprovalPolicy {
	return {
		schemaVersion: 1,
		sessionId: record.sessionId,
		allowAll: record.allowAll,
		revision: record.revision,
		updatedAt: new Date(record.updatedAtMs).toISOString(),
		...(record.updatedBy === undefined ? {} : { updatedBy: record.updatedBy }),
	};
}
