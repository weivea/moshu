import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createExecutorToolParameterPayload,
	type ExecutorToolInvokeInput,
	reconcileRuntimeBoxInvocationsInputSchema,
} from "@moshu/contracts";
import { rpcJsonValueSchema } from "@moshu/process-rpc";
import {
	InvocationGrantRejectedError,
	RuntimeBoxInvocationJournal,
	watchInvocationReconciliation,
} from "./invocation-journal";

const authority = {
	role: "agents" as const,
	peerId: "agents",
	instanceId: "agents-instance",
	generation: 4,
};
const target = {
	role: "runtime-box" as const,
	peerId: "runtime-box",
	instanceId: "runtime-instance",
	generation: 8,
};

describe("RuntimeBoxInvocationJournal", () => {
	test("persists before execution, reconciles success, and prunes only after ack", () => {
		const root = mkdtempSync(join(tmpdir(), "moshu-invocations-"));
		try {
			const journal = new RuntimeBoxInvocationJournal(root);
			const input = createAuthorizedInput();
			expect(journal.begin(input, authority, target)).toEqual({});
			const result = {
				schemaVersion: 1 as const,
				invocationId: input.invocationId,
				tool: "read" as const,
				content: [{ type: "text" as const, text: "contents" }],
			};
			journal.succeed(input.invocationId, result);
			expect(statSync(join(root, "invocations.json")).mode & 0o777).toBe(0o600);

			const reopened = new RuntimeBoxInvocationJournal(root);
			expect(reopened.listEvidence()).toMatchObject([
				{
					invocationId: input.invocationId,
					actionId: input.authorization?.actionId,
					state: "succeeded",
					result,
				},
			]);
			expect(reopened.acknowledge([input.invocationId])).toEqual([input.invocationId]);
			expect(reopened.listEvidence()).toEqual([]);
			expect(() => reopened.begin(input, authority, target)).toThrow("acknowledged and consumed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects tampering and converts interrupted work to outcome_unknown", () => {
		const root = mkdtempSync(join(tmpdir(), "moshu-invocations-"));
		try {
			const journal = new RuntimeBoxInvocationJournal(root);
			const input = createAuthorizedInput();
			expect(() =>
				journal.begin(input, authority, { ...target, generation: target.generation + 1 }),
			).toThrow("target did not match");
			expect(() =>
				journal.begin(
					{
						...input,
						call: { tool: "read", arguments: { path: "other.txt" } },
					},
					authority,
					target,
				),
			).toThrow(InvocationGrantRejectedError);
			journal.begin(input, authority, target);

			const reopened = new RuntimeBoxInvocationJournal(root);
			expect(reopened.listEvidence()).toMatchObject([
				{
					invocationId: input.invocationId,
					state: "outcome_unknown",
					safeError: expect.stringContaining("restarted"),
				},
			]);
			expect(() => reopened.begin(input, authority, target)).toThrow("cannot replay");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reconciles evidence that becomes terminal after connection", async () => {
		const root = mkdtempSync(join(tmpdir(), "moshu-invocations-"));
		const controller = new AbortController();
		try {
			const journal = new RuntimeBoxInvocationJournal(root);
			const input = createAuthorizedInput();
			journal.begin(input, authority, target);
			const observation = watchInvocationReconciliation(
				{
					async request(_method, payload) {
						const parsed = reconcileRuntimeBoxInvocationsInputSchema.parse(payload);
						return rpcJsonValueSchema.parse({
							ackedInvocationIds: parsed.items.map((item) => item.invocationId),
							confirmedAcknowledgementIds: parsed.acknowledgedInvocationIds,
						});
					},
				},
				journal,
				controller.signal,
				{ intervalMs: 5 },
			);
			journal.succeed(input.invocationId, {
				schemaVersion: 1,
				invocationId: input.invocationId,
				tool: "read",
				content: [{ type: "text", text: "late" }],
			});
			const deadline = Date.now() + 250;
			while (journal.listEvidence().length > 0 && Date.now() < deadline) {
				await Bun.sleep(5);
			}
			expect(journal.listEvidence()).toEqual([]);
			controller.abort();
			await observation;
		} finally {
			controller.abort();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("retains an unconfirmed receipt after the execution grant expires", async () => {
		const root = mkdtempSync(join(tmpdir(), "moshu-invocations-"));
		try {
			const journal = new RuntimeBoxInvocationJournal(root);
			const input = createAuthorizedInput();
			if (input.authorization === undefined) {
				throw new Error("Expected authorization.");
			}
			input.authorization.expiresAt = new Date(Date.now() + 20).toISOString();
			journal.begin(input, authority, target);
			journal.succeed(input.invocationId, {
				schemaVersion: 1,
				invocationId: input.invocationId,
				tool: "read",
				content: [{ type: "text", text: "receipt" }],
			});
			journal.acknowledge([input.invocationId]);
			await Bun.sleep(30);
			const reopened = new RuntimeBoxInvocationJournal(root);
			expect(reopened.nextReconciliationBatch()).toMatchObject({
				items: [],
				acknowledgedInvocationIds: [input.invocationId],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function createAuthorizedInput(): ExecutorToolInvokeInput {
	const parameters = {
		schemaVersion: 1 as const,
		invocationId: crypto.randomUUID(),
		runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
		toolCallId: "tool-call",
		cwd: "/workspace",
		call: { tool: "read" as const, arguments: { path: "README.md" } },
	};
	return {
		...parameters,
		authorization: {
			actionId: crypto.randomUUID(),
			grantId: crypto.randomUUID(),
			grantToken: Buffer.alloc(32, 7).toString("base64url"),
			parameterDigest: createHash("sha256")
				.update(createExecutorToolParameterPayload(parameters))
				.digest("hex"),
			originInstanceId: authority.instanceId,
			originGeneration: authority.generation,
			targetRuntimeBoxId: target.peerId,
			targetInstanceId: target.instanceId,
			targetGeneration: target.generation,
			executionScope: "request-cwd",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
	};
}
