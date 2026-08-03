import { describe, expect, test } from "bun:test";
import { createUuidV7, openAppDatabase } from "@moshu/database";
import { McpDefinitiveResponseError, McpToolNotReadyError } from "@moshu/mcp-runtime";

import { DurableActionAuthorizationService } from "./action-authorization-service";
import { McpActionDispatcher } from "./mcp-action-dispatcher";

type TestDatabase = ReturnType<typeof openAppDatabase>;

function appendMcpToolPart(database: TestDatabase, runId: string, toolCallId: string): void {
	const now = new Date().toISOString();
	database.runs.appendEvent({
		runId,
		type: "timeline.part.created",
		source: { kind: "assistant" },
		payload: {
			part: {
				schemaVersion: 1,
				id: createUuidV7(),
				runId,
				position: database.runs.listParts(runId).length + 1,
				assistantTurnId: createUuidV7(),
				revision: 1,
				createdAt: now,
				updatedAt: now,
				kind: "tool",
				toolCallId,
				tool: {
					kind: "mcp",
					name: "tool-query",
					mcpServerId: "global-database",
					stableToolId: "tool-query",
				},
				status: "queued",
				summary: "Query database",
			},
		},
	});
}

describe("McpActionDispatcher", () => {
	test("executes Agent Server-owned MCP Tools under an Agent Server Action target", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Server MCP" }).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "ask",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Test",
					source: "custom",
					api: "openai-responses",
					model: "test-model",
				},
				userMessageId: createUuidV7(),
				userContent: "Use the global MCP.",
			}).run;
			appendMcpToolPart(database, run.id, "tool-call");
			const serverIdentity = {
				role: "agents" as const,
				peerId: "moshu-agents-server",
				instanceId: "agents-instance",
				generation: 3,
			};
			const authorizer = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				serverIdentity,
			);
			const calls: unknown[] = [];
			const dispatcher = new McpActionDispatcher(
				"agent-server-id",
				{
					async invokeMcpForRuntimeBox() {
						throw new Error("Runtime Box MCP gateway must not be used.");
					},
				},
				{
					isToolReady() {
						return true;
					},
					async callTool(...args) {
						calls.push(args);
						return { content: [{ type: "text", text: "global result" }] };
					},
				},
				authorizer,
			);
			const invocationId = crypto.randomUUID();
			const output = await dispatcher.invokeMcp(
				{ kind: "agent-server" },
				{
					schemaVersion: 1,
					invocationId,
					runId: run.id,
					toolCallId: "tool-call",
					mcpServerId: "global-database",
					mcpServerVersion: crypto.randomUUID(),
					mcpServerContentHash: "a".repeat(64),
					stableToolId: "tool-query",
					toolSchemaHash: "b".repeat(64),
					arguments: { sql: "select 1" },
				},
			);
			expect(output).toMatchObject({
				invocationId,
				mcpServerId: "global-database",
				stableToolId: "tool-query",
				isError: false,
			});
			expect(calls).toHaveLength(1);
			expect(database.actions.get(invocationId)).toMatchObject({
				targetKind: "agent-server",
				targetId: "agent-server-id",
				state: "succeeded",
				serverAckedAtMs: expect.any(Number),
			});
		} finally {
			database.close();
		}
	});

	test("records definitive Agent Server MCP protocol failures as failed", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({
				title: "Definitive MCP failure",
			}).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "ask",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Test",
					source: "custom",
					api: "openai-responses",
					model: "test-model",
				},
				userMessageId: createUuidV7(),
				userContent: "Call the MCP.",
			}).run;
			appendMcpToolPart(database, run.id, "tool-call");
			const authorizer = new DurableActionAuthorizationService(database.actions, database.runs, {
				role: "agents",
				peerId: "moshu-agents-server",
				instanceId: "agents-instance",
				generation: 3,
			});
			const dispatcher = new McpActionDispatcher(
				"agent-server-id",
				{
					async invokeMcpForRuntimeBox() {
						throw new Error("Runtime Box MCP gateway must not be used.");
					},
				},
				{
					isToolReady() {
						return true;
					},
					async callTool() {
						throw new McpDefinitiveResponseError("MCP rejected the request.");
					},
				},
				authorizer,
			);
			const invocationId = crypto.randomUUID();
			await expect(
				dispatcher.invokeMcp(
					{ kind: "agent-server" },
					{
						schemaVersion: 1,
						invocationId,
						runId: run.id,
						toolCallId: "tool-call",
						mcpServerId: "global-database",
						mcpServerVersion: crypto.randomUUID(),
						mcpServerContentHash: "a".repeat(64),
						stableToolId: "tool-query",
						toolSchemaHash: "b".repeat(64),
						arguments: {},
					},
				),
			).rejects.toThrow("rejected");
			expect(database.actions.get(invocationId)).toMatchObject({
				state: "failed",
				serverAckedAtMs: expect.any(Number),
			});
		} finally {
			database.close();
		}
	});

	test("records a readiness race as cancelled before MCP dispatch", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({
				title: "MCP readiness race",
			}).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "ask",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Test",
					source: "custom",
					api: "openai-responses",
					model: "test-model",
				},
				userMessageId: createUuidV7(),
				userContent: "Call the MCP.",
			}).run;
			appendMcpToolPart(database, run.id, "tool-call");
			const authorizer = new DurableActionAuthorizationService(database.actions, database.runs, {
				role: "agents",
				peerId: "moshu-agents-server",
				instanceId: "agents-instance",
				generation: 3,
			});
			const dispatcher = new McpActionDispatcher(
				"agent-server-id",
				{
					async invokeMcpForRuntimeBox() {
						throw new Error("Runtime Box MCP gateway must not be used.");
					},
				},
				{
					isToolReady() {
						return true;
					},
					async callTool() {
						throw new McpToolNotReadyError();
					},
				},
				authorizer,
			);
			const invocationId = crypto.randomUUID();
			await expect(
				dispatcher.invokeMcp(
					{ kind: "agent-server" },
					{
						schemaVersion: 1,
						invocationId,
						runId: run.id,
						toolCallId: "tool-call",
						mcpServerId: "global-database",
						mcpServerVersion: crypto.randomUUID(),
						mcpServerContentHash: "a".repeat(64),
						stableToolId: "tool-query",
						toolSchemaHash: "b".repeat(64),
						arguments: {},
					},
				),
			).rejects.toThrow("not ready");
			expect(database.actions.get(invocationId)).toMatchObject({
				state: "cancelled",
				serverAckedAtMs: expect.any(Number),
			});
		} finally {
			database.close();
		}
	});
});
