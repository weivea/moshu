import { describe, expect, test } from "bun:test";
import type { ActionRisk, ApprovalActionSummary, DecisionSource } from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "../src";

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

function setup() {
	const database = openAppDatabase(":memory:");
	const session = database.sessions.create({ title: "Approval Session" }).session;
	const run = database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId: session.id,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "Test prompt",
	}).run;
	return { database, sessionId: session.id, runId: run.id };
}

function makeSummary(overrides: Partial<ApprovalActionSummary> = {}): ApprovalActionSummary {
	return {
		tool: "bash",
		operation: "bash",
		target: { kind: "runtime-box", id: "box-1" },
		command: "echo hi",
		redactedParams: {},
		...overrides,
	};
}

const mediumRisk: ActionRisk = { tier: "medium", overridable: true, reasons: ["edit"] };
const criticalRisk: ActionRisk = { tier: "critical", overridable: false, reasons: ["sudo"] };

const clientSource: DecisionSource = { kind: "client", clientId: "peer-a", clientRole: "client" };
const otherClientSource: DecisionSource = {
	kind: "client",
	clientId: "peer-b",
	clientRole: "client",
};

function createPending(
	database: ReturnType<typeof openAppDatabase>,
	sessionId: string,
	runId: string,
	risk: ActionRisk = mediumRisk,
) {
	const now = Date.now();
	return database.approvals.create({
		id: crypto.randomUUID(),
		sessionId,
		runId,
		actionId: crypto.randomUUID(),
		toolCallId: `call-${Math.random()}`,
		action: makeSummary(),
		risk,
		createdAtMs: now,
		expiresAtMs: now + 60_000,
	});
}

