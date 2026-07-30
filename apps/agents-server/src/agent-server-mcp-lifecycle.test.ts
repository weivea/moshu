import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "@moshu/database";
import { FileMcpSecretStore, McpLifecycleManager } from "@moshu/mcp-runtime";

describe("Agent Server MCP lifecycle", () => {
	test("owns and reconnects an enabled stdio MCP independently of Runtime Box state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-agent-server-mcp-"));
		const script = join(directory, "mcp-server.ts");
		writeFileSync(
			script,
			`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "server-owned-test", version: "1.0.0" }
    }}));
  } else if (request.method === "tools/list") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }]
    }}));
  } else if (request.method === "tools/call") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: "pong" }]
    }}));
  }
});
`,
			"utf8",
		);
		const secrets = new FileMcpSecretStore(join(directory, "secrets"));
		const database = openAppDatabase(join(directory, "product.db"), {
			agentServerMcpSecrets: secrets,
			prepareAgentServerMcpStdioCwd(stableResourceId) {
				return join(directory, stableResourceId);
			},
		});
		const manager = new McpLifecycleManager(database.agentServerMcps);
		try {
			const created = database.agentServerMcps.upsert({
				owner: { kind: "agent-server" },
				commandId: crypto.randomUUID(),
				displayName: "Server-owned test",
				enabled: true,
				transport: {
					type: "stdio",
					command: process.execPath,
					args: [script],
					cwd: directory,
					startupTimeoutMs: 10_000,
				},
			});
			await manager.start();
			const ready = database.agentServerMcps.list().items[0];
			expect(ready).toMatchObject({
				stableResourceId: created.stableResourceId,
				owner: { kind: "agent-server" },
				health: "ready",
				tools: [{ name: "ping" }],
			});
			if (ready === undefined) {
				throw new Error("Expected an Agent Server-owned MCP.");
			}
			const result = await manager.callTool(
				ready.stableResourceId,
				ready.tools[0]?.stableToolId ?? "",
				{},
				{
					version: ready.version,
					contentHash: ready.contentHash,
					schemaHash: ready.tools[0]?.schemaHash ?? "",
				},
			);
			expect(result).toEqual({ content: [{ type: "text", text: "pong" }] });
		} finally {
			await manager.shutdown();
			database.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
