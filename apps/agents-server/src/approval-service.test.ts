import { describe, expect, test } from "bun:test";
import {
	approvalEventDeliverySchema,
	defaultLocalRuntimeBoxId,
	getApprovalOutputSchema,
	listApprovalsOutputSchema,
} from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "@moshu/database";
import { DurableActionAuthorizationService } from "./action-authorization-service";
import {
	ActionApprovalRejectedError,
	ApprovalService,
	type ApprovalServiceEvent,
} from "./approval-service";

function makeProviderInput() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "Provider",
		source: "custom" as const,
		api: "openai-responses",
		model: "model",
		thinkingLevel: "medium" as const,
	};
}

type TestDatabase = ReturnType<typeof openAppDatabase>;

function appendToolPart(
	database: TestDatabase,
	runId: string,
	toolCallId: string,
	tool: "bash" | "edit" | "read",
): void {
	const now = new Date().toISOString();
	database.runs.appendEvent({
		runId,
		type: "timeline.part.created",
		source: { kind: "assistant" },
		payload: {
			part: {
				schemaVersion: 1,
				id: createUuidV7(),
				runId,
				position: database.runs.listParts(runId).length + 1,
				assistantTurnId: createUuidV7(),
				revision: 1,
				createdAt: now,
				updatedAt: now,
				kind: "tool",
				toolCallId,
				tool: { kind: "builtin", name: tool },
				status: "queued",
				summary: `${tool} invocation`,
			},
		},
	});
}

function setup() {
	const database = openAppDatabase(":memory:");
	const session = database.sessions.create({ title: "Approval" }).session;
	const run = database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId: session.id,
		mode: "agent",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "run",
	}).run;
	const service = new ApprovalService(database.approvals, database.runs);
	return { database, sessionId: session.id, runId: run.id, service };
}

const clientSource = { kind: "client" as const, clientId: "peer-a", clientRole: "client" };
const otherSource = { kind: "client" as const, clientId: "peer-b", clientRole: "client" };

function bashInvocation(database: TestDatabase, runId: string, command: string) {
	const invocation = {
		schemaVersion: 1 as const,
		invocationId: crypto.randomUUID(),
		runId,
		toolCallId: `call-${crypto.randomUUID()}`,
		cwd: "/workspace",
		call: { tool: "bash" as const, arguments: { command } },
	};
	appendToolPart(database, runId, invocation.toolCallId, invocation.call.tool);
	return invocation;
}

function editInvocation(
	database: TestDatabase,
	runId: string,
	path: string,
	toolCallId = `call-${crypto.randomUUID()}`,
) {
	const invocation = {
		schemaVersion: 1 as const,
		invocationId: crypto.randomUUID(),
		runId,
		toolCallId,
		cwd: "/workspace",
		call: {
			tool: "edit" as const,
			arguments: { path, edits: [{ oldText: "a", newText: "b" }] },
		},
	};
	appendToolPart(database, runId, invocation.toolCallId, invocation.call.tool);
	return invocation;
}

const runtimeTarget = {
	role: "runtime-box" as const,
	peerId: defaultLocalRuntimeBoxId,
	instanceId: "runtime-instance",
	generation: 1,
};

const authority = {
	role: "agents" as const,
	peerId: "agents",
	instanceId: "agents-instance",
	generation: 1,
};

