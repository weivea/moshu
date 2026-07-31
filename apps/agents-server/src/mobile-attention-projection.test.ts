import { describe, expect, test } from "bun:test";

import {
	projectApprovalAttention,
	projectRunTerminalAttention,
} from "./mobile-attention-projection";

const baseRunEvent = {
	schemaVersion: 1 as const,
	id: "019fb74d-0000-7000-8000-000000000010",
	runId: "019fb74d-0000-7000-8000-000000000011",
	sessionId: "019fb74d-0000-7000-8000-000000000012",
	seq: 1,
	source: { kind: "system" as const },
	visibility: "user" as const,
	createdAt: "2024-01-01T00:00:00.000Z",
};

const baseApproval = {
	schemaVersion: 1 as const,
	id: "6f1a0000-0000-4000-8000-000000000001",
	sessionId: "019fb74d-0000-7000-8000-000000000012",
	runId: "019fb74d-0000-7000-8000-000000000011",
	actionId: "6f1a0000-0000-4000-8000-000000000002",
	toolCallId: "call-1",
	action: { kind: "tool", toolName: "read" },
	risk: "low",
	state: "pending" as const,
	revision: 1,
	createdAt: "2024-01-01T00:00:00.000Z",
	expiresAt: "2024-01-01T00:05:00.000Z",
};

describe("mobile attention projection", () => {
	test("maps a pending approval to a desensitized append carrying only opaque ids", () => {
		const append = projectApprovalAttention({
			type: "approval.created",
			// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
			request: baseApproval as any,
		});
		expect(append).toEqual({
			type: "approval_required",
			dedupeKey: `approval:${baseApproval.id}`,
			sessionId: baseApproval.sessionId,
			runId: baseApproval.runId,
			approvalId: baseApproval.id,
			titleKey: "attention.approvalRequired.title",
			bodyKey: "attention.approvalRequired.body",
		});
	});

	test("ignores approvals that are not newly pending", () => {
		expect(
			projectApprovalAttention({
				type: "approval.updated",
				// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
				request: { ...baseApproval, state: "approved" } as any,
			}),
		).toBeUndefined();
		expect(
			projectApprovalAttention({
				type: "approval.created",
				// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
				request: { ...baseApproval, state: "approved" } as any,
			}),
		).toBeUndefined();
	});

	test("maps each terminal Run status to its attention type, deduped by Run id", () => {
		for (const [status, type] of [
			["completed", "run_completed"],
			["failed", "run_failed"],
			["cancelled", "run_cancelled"],
		] as const) {
			const append = projectRunTerminalAttention({
				...baseRunEvent,
				type: "run.status",
				payload: { status },
				// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
			} as any);
			expect(append).toMatchObject({
				type,
				dedupeKey: `run:${baseRunEvent.runId}`,
				runId: baseRunEvent.runId,
				sessionId: baseRunEvent.sessionId,
			});
		}
	});

	test("ignores non-terminal Run statuses and non-status events", () => {
		expect(
			projectRunTerminalAttention({
				...baseRunEvent,
				type: "run.status",
				payload: { status: "running" },
				// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
			} as any),
		).toBeUndefined();
		expect(
			projectRunTerminalAttention({
				...baseRunEvent,
				type: "message.started",
				payload: { messageId: baseRunEvent.id, role: "assistant" },
				// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the projection under test
			} as any),
		).toBeUndefined();
	});
});
