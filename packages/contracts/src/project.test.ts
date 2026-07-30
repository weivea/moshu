import { describe, expect, test } from "bun:test";
import { chatRunEventSchema } from "./chat";
import { maxProjectRootAgentsBytes, readRuntimeBoxProjectRootAgentsOutputSchema } from "./project";

describe("Project Run contracts", () => {
	test("strictly bounds root AGENTS.md RPC bodies by UTF-8 bytes", () => {
		expect(
			readRuntimeBoxProjectRootAgentsOutputSchema.parse({
				status: "loaded",
				body: "a".repeat(maxProjectRootAgentsBytes),
			}),
		).toBeDefined();
		expect(() =>
			readRuntimeBoxProjectRootAgentsOutputSchema.parse({
				status: "loaded",
				body: "é".repeat(maxProjectRootAgentsBytes),
			}),
		).toThrow();
		expect(() =>
			readRuntimeBoxProjectRootAgentsOutputSchema.parse({
				status: "warning",
				issueCode: "invalid_utf8",
				privateError: "host path",
			}),
		).toThrow();
	});

	test("keeps Project root warnings bounded and body-free", () => {
		const event = chatRunEventSchema.parse({
			schemaVersion: 1,
			id: "01984df0-cf1c-793f-bc2c-df399f25cd1d",
			runId: "01984df0-cf1c-793f-bc2c-df399f25cd1e",
			sessionId: "01984df0-cf1c-793f-bc2c-df399f25cd1f",
			seq: 3,
			type: "run.warning",
			source: { kind: "system" },
			visibility: "user",
			createdAt: "2026-07-30T00:00:00.000Z",
			payload: {
				code: "ROOT_AGENTS_SKIPPED",
				reason: "too_large",
			},
		});
		expect(event.type).toBe("run.warning");
		expect(JSON.stringify(event)).not.toContain("AGENTS body");
	});
});
