import { describe, expect, test } from "bun:test";

import {
	agentGlobalProfileSchema,
	listMcpServersOutputSchema,
	listRuntimeBoxMcpServerSummariesOutputSchema,
	listSkillsOutputSchema,
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
				serverSkillRefs: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}),
		).toThrow();
	});

	test("keeps Agent Server and Runtime Box Skill ownership explicit", () => {
		const item = {
			owner: { kind: "agent-server" as const },
			stableResourceId: "release-helper",
			configRevision: 1,
			version: crypto.randomUUID(),
			contentHash: "a".repeat(64),
			metadata: {
				name: "release-helper",
				description: "Prepare releases",
				allowedTools: [],
				metadata: {},
			},
			enabled: true,
			health: "ready" as const,
			packageKind: "prompt-only" as const,
			sourceKind: "inline-editor" as const,
			stale: false,
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		expect(
			listSkillsOutputSchema.parse({
				owner: { kind: "agent-server" },
				items: [item],
			}),
		).toEqual({ owner: { kind: "agent-server" }, items: [item] });
		expect(() =>
			listSkillsOutputSchema.parse({
				owner: { kind: "runtime-box", runtimeBoxId: "runtime-box" },
				items: [item],
			}),
		).toThrow("owner");
	});
});
