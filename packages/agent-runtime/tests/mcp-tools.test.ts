import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultLocalRuntimeBoxId, type McpOwner } from "@moshu/contracts";

import { createAgentMcpToolName, createMcpToolDefinitions } from "../src";

describe("MCP Tool definitions", () => {
	test("namespaces identical Tool IDs by owner and routes each call to its owner", async () => {
		const calls: McpOwner[] = [];
		const resources = [
			{
				owner: { kind: "agent-server" as const },
				stableResourceId: "database-tools",
				version: crypto.randomUUID(),
				contentHash: "a".repeat(64),
				tools: [
					{
						stableToolId: "tool-query",
						name: "query",
						schemaHash: "b".repeat(64),
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
			{
				owner: {
					kind: "runtime-box" as const,
					runtimeBoxId: defaultLocalRuntimeBoxId,
				},
				stableResourceId: "database-tools",
				version: crypto.randomUUID(),
				contentHash: "c".repeat(64),
				tools: [
					{
						stableToolId: "tool-query",
						name: "query",
						schemaHash: "d".repeat(64),
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
		];
		const definitions = createMcpToolDefinitions({
			resources,
			gateway: {
				async invokeMcp(owner, input) {
					calls.push(owner);
					return {
						schemaVersion: 1,
						invocationId: input.invocationId,
						mcpServerId: input.mcpServerId,
						stableToolId: input.stableToolId,
						result: { content: [{ type: "text", text: owner.kind }] },
						isError: false,
					};
				},
			},
			getRunId: () => "018f47a2-9bcd-7def-8abc-1234567890ab",
		});
		expect(definitions).toHaveLength(2);
		expect(definitions[0]?.name).not.toBe(definitions[1]?.name);
		const context = {} as ExtensionContext;
		await definitions[0]?.execute("server-call", {}, undefined, undefined, context);
		await definitions[1]?.execute("box-call", {}, undefined, undefined, context);
		expect(calls).toEqual([
			{ kind: "agent-server" },
			{ kind: "runtime-box", runtimeBoxId: defaultLocalRuntimeBoxId },
		]);
	});

	test("keeps provider-safe names within 63 characters and hashes the full owner identity", () => {
		const serverId = `server-${"a".repeat(120)}`;
		const stableToolId = `tool-${"b".repeat(120)}`;
		const agentServerName = createAgentMcpToolName(
			{ kind: "agent-server" },
			serverId,
			stableToolId,
		);
		const firstBoxName = createAgentMcpToolName(
			{ kind: "runtime-box", runtimeBoxId: "runtime-box-a" },
			serverId,
			stableToolId,
		);
		const secondBoxName = createAgentMcpToolName(
			{ kind: "runtime-box", runtimeBoxId: "runtime-box-b" },
			serverId,
			stableToolId,
		);

		expect(agentServerName).toHaveLength(63);
		expect(agentServerName).toMatch(/^mcp_[a-z0-9_]{24}_[a-z0-9_]{29}_[A-Za-z0-9_-]{4}$/);
		expect(new Set([agentServerName, firstBoxName, secondBoxName]).size).toBe(3);
		expect(createAgentMcpToolName({ kind: "agent-server" }, serverId, stableToolId)).toBe(
			agentServerName,
		);
	});

	test("gives unused server or Tool slug capacity to the other slug", () => {
		const owner = { kind: "agent-server" as const };
		const shortServerName = createAgentMcpToolName(owner, "s", "b".repeat(120));
		const shortToolName = createAgentMcpToolName(owner, "a".repeat(120), "t");
		const bothShortName = createAgentMcpToolName(owner, "server", "tool");

		expect(shortServerName).toHaveLength(63);
		expect(shortServerName).toMatch(/^mcp_s_b{52}_[A-Za-z0-9_-]{4}$/);
		expect(shortToolName).toHaveLength(63);
		expect(shortToolName).toMatch(/^mcp_a{52}_t_[A-Za-z0-9_-]{4}$/);
		expect(bothShortName).toMatch(/^mcp_server_tool_[A-Za-z0-9_-]{4}$/);
	});
});
