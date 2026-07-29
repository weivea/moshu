import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpToolParameterPayload } from "@moshu/contracts";
import type { RpcPeer, RpcRequestContext } from "@moshu/process-rpc";

import { RuntimeBoxInvocationJournal } from "./invocation-journal";
import { McpToolOutcomeUnknownError } from "./mcp-client";
import { McpLifecycleManager } from "./mcp-lifecycle-manager";
import { createMcpToolRequestHandler } from "./mcp-tool-handler";
import { RuntimeResourceStore } from "./runtime-resource-store";

describe("MCP Tool request handler", () => {
	test("journals and executes an authorized MCP Tool through the shared Action boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-tool-handler-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "database-tools",
				displayName: "Database Tools",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			const manager = new McpLifecycleManager(store, {
				connect: async () => ({
					tools: [
						{
							stableToolId: "tool-query",
							name: "query",
							schemaHash: "a".repeat(64),
							inputSchema: { type: "object", properties: {} },
						},
					],
					async callTool(_stableToolId, argumentsValue) {
						if (
							typeof argumentsValue === "object" &&
							argumentsValue !== null &&
							!Array.isArray(argumentsValue) &&
							"unknown" in argumentsValue
						) {
							throw new McpToolOutcomeUnknownError("transport lost after dispatch");
						}
						return { content: [{ type: "text", text: JSON.stringify(argumentsValue) }] };
					},
					async close() {},
				}),
			});
			await manager.start();
			const liveServer = store.listMcpServers("runtime-box").items[0];
			const liveTool = liveServer?.tools[0];
			if (liveServer === undefined || liveTool === undefined) {
				throw new Error("Expected a live MCP Tool.");
			}
			const journal = new RuntimeBoxInvocationJournal(join(directory, "journal"));
			const handler = createMcpToolRequestHandler(manager, journal);
			const authority = {
				role: "agents" as const,
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 1,
			};
			const target = {
				role: "runtime-box" as const,
				peerId: "runtime-box",
				instanceId: "runtime-instance",
				generation: 2,
			};
			const parameters = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
				toolCallId: "mcp-call",
				mcpServerId: "database-tools",
				mcpServerVersion: liveServer.version,
				mcpServerContentHash: liveServer.contentHash,
				stableToolId: "tool-query",
				toolSchemaHash: liveTool.schemaHash,
				arguments: { sql: "select 1" },
			};
			const peer = {
				remoteIdentity: authority,
				localIdentity: target,
			} as unknown as RpcPeer;
			const context: RpcRequestContext = {
				peer,
				remoteIdentity: authority,
				signal: new AbortController().signal,
				traceId: "mcp-call",
				requestId: "mcp-call",
				method: "moshu.v1.runtimeBox.mcpTool.invoke",
				deadlineAt: Date.now() + 60_000,
			};
			const output = await handler(
				{
					...parameters,
					authorization: {
						actionId: crypto.randomUUID(),
						grantId: crypto.randomUUID(),
						grantToken: Buffer.alloc(32, 4).toString("base64url"),
						parameterDigest: createHash("sha256")
							.update(createMcpToolParameterPayload(parameters))
							.digest("hex"),
						originInstanceId: authority.instanceId,
						originGeneration: authority.generation,
						targetRuntimeBoxId: target.peerId,
						targetInstanceId: target.instanceId,
						targetGeneration: target.generation,
						executionScope: "runtime-box-workspace",
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				context,
			);
			expect(output).toMatchObject({
				mcpServerId: "database-tools",
				stableToolId: "tool-query",
				isError: false,
			});
			expect(journal.listEvidence()).toMatchObject([
				{
					invocationId: parameters.invocationId,
					state: "succeeded",
					result: { mcpServerId: "database-tools", stableToolId: "tool-query" },
				},
			]);
			const unknownParameters = {
				...parameters,
				invocationId: crypto.randomUUID(),
				toolCallId: "mcp-unknown",
				arguments: { unknown: true },
			};
			await expect(
				handler(
					{
						...unknownParameters,
						authorization: {
							actionId: crypto.randomUUID(),
							grantId: crypto.randomUUID(),
							grantToken: Buffer.alloc(32, 5).toString("base64url"),
							parameterDigest: createHash("sha256")
								.update(createMcpToolParameterPayload(unknownParameters))
								.digest("hex"),
							originInstanceId: authority.instanceId,
							originGeneration: authority.generation,
							targetRuntimeBoxId: target.peerId,
							targetInstanceId: target.instanceId,
							targetGeneration: target.generation,
							executionScope: "runtime-box-workspace",
							expiresAt: new Date(Date.now() + 60_000).toISOString(),
						},
					},
					context,
				),
			).rejects.toMatchObject({ code: "RUNTIME_BOX_MCP_TOOL_OUTCOME_UNKNOWN" });
			expect(
				journal
					.listEvidence()
					.find((evidence) => evidence.invocationId === unknownParameters.invocationId),
			).toMatchObject({ state: "outcome_unknown" });
			await manager.shutdown();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
