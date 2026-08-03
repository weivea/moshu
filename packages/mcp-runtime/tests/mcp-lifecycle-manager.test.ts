import type { McpToolDescriptor } from "@moshu/contracts";
import { describe, expect, it } from "bun:test";
import {
	McpDefinitiveResponseError,
	type McpConnection,
	McpToolOutcomeUnknownError,
} from "../src/mcp-client";
import {
	type McpConnectionConfig,
	McpLifecycleManager,
	type McpLifecycleStore,
} from "../src/mcp-lifecycle-manager";

describe("McpLifecycleManager Secret redaction", () => {
	it("redacts short Secrets from result keys, values, and preserved MCP errors", async () => {
		const descriptor: McpToolDescriptor = {
			stableToolId: "query",
			name: "query",
			schemaHash: "a".repeat(64),
			inputSchema: { type: "object" },
		};
		let health: McpConnectionConfig["server"]["health"] = "stopped";
		let tools: readonly McpToolDescriptor[] = [];
		const config = (): McpConnectionConfig => ({
			server: {
				stableResourceId: "server",
				configRevision: 1,
				version: "550e8400-e29b-41d4-a716-446655440010",
				contentHash: "b".repeat(64),
				enabled: true,
				health,
				transport: {
					type: "streamable-http",
					url: "https://example.com/mcp",
					timeoutMs: 1_000,
				},
				tools,
			},
			secret: { headers: { Authorization: "xy" } },
		});
		const store: McpLifecycleStore = {
			setMcpConfigChangedListener() {},
			listMcpServerIds: () => ["server"],
			getMcpConnectionConfig: config,
			updateMcpRuntimeState(_stableResourceId, nextHealth, nextTools) {
				health = nextHealth;
				tools = nextTools;
			},
		};
		let calls = 0;
		const connection: McpConnection = {
			tools: [descriptor],
			async callTool() {
				calls += 1;
				if (calls === 1) {
					return { xy: "prefix-xy-suffix" };
				}
				if (calls === 2) {
					throw new McpToolOutcomeUnknownError("connection lost for xy");
				}
				throw new McpDefinitiveResponseError("server rejected xy");
			},
			async close() {},
		};
		const manager = new McpLifecycleManager(store, {
			connect: async () => connection,
		});
		await manager.start();
		const expected = {
			version: config().server.version,
			contentHash: config().server.contentHash,
			schemaHash: descriptor.schemaHash,
		};

		const success = await manager.callTool("server", "query", {}, expected);
		expect(success).toEqual({ "[redacted]": "prefix-[redacted]-suffix" });

		const unknown = await manager
			.callTool("server", "query", {}, expected)
			.catch((error: unknown) => error);
		expect(unknown).toBeInstanceOf(McpToolOutcomeUnknownError);
		expect((unknown as Error).message).not.toContain("xy");

		const definitive = await manager
			.callTool("server", "query", {}, expected)
			.catch((error: unknown) => error);
		expect(definitive).toBeInstanceOf(McpDefinitiveResponseError);
		expect((definitive as Error).message).not.toContain("xy");
		await manager.shutdown();
	});
});