describe("ApprovalService gate integration", () => {
	test("does not dispatch (create a grant) until the Action is approved", async () => {
		const { database, runId, service } = setup();
		try {
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = bashInvocation(database, runId, "echo hi");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			// Give the microtask queue a chance; the grant must not exist yet.
			await Promise.resolve();
			await Promise.resolve();
			expect(() => database.actions.get(invocation.invocationId)).toThrow();
			const pending = service.listApprovals({ states: ["pending"] });
			expect(pending.items).toHaveLength(1);

			const approvalId = pending.items[0]?.id ?? "";
			const decision = service.decideApproval({
				approvalId,
				expectedRevision: 1,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			expect(decision.outcome).toBe("applied");
			const authorized = await authorizePromise;
			expect(authorized.authorization).toBeDefined();
			// The grant exists and was consumed exactly once, only after approval.
			expect(database.actions.get(invocation.invocationId)).toMatchObject({ state: "running" });
		} finally {
			database.close();
		}
	});

	test("reject makes authorize throw and never creates a grant", async () => {
		const { database, runId, service } = setup();
		try {
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = bashInvocation(database, runId, "echo hi");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const pending = service.listApprovals({ states: ["pending"] });
			const approvalId = pending.items[0]?.id ?? "";
			service.decideApproval({
				approvalId,
				expectedRevision: 1,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			await expect(authorizePromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
			expect(() => database.actions.get(invocation.invocationId)).toThrow();
		} finally {
			database.close();
		}
	});

	test("read-only Tools are auto-allowed without an approval request", async () => {
		const { database, runId, service } = setup();
		try {
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId,
				toolCallId: "call-read",
				cwd: "/workspace",
				call: { tool: "read" as const, arguments: { path: "README.md" } },
			};
			appendToolPart(database, runId, invocation.toolCallId, invocation.call.tool);
			const authorized = await authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			expect(authorized.authorization).toBeDefined();
			expect(service.listApprovals({}).items).toHaveLength(0);
		} finally {
			database.close();
		}
	});

	test("two clients race a decision; only one grant is issued and the loser is superseded", async () => {
		const { database, runId, service } = setup();
		try {
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = bashInvocation(database, runId, "echo race");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const approvalId = service.listApprovals({ states: ["pending"] }).items[0]?.id ?? "";
			const winner = service.decideApproval({
				approvalId,
				expectedRevision: 1,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			const loser = service.decideApproval({
				approvalId,
				expectedRevision: 1,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: otherSource,
			});
			expect(winner.outcome).toBe("applied");
			expect(loser.outcome).toBe("superseded");
			expect(loser.request.state).toBe("approved");
			await authorizePromise;
			expect(database.actions.get(invocation.invocationId)).toMatchObject({ state: "running" });
		} finally {
			database.close();
		}
	});

	test("Session Allow all auto-approves overridable Actions but never critical ones", async () => {
		const { database, runId, sessionId, service } = setup();
		try {
			service.updateSessionPolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			// Overridable edit (medium, overridable) is auto-approved without waiting.
			// A shell Action can never be overridable, so `edit` is used here.
			const ok = editInvocation(database, runId, "/workspace/app.ts");
			const authorized = await authorizer.authorize(defaultLocalRuntimeBoxId, ok, runtimeTarget, {
				executionScope: "request-cwd",
			});
			expect(authorized.authorization).toBeDefined();
			const autoRecord = service.listApprovals({ states: ["approved"] }).items[0];
			expect(autoRecord?.decision?.source.kind).toBe("policy");
			expect(autoRecord?.policyEvidence?.allowAllRevision).toBe(1);

			// Critical, non-overridable bash still blocks despite Allow all.
			const dangerous = bashInvocation(database, runId, "sudo rm -rf /");
			const pendingPromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				dangerous,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const criticalPending = service
				.listApprovals({ states: ["pending"] })
				.items.find((item) => item.risk.tier === "critical");
			expect(criticalPending).toBeDefined();
			expect(criticalPending?.risk.overridable).toBe(false);
			// Clean up the dangling waiter by rejecting it.
			service.decideApproval({
				approvalId: criticalPending?.id ?? "",
				expectedRevision: 1,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			await expect(pendingPromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
		} finally {
			database.close();
		}
	});

	test("Allow all approves the waiting Action in the same durable operation", async () => {
		const { database, runId, sessionId, service } = setup();
		try {
			const events: ApprovalServiceEvent[] = [];
			service.subscribe((event) => events.push(event));
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = editInvocation(database, runId, "README.md");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const pending = service.listApprovals({ states: ["pending"] }).items[0];
			if (pending === undefined) {
				throw new Error("Expected a pending approval.");
			}

			const output = service.updateSessionPolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
				approveRequest: {
					approvalId: pending.id,
					expectedRevision: pending.revision,
				},
			});

			expect(output.policy).toMatchObject({ allowAll: true, revision: 1 });
			expect(output.request).toMatchObject({
				id: pending.id,
				state: "approved",
				revision: 2,
				policyEvidence: { allowAllRevision: 1 },
			});
			await authorizePromise;
			expect(database.actions.get(invocation.invocationId).state).toBe("running");
			expect(events.map((event) => event.type)).toEqual([
				"approval.created",
				"approval.updated",
				"sessionApprovalPolicy.changed",
			]);
		} finally {
			database.close();
		}
	});

	test("aborting the run signal cancels a pending approval and rejects the waiter", async () => {
		const { database, runId, service } = setup();
		try {
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const controller = new AbortController();
			const invocation = bashInvocation(database, runId, "echo hi");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
				{ signal: controller.signal },
			);
			await Promise.resolve();
			controller.abort();
			await expect(authorizePromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
			expect(service.listApprovals({ states: ["cancelled"] }).items).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	test("emits created/updated/policyChanged events for subscribers", async () => {
		const { database, runId, sessionId, service } = setup();
		try {
			const events: ApprovalServiceEvent[] = [];
			service.subscribe((event) => events.push(event));
			service.updateSessionPolicy({
				sessionId,
				allowAll: false,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const invocation = bashInvocation(database, runId, "echo hi");
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const approvalId = service.listApprovals({ states: ["pending"] }).items[0]?.id ?? "";
			service.decideApproval({
				approvalId,
				expectedRevision: 1,
				decision: "approve_once",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			await authorizePromise;
			expect(events.map((event) => event.type)).toEqual([
				"sessionApprovalPolicy.changed",
				"approval.created",
				"approval.updated",
			]);
		} finally {
			database.close();
		}
	});

	test("publishes provider-sized Tool call IDs through every approval wire surface", async () => {
		const { database, runId, service } = setup();
		try {
			const events: ApprovalServiceEvent[] = [];
			service.subscribe((event) => events.push(event));
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			const toolCallId = `call_${"x".repeat(437)}`;
			const invocation = editInvocation(database, runId, "README.md", toolCallId);
			const authorizePromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			const listed = listApprovalsOutputSchema.parse(
				service.listApprovals({ states: ["pending"] }),
			);
			const request = listed.items[0];
			expect(request?.toolCallId).toBe(toolCallId);
			expect(
				approvalEventDeliverySchema.parse({
					schemaVersion: 1,
					kind: "created",
					request: events.find((event) => event.type === "approval.created")?.request,
				}).request.toolCallId,
			).toBe(toolCallId);
			expect(
				getApprovalOutputSchema.parse({
					schemaVersion: 1,
					...service.getApproval(request?.id ?? ""),
				}).request.toolCallId,
			).toBe(toolCallId);

			service.decideApproval({
				approvalId: request?.id ?? "",
				expectedRevision: request?.revision ?? 0,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			await expect(authorizePromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
		} finally {
			database.close();
		}
	});

	test("restart recovery expires lingering pending approvals", async () => {
		const { database, runId, service } = setup();
		try {
			// A durable pending request survives a process restart (no in-memory waiter).
			const now = Date.now();
			appendToolPart(database, runId, "call-restart", "bash");
			database.approvals.create({
				id: createUuidV7(now),
				sessionId: database.runs.get(runId).sessionId,
				runId,
				actionId: crypto.randomUUID(),
				toolCallId: "call-restart",
				action: {
					tool: "bash",
					operation: "bash",
					target: { kind: "runtime-box", id: defaultLocalRuntimeBoxId },
					command: "echo hi",
					redactedParams: {},
				},
				risk: { tier: "high", overridable: true, reasons: ["bash"] },
				createdAtMs: now,
				expiresAtMs: now + 600_000,
			});
			void service;
			const restarted = new ApprovalService(database.approvals, database.runs);
			const result = restarted.recoverOnStartup();
			expect(result.expired).toBe(1);
			expect(restarted.listApprovals({ states: ["expired"] }).items).toHaveLength(1);
			expect(restarted.listApprovals({ states: ["pending"] }).items).toHaveLength(0);
		} finally {
			database.close();
		}
	});

	test("the expiry sweep settles a waiting Action with a rejection", async () => {
		const { database, runId } = setup();
		try {
			const service = new ApprovalService(database.approvals, database.runs, {
				approvalLifetimeMs: 5,
			});
			appendToolPart(database, runId, "call-expire", "bash");
			const waitPromise = service.requireApproval({
				runId,
				invocationId: crypto.randomUUID(),
				toolCallId: "call-expire",
				actionId: crypto.randomUUID(),
				action: {
					tool: "bash",
					operation: "bash",
					target: { kind: "runtime-box", id: defaultLocalRuntimeBoxId },
					command: "echo hi",
					redactedParams: {},
				},
				risk: { tier: "high", overridable: true, reasons: ["bash"] },
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			const swept = service.sweepExpired();
			expect(swept).toBe(1);
			await expect(waitPromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
		} finally {
			database.close();
		}
	});

	test("Session Allow all never auto-approves a shell Action even when non-dangerous", async () => {
		const { database, runId, sessionId, service } = setup();
		try {
			service.updateSessionPolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				authority,
				{ allowSideEffects: true, approvalGate: service },
			);
			// A perfectly benign shell command is still non-overridable, so Allow all
			// cannot silently run it — it must block on a real pending approval.
			const invocation = bashInvocation(database, runId, "echo hi");
			const pendingPromise = authorizer.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				runtimeTarget,
				{ executionScope: "request-cwd" },
			);
			await Promise.resolve();
			await Promise.resolve();
			expect(() => database.actions.get(invocation.invocationId)).toThrow();
			const pending = service.listApprovals({ states: ["pending"] }).items;
			expect(pending).toHaveLength(1);
			expect(pending[0]?.risk.overridable).toBe(false);
			expect(pending[0]?.decision).toBeUndefined();
			// Nothing was auto-approved by policy.
			expect(service.listApprovals({ states: ["approved"] }).items).toHaveLength(0);
			// Clean up the dangling waiter.
			service.decideApproval({
				approvalId: pending[0]?.id ?? "",
				expectedRevision: 1,
				decision: "reject",
				idempotencyKey: crypto.randomUUID(),
				source: clientSource,
			});
			await expect(pendingPromise).rejects.toBeInstanceOf(ActionApprovalRejectedError);
		} finally {
			database.close();
		}
	});

	test("restart recovery resets an enabled Session Allow-all policy and is idempotent", () => {
		const { database, sessionId, service } = setup();
		try {
			service.updateSessionPolicy({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				idempotencyKey: crypto.randomUUID(),
				updatedBy: clientSource,
			});
			expect(service.getSessionPolicy(sessionId).allowAll).toBe(true);

			const restarted = new ApprovalService(database.approvals, database.runs);
			const first = restarted.recoverOnStartup();
			expect(first.policiesReset).toBe(1);
			const policy = restarted.getSessionPolicy(sessionId);
			expect(policy.allowAll).toBe(false);
			expect(policy.revision).toBe(2);
			expect(policy.updatedBy?.kind).toBe("system");

			// Recovering again must not reset the already-disabled policy.
			const second = restarted.recoverOnStartup();
			expect(second.policiesReset).toBe(0);
			expect(restarted.getSessionPolicy(sessionId).revision).toBe(2);
		} finally {
			database.close();
		}
	});

	test("unscoped approvals.list stays within the output schema bound past 200 sessions", () => {
		const database = openAppDatabase(":memory:");
		try {
			const service = new ApprovalService(database.approvals, database.runs);
			const now = Date.now();
			// More sessions than both the item cap and the policy cap (200 each).
			for (let index = 0; index < 205; index += 1) {
				const session = database.sessions.create({ title: `Session ${index}` }).session;
				const run = database.runs.create({
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "agent",
					provider: makeProviderInput(),
					userMessageId: createUuidV7(),
					userContent: "run",
				}).run;
				service.updateSessionPolicy({
					sessionId: session.id,
					allowAll: true,
					expectedRevision: 0,
					idempotencyKey: crypto.randomUUID(),
					updatedBy: clientSource,
				});
				database.approvals.create({
					id: crypto.randomUUID(),
					sessionId: session.id,
					runId: run.id,
					actionId: crypto.randomUUID(),
					toolCallId: `call-${index}`,
					action: {
						tool: "bash",
						operation: "bash",
						target: { kind: "runtime-box", id: defaultLocalRuntimeBoxId },
						command: "echo hi",
						redactedParams: {},
					},
					risk: { tier: "high", overridable: false, reasons: ["bash"] },
					createdAtMs: now + index,
					expiresAtMs: now + 600_000,
				});
			}
			const output = service.listApprovals({ states: ["pending"] });
			expect(output.items.length).toBeLessThanOrEqual(200);
			expect(output.policies.length).toBeLessThanOrEqual(200);
			expect(output.policies.length).toBeLessThanOrEqual(output.items.length);
			// The full payload must satisfy the wire contract without throwing.
			expect(() => listApprovalsOutputSchema.parse(output)).not.toThrow();
		} finally {
			database.close();
		}
	});
});
