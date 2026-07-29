import { describe, expect, test } from "bun:test";

import { listRuntimeBoxMcpServerSummariesOutputSchema } from "./runtime-resources";

describe("Runtime resource renderer projections", () => {
	test("rejects MCP transport configuration from the renderer summary", () => {
		const summary = {
			runtimeBoxId: "runtime-box",
			items: [
				{
					stableResourceId: "database-tools",
					version: crypto.randomUUID(),
					contentHash: "a".repeat(64),
					displayName: "Database Tools",
					enabled: true,
					credentialConfigured: true,
					health: "ready" as const,
					tools: [],
				},
			],
		};
		expect(listRuntimeBoxMcpServerSummariesOutputSchema.parse(summary)).toEqual(summary);
		expect(() =>
			listRuntimeBoxMcpServerSummariesOutputSchema.parse({
				...summary,
				items: [
					{
						...summary.items[0],
						transport: {
							type: "streamable-http",
							url: "https://mcp.example.test/rpc?token=must-not-project",
							timeoutMs: 30_000,
						},
					},
				],
			}),
		).toThrow();
	});
});