describe("ApprovalRepository", () => {
	test("creates a pending request at revision 1", () => {
		const { database, sessionId, runId } = setup();
		try {
			const record = createPending(database, sessionId, runId);
			expect(record.state).toBe("pending");
			expect(record.revision).toBe(1);
			expect(database.approvals.getOrThrow(record.id).state).toBe("pending");
		} finally {
			database.close();
		}
	});

	test("approve_once transitions to approved, bumps revision, and records decision", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const result = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			expect(result.outcome).toBe("applied");
			expect(result.record.state).toBe("approved");
			expect(result.record.revision).toBe(2);
			expect(result.record.decision?.source.clientId).toBe("peer-a");
		} finally {
			database.close();
		}
	});

	test("reject transitions to rejected without executing", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const result = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			expect(result.outcome).toBe("applied");
			expect(result.record.state).toBe("rejected");
		} finally {
			database.close();
		}
	});

	test("two racing clients: only one wins, the loser gets superseded final state", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const winner = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			const loser = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: otherClientSource,
			});
			expect(winner.outcome).toBe("applied");
			expect(loser.outcome).toBe("superseded");
			// The loser observes the winner's authoritative outcome, not its own.
			expect(loser.record.state).toBe("approved");
			expect(loser.record.decision?.source.clientId).toBe("peer-a");
		} finally {
			database.close();
		}
	});

	test("same idempotency key retried returns idempotent with the prior result", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const key = crypto.randomUUID();
			const first = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "approve_once",
				idempotencyKey: key,
				source: clientSource,
			});
			const retry = database.approvals.decide({
				approvalId: pending.id,
				expectedRevision: pending.revision,
				decision: "approve_once",
				idempotencyKey: key,
				source: clientSource,
			});
			expect(first.outcome).toBe("applied");
			expect(retry.outcome).toBe("idempotent");
			expect(retry.record.revision).toBe(first.record.revision);
		} finally {
			database.close();
		}
	});

	test("stale expectedRevision on a still-pending request raises a conflict", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			expect(() =>
				database.approvals.decide({
					approvalId: pending.id,
					expectedRevision: pending.revision + 5,
					decision: "approve_once",
					idempotencyKey: crypto.randomUUID(),
					source: clientSource,
				}),
			).toThrow(/revision conflict/i);
		} finally {
			database.close();
		}
	});

	test("policy auto-approval is allowed for overridable risk and rejected for non-overridable", () => {
		const { database, sessionId, runId } = setup();
		try {
			const now = Date.now();
			const approved = database.approvals.create({
				id: crypto.randomUUID(),
				sessionId,
				runId,
				actionId: crypto.randomUUID(),
				toolCallId: "call-policy",
				action: makeSummary(),
				risk: mediumRisk,
				createdAtMs: now,
				expiresAtMs: now + 60_000,
				policyApproval: { allowAllRevision: 3 },
			});
			expect(approved.state).toBe("approved");
			expect(approved.decision?.source.kind).toBe("policy");
			expect(approved.policyEvidence?.allowAllRevision).toBe(3);

			expect(() =>
				database.approvals.create({
					id: crypto.randomUUID(),
					sessionId,
					runId,
					actionId: crypto.randomUUID(),
					toolCallId: "call-critical",
					action: makeSummary(),
					risk: criticalRisk,
					createdAtMs: now,
					expiresAtMs: now + 60_000,
					policyApproval: { allowAllRevision: 3 },
				}),
			).toThrow(/non-overridable/i);
		} finally {
			database.close();
		}
	});

	test("expireDue moves only past-deadline pending requests to expired", () => {
		const { database, sessionId, runId } = setup();
		try {
			const now = Date.now();
			const soon = database.approvals.create({
				id: crypto.randomUUID(),
				sessionId,
				runId,
				actionId: crypto.randomUUID(),
				toolCallId: "call-soon",
				action: makeSummary(),
				risk: mediumRisk,
				createdAtMs: now,
				expiresAtMs: now - 1,
			});
			const later = createPending(database, sessionId, runId);
			const expired = database.approvals.expireDue(now);
			expect(expired.map((record) => record.id)).toEqual([soon.id]);
			expect(database.approvals.getOrThrow(soon.id).state).toBe("expired");
			expect(database.approvals.getOrThrow(later.id).state).toBe("pending");
		} finally {
			database.close();
		}
	});

	test("recoverOnStartup expires all lingering pending requests", () => {
		const { database, sessionId, runId } = setup();
		try {
			const first = createPending(database, sessionId, runId);
			const second = createPending(database, sessionId, runId);
			const result = database.approvals.recoverOnStartup();
			expect(result.expired).toBe(2);
			expect(result.policiesReset).toBe(0);
			expect(database.approvals.getOrThrow(first.id).state).toBe("expired");
			expect(database.approvals.getOrThrow(second.id).state).toBe("expired");
		} finally {
			database.close();
		}
	});

	test("recoverOnStartup resets enabled Session Allow-all policies and is idempotent", () => {
		const { database, sessionId } = setup();
		try {
			const enabled = database.approvals.updatePolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			expect(enabled.policy.allowAll).toBe(true);
			expect(enabled.policy.revision).toBe(1);

			const first = database.approvals.recoverOnStartup();
			expect(first.policiesReset).toBe(1);

			const afterReset = database.approvals.getPolicy(sessionId);
			expect(afterReset.allowAll).toBe(false);
			expect(afterReset.revision).toBe(2);
			expect(afterReset.updatedBy?.kind).toBe("system");

			// A second recovery must not reset an already-disabled policy again.
			const second = database.approvals.recoverOnStartup();
			expect(second.policiesReset).toBe(0);
			expect(database.approvals.getPolicy(sessionId).revision).toBe(2);
		} finally {
			database.close();
		}
	});

	test("cancel moves a pending request to cancelled and is idempotent on terminal state", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const cancelled = database.approvals.cancel(pending.id, { kind: "system" });
			expect(cancelled.state).toBe("cancelled");
			const again = database.approvals.cancel(pending.id, { kind: "system" });
			expect(again.state).toBe("cancelled");
			expect(again.revision).toBe(cancelled.revision);
		} finally {
			database.close();
		}
	});

	test("session policy defaults to allowAll=false at revision 0 and updates via CAS", () => {
		const { database, sessionId } = setup();
		try {
			const initial = database.approvals.getPolicy(sessionId);
			expect(initial.allowAll).toBe(false);
			expect(initial.revision).toBe(0);

			const updated = database.approvals.updatePolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			expect(updated.outcome).toBe("applied");
			expect(updated.policy.allowAll).toBe(true);
			expect(updated.policy.revision).toBe(1);

			expect(() =>
				database.approvals.updatePolicy({
					sessionId,
					allowAll: false,
					expectedRevision: 0,
					idempotencyKey: crypto.randomUUID(),
					updatedBy: clientSource,
				}),
			).toThrow(/revision conflict/i);
		} finally {
			database.close();
		}
	});

	test("enables Allow all and approves the current request atomically", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			const idempotencyKey = crypto.randomUUID();
			const input = {
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey,
				updatedBy: clientSource,
				approveRequest: {
					approvalId: pending.id,
					expectedRevision: pending.revision,
				},
			};
			const updated = database.approvals.updatePolicy(input);

			expect(updated.outcome).toBe("applied");
			expect(updated.policy).toMatchObject({ allowAll: true, revision: 1 });
			expect(updated.requestOutcome).toBe("applied");
			expect(updated.request).toMatchObject({
				id: pending.id,
				state: "approved",
				revision: 2,
				policyEvidence: { allowAllRevision: 1 },
			});
			expect(updated.request?.decision?.source.kind).toBe("policy");
			expect(database.approvals.getPolicy(sessionId).allowAll).toBe(true);
			expect(database.approvals.getOrThrow(pending.id).state).toBe("approved");

			const retry = database.approvals.updatePolicy(input);
			expect(retry.outcome).toBe("idempotent");
			expect(retry.requestOutcome).toBe("idempotent");
			expect(retry.request?.state).toBe("approved");
		} finally {
			database.close();
		}
	});

	test("rolls back Allow all when the current approval revision is stale", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			expect(() =>
				database.approvals.updatePolicy({
					sessionId,
					allowAll: true,
					expectedRevision: 0,
					idempotencyKey: crypto.randomUUID(),
					updatedBy: clientSource,
					approveRequest: {
						approvalId: pending.id,
						expectedRevision: pending.revision + 1,
					},
				}),
			).toThrow(/revision conflict/i);
			expect(database.approvals.getPolicy(sessionId)).toMatchObject({
				allowAll: false,
				revision: 0,
			});
			expect(database.approvals.getOrThrow(pending.id).state).toBe("pending");
		} finally {
			database.close();
		}
	});

	test("never enables Allow all through a non-overridable current request", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId, criticalRisk);
			expect(() =>
				database.approvals.updatePolicy({
					sessionId,
					allowAll: true,
					expectedRevision: 0,
					idempotencyKey: crypto.randomUUID(),
					updatedBy: clientSource,
					approveRequest: {
						approvalId: pending.id,
						expectedRevision: pending.revision,
					},
				}),
			).toThrow("Allow all cannot approve this request.");
			expect(database.approvals.getPolicy(sessionId).allowAll).toBe(false);
			expect(database.approvals.getOrThrow(pending.id).state).toBe("pending");
		} finally {
			database.close();
		}
	});

	test("session policy update is idempotent for the same idempotency key", () => {
		const { database, sessionId } = setup();
		try {
			const key = crypto.randomUUID();
			const first = database.approvals.updatePolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: key,
				updatedBy: clientSource,
			});
			const retry = database.approvals.updatePolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: key,
				updatedBy: clientSource,
			});
			expect(first.outcome).toBe("applied");
			expect(retry.outcome).toBe("idempotent");
			expect(retry.policy.revision).toBe(1);
		} finally {
			database.close();
		}
	});

	test("resetForSession cancels pending requests and clears the allow-all policy", () => {
		const { database, sessionId, runId } = setup();
		try {
			const pending = createPending(database, sessionId, runId);
			database.approvals.updatePolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			database.approvals.resetForSession(sessionId);
			expect(database.approvals.getOrThrow(pending.id).state).toBe("cancelled");
			expect(database.approvals.getPolicy(sessionId).allowAll).toBe(false);
			expect(database.approvals.getPolicy(sessionId).revision).toBe(0);
		} finally {
			database.close();
		}
	});

	test("list returns newest-first items filtered by session and state with policies", () => {
		const { database, sessionId, runId } = setup();
		try {
			const first = createPending(database, sessionId, runId);
			const second = createPending(database, sessionId, runId);
			database.approvals.decide({
				approvalId: first.id,
				expectedRevision: first.revision,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			const pendingOnly = database.approvals.list({ sessionId, states: ["pending"] });
			expect(pendingOnly.items.map((item) => item.id)).toEqual([second.id]);
			expect(pendingOnly.policies).toHaveLength(1);
			expect(pendingOnly.policies[0]?.sessionId).toBe(sessionId);
		} finally {
			database.close();
		}
	});

	test("unscoped list only returns policies for sessions present in the item page", () => {
		const { database, sessionId: sessionA, runId: runA } = setup();
		try {
			// Session B has a policy but no pending approval, so it must not appear
			// in an unscoped listing's policy set (which is bounded to item sessions).
			const sessionB = database.sessions.create({ title: "Policy-only session" }).session;
			database.approvals.updatePolicy({
				sessionId: sessionB.id,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			database.approvals.updatePolicy({
				sessionId: sessionA,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			createPending(database, sessionA, runA);

			const listed = database.approvals.list({ states: ["pending"] });
			const listedSessions = new Set(listed.policies.map((policy) => policy.sessionId));
			expect(listedSessions.has(sessionA)).toBe(true);
			expect(listedSessions.has(sessionB.id)).toBe(false);
			expect(listed.policies.length).toBeLessThanOrEqual(listed.items.length);
		} finally {
			database.close();
		}
	});
});
