import { expect, test } from "bun:test";
import type { ChatRunToolPart } from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "../src";

test("projects Approval and Action authority through the transactional timeline outbox", () => {
	const database = openAppDatabase(":memory:");
	try {
		const session = database.sessions.create({ title: "Authority" }).session;
		const run = database.runs.create({
			clientRequestId: crypto.randomUUID(),
			sessionId: session.id,
			mode: "agent",
			provider: {
				schemaVersion: 1,
				providerId: createUuidV7(),
				name: "Test Provider",
				source: "custom",
				api: "openai-responses",
				model: "deterministic",
			},
			userMessageId: createUuidV7(),
			userContent: "Run tools.",
		}).run;
		database.runs.updateStatus({ runId: run.id, status: "running" });
		appendTool(database, createTool(run.id, 1, "approval-call"));
		appendTool(database, createTool(run.id, 2, "action-call"));

		const now = Date.now();
		const approval = database.approvals.create({
			id: createUuidV7(now),
			sessionId: session.id,
			runId: run.id,
			actionId: crypto.randomUUID(),
			toolCallId: "approval-call",
			action: {
				tool: "bash",
				operation: "bash",
				target: { kind: "runtime-box", id: "local" },
				redactedParams: {},
			},
			risk: { tier: "medium", overridable: true, reasons: ["side effect"] },
			createdAtMs: now,
			expiresAtMs: now + 60_000,
		});
		expect(tool(database, run.id, "approval-call").status).toBe("queued");
		expect(database.runTimelineOutbox.pendingCount()).toBe(1);
		expect(database.runs.drainTimelineOutbox()).toHaveLength(1);
		expect(tool(database, run.id, "approval-call")).toMatchObject({
			status: "waiting_approval",
			approvalId: approval.id,
		});

		database.approvals.decide({
			approvalId: approval.id,
			expectedRevision: approval.revision,
			decision: "reject",
			idempotencyKey: crypto.randomUUID(),
			source: { kind: "client", clientId: "test", clientRole: "client" },
			nowMs: now + 1,
		});
		expect(tool(database, run.id, "approval-call").status).toBe("waiting_approval");
		database.runs.drainTimelineOutbox();
		expect(tool(database, run.id, "approval-call").status).toBe("denied");

		const actionId = crypto.randomUUID();
		const grantId = crypto.randomUUID();
		const grantTokenHash = "a".repeat(64);
		const invocationId = crypto.randomUUID();
		database.actions.createGrant({
			actionId,
			grantId,
			grantTokenHash,
			invocationId,
			targetKind: "runtime-box",
			targetId: "local",
			runId: run.id,
			toolCallId: "action-call",
			tool: "read",
			parameterDigest: "b".repeat(64),
			riskClass: "read",
			sideEffectClass: "none",
			idempotencyClass: "idempotent",
			policyRule: "test",
			originInstanceId: crypto.randomUUID(),
			originGeneration: 1,
			targetInstanceId: crypto.randomUUID(),
			targetGeneration: 1,
			executionScope: "runtime-box-workspace",
			expiresAtMs: Date.now() + 60_000,
		});
		database.actions.consumeGrant(actionId, grantId, grantTokenHash);
		expect(database.runTimelineOutbox.pendingCount()).toBe(1);
		database.runs.drainTimelineOutbox();
		expect(tool(database, run.id, "action-call").status).toBe("running");

		database.actions.markOutcomeUnknown(invocationId, "Receipt unavailable.");
		database.runs.drainTimelineOutbox();
		expect(tool(database, run.id, "action-call")).toMatchObject({
			status: "outcome_unknown",
			error: { safeMessage: "Receipt unavailable." },
		});
		expect(database.runTimelineOutbox.pendingCount()).toBe(0);
	} finally {
		database.close();
	}
});

test("recovers a completed Action public output from the durable timeline outbox", () => {
	const database = openAppDatabase(":memory:");
	try {
		const session = database.sessions.create({ title: "Action output" }).session;
		const run = database.runs.create({
			clientRequestId: crypto.randomUUID(),
			sessionId: session.id,
			mode: "agent",
			provider: {
				schemaVersion: 1,
				providerId: createUuidV7(),
				name: "Test Provider",
				source: "custom",
				api: "openai-responses",
				model: "deterministic",
			},
			userMessageId: createUuidV7(),
			userContent: "Call MCP.",
		}).run;
		database.runs.updateStatus({ runId: run.id, status: "running" });
		const part = createTool(run.id, 1, "mcp-call");
		appendTool(database, {
			...part,
			tool: {
				kind: "mcp",
				name: "query",
				mcpServerId: "database",
				stableToolId: "query",
			},
		});
		const actionId = crypto.randomUUID();
		const grantId = crypto.randomUUID();
		const invocationId = crypto.randomUUID();
		const grantTokenHash = "c".repeat(64);
		database.actions.createGrant({
			actionId,
			grantId,
			grantTokenHash,
			invocationId,
			targetKind: "agent-server",
			targetId: "agents",
			runId: run.id,
			toolCallId: "mcp-call",
			tool: "mcp:database:query",
			parameterDigest: "d".repeat(64),
			riskClass: "critical",
			sideEffectClass: "external",
			idempotencyClass: "non_idempotent",
			policyRule: "test",
			originInstanceId: crypto.randomUUID(),
			originGeneration: 1,
			targetInstanceId: crypto.randomUUID(),
			targetGeneration: 1,
			executionScope: "agent-server-mcp",
			expiresAtMs: Date.now() + 60_000,
		});
		database.actions.consumeGrant(actionId, grantId, grantTokenHash);
		database.runs.drainTimelineOutbox();

		database.actions.completeLocal(
			"agents",
			invocationId,
			{
				schemaVersion: 1,
				invocationId,
				mcpServerId: "database",
				stableToolId: "query",
				result: { rows: 1 },
				isError: false,
			},
			{
				format: "json",
				value: { summary: "Returned one row." },
				truncated: false,
				redactionCount: 0,
			},
		);

		expect(database.actions.get(invocationId).state).toBe("succeeded");
		expect(tool(database, run.id, "mcp-call").status).toBe("running");
		expect(database.runTimelineOutbox.pendingCount()).toBe(1);
		database.runs.drainTimelineOutbox();
		expect(tool(database, run.id, "mcp-call")).toMatchObject({
			status: "completed",
			output: {
				format: "json",
				value: { summary: "Returned one row." },
				truncated: false,
				redactionCount: 0,
			},
		});
	} finally {
		database.close();
	}
});

function createTool(runId: string, position: number, toolCallId: string): ChatRunToolPart {
	const timestamp = new Date().toISOString();
	return {
		schemaVersion: 1,
		id: createUuidV7(),
		runId,
		position,
		assistantTurnId: createUuidV7(),
		revision: 1,
		kind: "tool",
		toolCallId,
		tool: { kind: "builtin", name: "read" },
		status: "queued",
		summary: "Read workspace",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function appendTool(database: ReturnType<typeof openAppDatabase>, part: ChatRunToolPart): void {
	database.runs.appendEvent({
		runId: part.runId,
		type: "timeline.part.created",
		source: { kind: "assistant" },
		payload: { part },
	});
}

function tool(
	database: ReturnType<typeof openAppDatabase>,
	runId: string,
	toolCallId: string,
): ChatRunToolPart {
	const part = database.runs
		.listParts(runId)
		.find((candidate) => candidate.kind === "tool" && candidate.toolCallId === toolCallId);
	if (part?.kind !== "tool") {
		throw new Error(`Tool ${toolCallId} was not found.`);
	}
	return part;
}
