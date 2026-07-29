import { describe, expect, test } from "bun:test";

import {
	installRuntimeBoxSkillInputSchema,
	maxRuntimeBoxInventoryResources,
	maxRuntimeBoxSkillMarkdownBytes,
	mcpSecretInputSchema,
	listRuntimeBoxSkillsOutputSchema,
	runtimeBoxInventorySnapshotSchema,
	upsertRuntimeBoxMcpServerInputSchema,
} from "../src";

describe("Runtime Box resource contracts", () => {
	test("keeps all value-bearing MCP environment and header fields in the secret payload", () => {
		const base = {
			commandId: crypto.randomUUID(),
			displayName: "MCP",
			enabled: true,
		};
		expect(() =>
			upsertRuntimeBoxMcpServerInputSchema.parse({
				...base,
				transport: {
					type: "stdio",
					command: "/usr/bin/mcp",
					args: [],
					environment: { TOKEN: "leak" },
					startupTimeoutMs: 10_000,
				},
			}),
		).toThrow();
		expect(() =>
			upsertRuntimeBoxMcpServerInputSchema.parse({
				...base,
				transport: {
					type: "streamable-http",
					url: "https://user:password@example.test/mcp",
					headers: { Authorization: "leak" },
					timeoutMs: 10_000,
				},
			}),
		).toThrow();
		expect(
			upsertRuntimeBoxMcpServerInputSchema.parse({
				...base,
				transport: {
					type: "streamable-http",
					url: "https://example.test/mcp",
					headerNames: ["Authorization"],
					timeoutMs: 10_000,
				},
				secret: { headers: { Authorization: "Bearer private" } },
			}),
		).toMatchObject({
			transport: { headerNames: ["Authorization"] },
			secret: { headers: { Authorization: "Bearer private" } },
		});
	});

	test("aligns inventory count and Skill content limits with RPC retrieval", () => {
		const resource = {
			resourceKind: "skill" as const,
			stableResourceId: "skill",
			version: crypto.randomUUID(),
			contentHash: "a".repeat(64),
			health: "ready" as const,
		};
		expect(() =>
			runtimeBoxInventorySnapshotSchema.parse({
				runtimeBoxId: "runtime-box",
				runtimeBoxGeneration: 1,
				inventoryEpoch: crypto.randomUUID(),
				inventoryRevision: 1,
				generatedAt: new Date().toISOString(),
				capabilities: [],
				resources: Array.from({ length: maxRuntimeBoxInventoryResources + 1 }, (_value, index) => ({
					...resource,
					stableResourceId: `skill-${index}`,
				})),
			}),
		).toThrow();
		expect(() =>
			installRuntimeBoxSkillInputSchema.parse({
				commandId: crypto.randomUUID(),
				source: "test",
				enabled: true,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "x".repeat(maxRuntimeBoxSkillMarkdownBytes + 1),
						executable: false,
					},
				],
			}),
		).toThrow("SKILL.md");
		expect(() =>
			installRuntimeBoxSkillInputSchema.parse({
				commandId: crypto.randomUUID(),
				source: "test",
				enabled: true,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "---\nname: skill\ndescription: skill\n---\n",
						executable: false,
					},
					{
						path: "references/large.txt",
						encoding: "utf8",
						content: "é".repeat(600_000),
						executable: false,
					},
				],
			}),
		).toThrow("decoded byte");
		const metadata = Object.fromEntries(
			Array.from({ length: 64 }, (_value, index) => [`key-${index}`, "x".repeat(4_096)]),
		);
		expect(() =>
			listRuntimeBoxSkillsOutputSchema.parse({
				runtimeBoxId: "runtime-box",
				items: Array.from({ length: 16 }, (_value, index) => ({
					stableResourceId: `skill-${index}`,
					version: crypto.randomUUID(),
					contentHash: "a".repeat(64),
					metadata: {
						name: `skill-${index}`,
						description: "skill",
						allowedTools: [],
						metadata,
					},
					enabled: true,
					source: "test",
					installedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})),
			}),
		).toThrow("payload");
	});

	test("rejects a secret envelope that the file store could not read back", () => {
		const values = Object.fromEntries(
			Array.from({ length: 64 }, (_value, index) => [`SECRET_${index}`, "x".repeat(16_384)]),
		);
		const headers = Object.fromEntries(
			Array.from({ length: 64 }, (_value, index) => [`X-Secret-${index}`, "x".repeat(16_384)]),
		);
		expect(() =>
			mcpSecretInputSchema.parse({
				environment: values,
				headers,
			}),
		).toThrow("encoded byte");
	});
});
