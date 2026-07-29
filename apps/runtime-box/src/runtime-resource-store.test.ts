import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeResourceStore } from "./runtime-resource-store";

const runtimeBoxId = "runtime-box-test";

describe("RuntimeResourceStore", () => {
	test("persists redacted MCP inventory and keeps credentials outside SQLite", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-mcp-"));
		const hints: unknown[] = [];
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"), {
				onInventoryChanged: (hint) => hints.push(hint),
			});
			const commandId = crypto.randomUUID();
			const created = store.upsertMcpServer({
				commandId,
				stableResourceId: "database-tools",
				displayName: "Database Tools",
				enabled: true,
				transport: {
					type: "streamable-http",
					url: "https://mcp.example.test/rpc",
					timeoutMs: 30_000,
				},
				secret: {
					headers: { Authorization: "Bearer secret-value-never-project" },
				},
			});
			expect(created.inventoryRevision).toBe(1);
			expect(created.descriptor).toMatchObject({
				resourceKind: "mcp",
				credentialConfigured: true,
				mcpTools: [],
			});
			const replay = store.upsertMcpServer({
				commandId,
				stableResourceId: "database-tools",
				displayName: "Database Tools",
				enabled: true,
				transport: {
					type: "streamable-http",
					url: "https://mcp.example.test/rpc",
					timeoutMs: 30_000,
				},
				secret: {
					headers: { Authorization: "Bearer secret-value-never-project" },
				},
			});
			expect(replay).toEqual(created);
			expect(() =>
				store.upsertMcpServer({
					commandId,
					stableResourceId: "database-tools",
					displayName: "Changed",
					enabled: true,
					transport: {
						type: "streamable-http",
						url: "https://mcp.example.test/rpc",
						timeoutMs: 30_000,
					},
				}),
			).toThrow("different input");
			const listed = store.listMcpServers(runtimeBoxId);
			expect(listed.items).toHaveLength(1);
			expect(listed.items[0]?.transport).toMatchObject({
				type: "streamable-http",
				headerNames: ["Authorization"],
			});
			expect(JSON.stringify(listed)).not.toContain("secret-value-never-project");
			const snapshot = store.getInventorySnapshot({
				runtimeBoxId,
				runtimeBoxGeneration: 1,
				capabilities: ["inventory.v1"],
			});
			expect(snapshot.inventoryRevision).toBe(1);
			expect(JSON.stringify(snapshot)).not.toContain("mcp.example.test");
			expect(JSON.stringify(snapshot)).not.toContain("secret-value-never-project");
			const databaseBytes = readFileSync(join(directory, "resources", "runtime-box.db"));
			expect(databaseBytes.includes(Buffer.from("secret-value-never-project"))).toBe(false);
			const secretFiles = readdirSync(join(directory, "resources", "secrets"));
			expect(secretFiles).toHaveLength(1);
			expect(
				readFileSync(join(directory, "resources", "secrets", secretFiles[0] ?? ""), "utf8"),
			).toContain("secret-value-never-project");
			expect(hints).toEqual([
				{
					inventoryEpoch: created.inventoryEpoch,
					inventoryRevision: 1,
					categories: ["mcp", "mcp_tool_schema"],
				},
			]);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("toggles an MCP Server without round-tripping its transport through the caller", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-mcp-toggle-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			const created = store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "private-transport",
				displayName: "Private Transport",
				enabled: true,
				transport: {
					type: "streamable-http",
					url: "https://mcp.example.test/rpc?opaque=config",
					timeoutMs: 30_000,
				},
				secret: { headers: { Authorization: "secret-value-never-project" } },
			});
			const commandId = crypto.randomUUID();
			const toggled = store.setMcpServerEnabled({
				commandId,
				stableResourceId: created.stableResourceId,
				expectedVersion: created.version,
				enabled: false,
			});
			expect(toggled).toMatchObject({ deleted: false });
			expect(store.listMcpServers(runtimeBoxId).items[0]).toMatchObject({
				enabled: false,
				credentialConfigured: true,
				transport: {
					type: "streamable-http",
					url: "https://mcp.example.test/rpc?opaque=config",
					headerNames: ["Authorization"],
				},
			});
			expect(
				store.setMcpServerEnabled({
					commandId,
					stableResourceId: created.stableResourceId,
					expectedVersion: created.version,
					enabled: false,
				}),
			).toEqual(toggled);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("retains epoch and serves signed contiguous inventory pages across restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-pages-"));
		try {
			const root = join(directory, "resources");
			const store = new RuntimeResourceStore(root);
			let expectedVersion: string | undefined;
			for (let index = 0; index < 65; index += 1) {
				const result = store.upsertMcpServer({
					commandId: crypto.randomUUID(),
					stableResourceId: "paged-server",
					...(expectedVersion === undefined ? {} : { expectedVersion }),
					displayName: `Paged Server ${index}`,
					enabled: false,
					transport: {
						type: "stdio",
						command: "/usr/bin/printf",
						args: [String(index)],
						startupTimeoutMs: 10_000,
					},
				});
				expectedVersion = result.version;
			}
			const beforeRestart = store.getInventorySnapshot({
				runtimeBoxId,
				runtimeBoxGeneration: 1,
				capabilities: [],
			});
			const first = store.getInventoryChanges({
				inventoryEpoch: beforeRestart.inventoryEpoch,
				fromRevisionExclusive: 0,
			});
			expect(first.changes).toHaveLength(64);
			expect(first.nextCursor).toBeDefined();
			const second = store.getInventoryChanges({
				inventoryEpoch: beforeRestart.inventoryEpoch,
				fromRevisionExclusive: 0,
				cursor: first.nextCursor,
			});
			expect(second.changes.map((change) => change.revision)).toEqual([65]);
			expect(second.nextCursor).toBeUndefined();
			expect(() =>
				store.getInventoryChanges({
					inventoryEpoch: beforeRestart.inventoryEpoch,
					fromRevisionExclusive: 0,
					cursor: `${first.nextCursor}tampered`,
				}),
			).toThrow("cursor");
			store.close();

			const reopened = new RuntimeResourceStore(root);
			const afterRestart = reopened.getInventorySnapshot({
				runtimeBoxId,
				runtimeBoxGeneration: 2,
				capabilities: [],
			});
			expect(afterRestart.inventoryEpoch).toBe(beforeRestart.inventoryEpoch);
			expect(afterRestart.inventoryRevision).toBe(beforeRestart.inventoryRevision);
			reopened.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("retains or deletes MCP credentials according to the delete command", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-retained-secret-"));
		try {
			const root = join(directory, "resources");
			let store = new RuntimeResourceStore(root);
			const created = store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "retained-server",
				displayName: "Retained Server",
				enabled: false,
				transport: {
					type: "stdio",
					command: "/usr/bin/printf",
					args: [],
					startupTimeoutMs: 10_000,
				},
				secret: { environment: { TOKEN: "retained-secret" } },
			});
			store.deleteMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: created.stableResourceId,
				expectedVersion: created.version,
				deleteCredentials: false,
			});
			store.close();

			store = new RuntimeResourceStore(root);
			const restored = store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "retained-server",
				displayName: "Restored Server",
				enabled: false,
				transport: {
					type: "stdio",
					command: "/usr/bin/printf",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			expect(restored.descriptor).toMatchObject({ credentialConfigured: true });
			store.deleteMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: restored.stableResourceId,
				expectedVersion: restored.version,
				deleteCredentials: true,
			});
			expect(readdirSync(join(root, "secrets"))).toEqual([]);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("installs immutable Skills and detects content tampering during live validation", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-skill-"));
		try {
			const root = join(directory, "resources");
			const store = new RuntimeResourceStore(root);
			const installed = store.installSkill({
				commandId: crypto.randomUUID(),
				source: "local-upload",
				enabled: true,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						executable: false,
						content:
							"---\nname: release-helper\ndescription: Prepare a release safely\nallowed-tools: [read, bash]\nmetadata:\n  owner: moshu\n---\n\nFollow the release checklist.",
					},
					{
						path: "scripts/check.sh",
						encoding: "utf8",
						executable: true,
						content: "#!/bin/sh\nexit 0\n",
					},
				],
			});
			const ref = {
				runtimeBoxId,
				resourceKind: "skill" as const,
				stableResourceId: installed.stableResourceId,
				version: installed.version,
				contentHash: installed.contentHash,
			};
			expect(store.listSkills(runtimeBoxId).items[0]).toMatchObject({
				metadata: {
					name: "release-helper",
					description: "Prepare a release safely",
					allowedTools: ["read", "bash"],
					metadata: { owner: "moshu" },
				},
			});
			expect(store.validateResources(runtimeBoxId, { refs: [ref] })).toMatchObject({
				valid: true,
				issues: [],
			});
			expect(store.getSkillContent(runtimeBoxId, { ref }).skillMarkdown).toContain(
				"Follow the release checklist.",
			);

			const skillFile = join(
				root,
				"skills",
				createHash("sha256")
					.update(`moshu-skill-directory-v1:${installed.stableResourceId}`)
					.digest("hex"),
				installed.version,
				"SKILL.md",
			);
			writeFileSync(skillFile, "tampered", { mode: 0o600 });
			chmodSync(skillFile, 0o600);
			expect(store.validateResources(runtimeBoxId, { refs: [ref] })).toMatchObject({
				valid: false,
				issues: [{ code: "HASH_MISMATCH" }],
			});
			store.deleteSkill({
				commandId: crypto.randomUUID(),
				stableResourceId: installed.stableResourceId,
				expectedVersion: installed.version,
			});
			expect(
				existsSync(
					join(
						root,
						"skills",
						createHash("sha256")
							.update(`moshu-skill-directory-v1:${installed.stableResourceId}`)
							.digest("hex"),
					),
				),
			).toBe(false);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("isolates case-colliding Skill IDs in filesystem-safe directories", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-skill-collision-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			const install = (stableResourceId: string, name: string) =>
				store.installSkill({
					commandId: crypto.randomUUID(),
					stableResourceId,
					source: "test",
					enabled: true,
					files: [
						{
							path: "SKILL.md",
							encoding: "utf8",
							executable: false,
							content: `---\nname: ${name}\ndescription: ${name}\n---\n`,
						},
					],
				});
			const upper = install("Foo", "upper-skill");
			const lower = install("foo", "lower-skill");
			const lowerRef = {
				runtimeBoxId,
				resourceKind: "skill" as const,
				stableResourceId: lower.stableResourceId,
				version: lower.version,
				contentHash: lower.contentHash,
			};
			store.deleteSkill({
				commandId: crypto.randomUUID(),
				stableResourceId: upper.stableResourceId,
				expectedVersion: upper.version,
			});
			expect(store.validateResources(runtimeBoxId, { refs: [lowerRef] })).toMatchObject({
				valid: true,
			});
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects a Skill install before the live query would exceed its payload contract", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-resource-store-skill-capacity-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			const metadata = Array.from(
				{ length: 64 },
				(_value, index) => `  key-${index}: "${"x".repeat(4_096)}"`,
			).join("\n");
			let rejected = false;
			for (let index = 0; index < 20; index += 1) {
				try {
					store.installSkill({
						commandId: crypto.randomUUID(),
						stableResourceId: `capacity-${index}`,
						source: "test",
						enabled: true,
						files: [
							{
								path: "SKILL.md",
								encoding: "utf8",
								executable: false,
								content: `---\nname: capacity-${index}\ndescription: capacity\nmetadata:\n${metadata}\n---\n`,
							},
						],
					});
				} catch (error) {
					if (!(error instanceof Error)) {
						throw error;
					}
					expect(error.message).toContain("Skill query capacity");
					rejected = true;
					break;
				}
			}
			expect(rejected).toBe(true);
			expect(() => store.listSkills(runtimeBoxId)).not.toThrow();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
