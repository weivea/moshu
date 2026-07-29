import { describe, expect, test } from "bun:test";
import {
	actionRequestSchema,
	DefaultActionPolicy,
	getExecutorToolMetadata,
	toolMetadataSchema,
} from "../src";

describe("Action Broker contracts", () => {
	test("requires every tool to declare risk and idempotency metadata", () => {
		const metadata = toolMetadataSchema.parse({
			name: "project.file.patch",
			riskClass: "medium",
			sideEffectClass: "local_reversible",
			idempotencyClass: "detectable",
			requiredCapabilities: ["project.write"],
		});

		expect(metadata.idempotencyClass).toBe("detectable");
	});

	test("classifies built-in tools and retains an approval seam for side effects", () => {
		expect(getExecutorToolMetadata("read")).toMatchObject({
			sideEffectClass: "none",
			idempotencyClass: "read",
		});
		expect(getExecutorToolMetadata("bash")).toMatchObject({
			riskClass: "high",
			idempotencyClass: "non_idempotent",
		});
		expect(new DefaultActionPolicy(false).evaluateTool("bash").outcome).toBe("approval_required");
		expect(new DefaultActionPolicy(true).evaluateTool("bash")).toEqual({
			outcome: "allow",
			policyRule: "poc-explicit-side-effects",
		});
	});

	test("rejects requests without an idempotency key", () => {
		expect(() =>
			actionRequestSchema.parse({
				schemaVersion: 1,
				id: "action-1",
				runId: "run-1",
				sessionId: "session-1",
				toolCallId: "tool-1",
				actionType: "file.patch",
				args: {},
				idempotencyKey: "",
				requestedCapabilities: ["project.write"],
				agentContext: { agentVersionId: "agent-1" },
			}),
		).toThrow();
	});
});
