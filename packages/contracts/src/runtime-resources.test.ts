import { describe, expect, test } from "bun:test";

import {
	agentGlobalProfileSchema,
	listMcpServersOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
} from "./runtime-resources";

describe("Runtime resource renderer projections", () => {
	test("rejects MCP transport configuration from the renderer summary", () => {
		const summary = {
			runtimeBoxId: "runtime-box",
			items: [
				{
					stableResourceId: "database-tools",
					configRevision: 1,
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

	test("keeps Agent Server and Runtime Box MCP ownership explicit", () => {
		const item = {
			owner: { kind: "agent-server" as const },
			stableResourceId: "database-tools",
			configRevision: 1,
			version: crypto.randomUUID(),
			contentHash: "a".repeat(64),
			displayName: "Database Tools",
			enabled: true,
			credentialConfigured: false,
			health: "ready" as const,
			tools: [],
			stale: false,
		};
		expect(
			listMcpServersOutputSchema.parse({
				owner: { kind: "agent-server" },
				items: [item],
			}),
		).toMatchObject({ items: [{ owner: { kind: "agent-server" } }] });
		expect(() =>
			listMcpServersOutputSchema.parse({
				owner: { kind: "runtime-box", runtimeBoxId: "remote-box" },
				items: [item],
			}),
		).toThrow("owner");
		expect(() =>
			agentGlobalProfileSchema.parse({
				agentId: "moshu.default",
				revision: 1,
				serverMcpRefs: [
					{
						owner: { kind: "runtime-box", runtimeBoxId: "remote-box" },
						stableResourceId: "database-tools",
						version: crypto.randomUUID(),
						contentHash: "a".repeat(64),
					},
				],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		).toThrow();
	});
});
