import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createExecutorToolParameterPayload, defaultLocalRuntimeBoxId } from "@moshu/contracts";
import { createUuidV7, openAppDatabase } from "@moshu/database";
import {
	ActionPolicyDeniedError,
	DurableActionAuthorizationService,
} from "./action-authorization-service";

describe("DurableActionAuthorizationService", () => {
	test("binds project-root scope and path revision into the grant digest", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({
				title: "Project grant",
			}).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Provider",
					source: "custom",
					api: "openai-responses",
					model: "model",
				},
				userMessageId: createUuidV7(),
				userContent: "run",
				assistantMessageId: createUuidV7(),
			}).run;
			const invocation = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId: run.id,
				toolCallId: "project-tool-call",
				cwd: "/workspace/project",
				call: { tool: "read" as const, arguments: { path: "README.md" } },
			};
			const projectContext = {
				projectId: createUuidV7(),
				runtimeBoxId: defaultLocalRuntimeBoxId,
				projectPath: invocation.cwd,
				projectPathRevision: 7,
			};
			const service = new DurableActionAuthorizationService(
				database.actions,
				{ get: () => ({ ...run, projectContext }) },
				{
					role: "agents",
					peerId: "agents",
					instanceId: "agents-instance",
					generation: 1,
				},
			);
			const executionContext = {
				executionScope: "project-root" as const,
				projectPathRevision: 7,
			};
			const authorized = await service.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				{
					role: "runtime-box",
					peerId: defaultLocalRuntimeBoxId,
					instanceId: "runtime-instance",
					generation: 1,
				},
				executionContext,
			);
			expect(authorized.authorization).toMatchObject(executionContext);
			expect(authorized.authorization?.parameterDigest).toBe(
				createHash("sha256")
					.update(createExecutorToolParameterPayload(invocation, executionContext))
					.digest("hex"),
			);
			const target = {
				role: "runtime-box" as const,
				peerId: defaultLocalRuntimeBoxId,
				instanceId: "runtime-instance",
				generation: 1,
			};
			await expect(
				service.authorize(
					defaultLocalRuntimeBoxId,
					{ ...invocation, invocationId: crypto.randomUUID(), cwd: "/workspace/other" },
					target,
					executionContext,
				),
			).rejects.toThrow("persisted Project Run snapshot");
			await expect(
				service.authorize(
					defaultLocalRuntimeBoxId,
					{ ...invocation, invocationId: crypto.randomUUID() },
					target,
					{ executionScope: "project-root", projectPathRevision: 8 },
				),
			).rejects.toThrow("persisted Project Run snapshot");
			await expect(
				service.authorize(
					defaultLocalRuntimeBoxId,
					{ ...invocation, invocationId: crypto.randomUUID() },
					target,
					{ executionScope: "request-cwd" },
				),
			).rejects.toThrow("persisted Project Run snapshot");
		} finally {
			database.close();
		}
	});

	test("binds and consumes a grant before dispatch, then reconciles old-generation evidence", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Action" }).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Provider",
					source: "custom",
					api: "openai-responses",
					model: "model",
					thinkingLevel: "medium",
				},
				userMessageId: createUuidV7(),
				userContent: "run",
				assistantMessageId: createUuidV7(),
			}).run;
			const service = new DurableActionAuthorizationService(database.actions, database.runs, {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-generation-five",
				generation: 5,
			});
			const invocation = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId: run.id,
				toolCallId: "tool-call",
				cwd: "/workspace",
				call: {
					tool: "write" as const,
					arguments: { path: "file.txt", content: "data" },
				},
			};
			const authorized = await service.authorize(
				defaultLocalRuntimeBoxId,
				invocation,
				{
					role: "runtime-box",
					peerId: defaultLocalRuntimeBoxId,
					instanceId: "runtime-instance",
					generation: 3,
				},
				{ executionScope: "request-cwd" },
			);
			expect(authorized.authorization).toMatchObject({
				originInstanceId: "agents-generation-five",
				originGeneration: 5,
			});
			expect(database.actions.get(invocation.invocationId)).toMatchObject({
				state: "running",
				grantConsumedAtMs: expect.any(Number),
			});

			service.markOutcomeUnknown(authorized, "connection lost");
			const authorization = authorized.authorization;
			if (authorization === undefined) {
				throw new Error("Expected authorization.");
			}
			expect(
				service.reconcile(
					defaultLocalRuntimeBoxId,
					[
						{
							invocationId: invocation.invocationId,
							actionId: authorization.actionId,
							grantId: authorization.grantId,
							parameterDigest: authorization.parameterDigest,
							originInstanceId: authorization.originInstanceId,
							originGeneration: authorization.originGeneration,
							targetRuntimeBoxId: authorization.targetRuntimeBoxId,
							targetInstanceId: authorization.targetInstanceId,
							targetGeneration: authorization.targetGeneration,
							state: "failed",
							safeError: "write failed on device",
							completedAt: new Date().toISOString(),
						},
					],
					[],
				),
			).toEqual({
				ackedInvocationIds: [invocation.invocationId],
				confirmedAcknowledgementIds: [],
			});
			expect(database.actions.get(invocation.invocationId)).toMatchObject({
				state: "failed",
				safeError: "write failed on device",
				serverAckedAtMs: expect.any(Number),
			});
			expect(() =>
				service.reconcile("different-runtime-box", [], [invocation.invocationId]),
			).toThrow("did not match the Runtime Box");
			expect(service.reconcile(defaultLocalRuntimeBoxId, [], [invocation.invocationId])).toEqual({
				ackedInvocationIds: [],
				confirmedAcknowledgementIds: [invocation.invocationId],
			});
			expect(database.actions.get(invocation.invocationId)).toMatchObject({
				boxReceiptConfirmedAtMs: expect.any(Number),
			});
			const undispatched = {
				...invocation,
				invocationId: crypto.randomUUID(),
				toolCallId: "undispatched-tool-call",
			};
			const undispatchedAuthorized = await service.authorize(
				defaultLocalRuntimeBoxId,
				undispatched,
				{
					role: "runtime-box",
					peerId: defaultLocalRuntimeBoxId,
					instanceId: "runtime-instance",
					generation: 3,
				},
				{ executionScope: "request-cwd" },
			);
			service.cancelUndispatched(undispatchedAuthorized, "readiness changed");
			expect(database.actions.get(undispatched.invocationId)).toMatchObject({
				state: "cancelled",
				serverAckedAtMs: expect.any(Number),
				boxReceiptConfirmedAtMs: expect.any(Number),
			});
			database.runs.deleteSessionAndRetireRuns(session.id);
			expect(service.reconcile(defaultLocalRuntimeBoxId, [], [invocation.invocationId])).toEqual({
				ackedInvocationIds: [],
				confirmedAcknowledgementIds: [invocation.invocationId],
			});
		} finally {
			database.close();
		}
	});

	test("retains an approval boundary when side effects are not pre-authorized", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const service = new DurableActionAuthorizationService(
				database.actions,
				database.runs,
				{
					role: "agents",
					peerId: "agents",
					instanceId: "agents-instance",
					generation: 1,
				},
				{ allowSideEffects: false },
			);
			await expect(
				service.authorize(
					defaultLocalRuntimeBoxId,
					{
						schemaVersion: 1,
						invocationId: crypto.randomUUID(),
						runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
						toolCallId: "tool-call",
						cwd: "/workspace",
						call: { tool: "bash", arguments: { command: "echo test" } },
					},
					{
						role: "runtime-box",
						peerId: defaultLocalRuntimeBoxId,
						instanceId: "runtime-instance",
						generation: 1,
					},
					{ executionScope: "request-cwd" },
				),
			).rejects.toBeInstanceOf(ActionPolicyDeniedError);
		} finally {
			database.close();
		}
	});

	test("uses the same durable one-time grant boundary for MCP Tools", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "MCP Action" }).session;
			const run = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: createUuidV7(),
					name: "Provider",
					source: "custom",
					api: "openai-responses",
					model: "model",
					thinkingLevel: "medium",
				},
				userMessageId: createUuidV7(),
				userContent: "run",
				assistantMessageId: createUuidV7(),
			}).run;
			const service = new DurableActionAuthorizationService(database.actions, database.runs, {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 2,
			});
			const input = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId: run.id,
				toolCallId: "mcp-tool-call",
				mcpServerId: "database-tools",
				mcpServerVersion: "550e8400-e29b-41d4-a716-446655440010",
				mcpServerContentHash: "a".repeat(64),
				stableToolId: "tool-query",
				toolSchemaHash: "b".repeat(64),
				arguments: { sql: "select 1" },
			};
			const authorized = await service.authorizeMcp(defaultLocalRuntimeBoxId, input, {
				role: "runtime-box",
				peerId: defaultLocalRuntimeBoxId,
				instanceId: "runtime-instance",
				generation: 3,
			});
			service.complete(defaultLocalRuntimeBoxId, authorized, {
				schemaVersion: 1,
				invocationId: input.invocationId,
				mcpServerId: input.mcpServerId,
				stableToolId: input.stableToolId,
				result: { content: [{ type: "text", text: "row" }] },
				isError: false,
			});
			expect(database.actions.get(input.invocationId)).toMatchObject({
				tool: "mcp:database-tools:tool-query",
				state: "succeeded",
				result: {
					mcpServerId: "database-tools",
					stableToolId: "tool-query",
				},
			});
		} finally {
			database.close();
		}
	});
});
