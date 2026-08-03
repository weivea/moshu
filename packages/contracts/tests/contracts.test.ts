import { describe, expect, test } from "bun:test";

import {
	agentsRuntimeInfoSchema,
	approvalRequestSchema,
	chatRunToolPartSchema,
	chatRunSchema,
	createProviderInputSchema,
	createExecutorToolParameterPayload,
	executorExecutionContextSchema,
	listChatSessionsInputSchema,
	maxToolCallIdBytes,
	projectPathPreviewSchema,
	projectSchema,
	providerAuthAttemptOutputSchema,
	runtimeBoxToolAuthorizationSchema,
	runtimeBoxToolInvokeInputSchema,
	runProviderConfigInputSchema,
	sessionModelSelectionSchema,
	updateSessionApprovalPolicyInputSchema,
} from "../src";

describe("Pi-neutral backend contracts", () => {
	test("accepts Pi runtime and provider state without secret output fields", () => {
		const runtime = agentsRuntimeInfoSchema.parse({
			apiVersion: 3,
			serverVersion: "0.0.1",
			bunVersion: "1.3.14",
			platform: "darwin",
			arch: "arm64",
			agentRuntime: {
				loaded: true,
				foundation: "pi-agent",
				versions: { piAi: "0.82.1", piAgentCore: "0.82.1", piCodingAgent: "0.82.1" },
			},
			activeRuntimeBoxId: "moshu-local-runtime-box",
			runtimeBoxes: [
				{
					runtimeBox: {
						schemaVersion: 1,
						runtimeBoxId: "moshu-local-runtime-box",
						kind: "local",
						displayName: "Local Runtime Box",
						runtimeBoxVersion: "0.0.1",
						platform: "darwin",
						arch: "arm64",
						capabilities: ["tool.read"],
					},
					connected: true,
					registered: true,
					deviceKeyIds: [],
					instanceId: "local-instance",
					generation: 1,
				},
			],
		});
		expect(runtime.agentRuntime.foundation).toBe("pi-agent");
		expect(runtime.runtimeBoxes[0]?.runtimeBox.kind).toBe("local");

		const runProvider = runProviderConfigInputSchema.parse({
			schemaVersion: 1,
			providerId: "anthropic",
			name: "Anthropic",
			source: "builtin",
			api: "anthropic-messages",
			model: "claude-test",
			thinkingLevel: "high",
		});
		expect(runProvider).not.toHaveProperty("apiKey");
	});

	test("restricts custom APIs and models use Pi thinking levels", () => {
		expect(
			createProviderInputSchema.safeParse({
				schemaVersion: 2,
				displayName: "Custom",
				api: "unsupported-api",
				baseUrl: "https://example.invalid",
			}).success,
		).toBe(false);
		expect(
			sessionModelSelectionSchema.parse({
				providerId: "openai",
				modelId: "gpt-test",
				thinkingLevel: "xhigh",
			}).thinkingLevel,
		).toBe("xhigh");
	});

	test("keeps secret auth responses input-only", () => {
		const output = providerAuthAttemptOutputSchema.parse({
			attempt: {
				schemaVersion: 2,
				id: crypto.randomUUID(),
				providerId: "anthropic",
				authType: "api_key",
				status: "waiting_for_interaction",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				challenge: { id: crypto.randomUUID(), type: "secret", message: "API key" },
				notifications: [],
			},
		});
		expect(output.attempt.challenge).not.toHaveProperty("value");
	});

	test("strictly models Project health, previews, Session scope, and Run snapshots", () => {
		const projectId = "018f47a2-9bcd-7def-8abc-1234567890ab";
		const now = new Date().toISOString();
		const project = projectSchema.parse({
			schemaVersion: 1,
			id: projectId,
			runtimeBoxId: "project-box",
			name: "Project",
			path: "/workspace/project",
			pathRevision: 2,
			pathStatus: "unavailable",
			pathCheckedAt: now,
			pathIssueCode: "not_found",
			createdAt: now,
			updatedAt: now,
		});
		expect(project.pathRevision).toBe(2);
		expect(
			projectSchema.safeParse({ ...project, pathStatus: "available", pathIssueCode: "not_found" })
				.success,
		).toBe(false);

		expect(
			projectPathPreviewSchema.safeParse({
				schemaVersion: 1,
				runtimeBoxId: "project-box",
				runtimeBoxDisplayName: "Project Box",
				runtimeBoxPlatform: "linux",
				inputPath: "~/project",
				normalizedPath: "/workspace/project",
				displayName: "Project",
				rootAgents: { status: "missing" },
				confirmationToken: "a".repeat(64),
				rawError: "private host diagnostic",
			}).success,
		).toBe(false);
		expect(
			listChatSessionsInputSchema.parse({
				scope: { kind: "project", projectId },
			}).scope,
		).toEqual({ kind: "project", projectId });
		expect(
			listChatSessionsInputSchema.safeParse({
				runtimeBoxId: "project-box",
				scope: { kind: "global" },
			}).success,
		).toBe(false);

		const run = chatRunSchema.parse({
			schemaVersion: 1,
			id: "018f47a2-9bcd-7def-8abc-1234567890ac",
			sessionId: "018f47a2-9bcd-7def-8abc-1234567890ad",
			runtimeBoxId: "project-box",
			projectContext: {
				projectId,
				runtimeBoxId: "project-box",
				projectPath: "/workspace/project",
				projectPathRevision: 2,
				rootAgentsHash: "b".repeat(64),
			},
			mode: "ask",
			status: "queued",
			provider: {
				schemaVersion: 1,
				providerId: projectId,
				name: "Provider",
				source: "custom",
				api: "openai-responses",
				model: "model",
				status: "ready",
			},
			userMessageId: "018f47a2-9bcd-7def-8abc-1234567890ae",
			createdAt: now,
			updatedAt: now,
		});
		expect(run.projectContext?.projectPath).toBe("/workspace/project");
	});

	test("requires and integrity-binds Project path revisions for project-root grants", () => {
		expect(
			executorExecutionContextSchema.safeParse({ executionScope: "project-root" }).success,
		).toBe(false);
		expect(
			runtimeBoxToolAuthorizationSchema.safeParse({
				actionId: crypto.randomUUID(),
				grantId: crypto.randomUUID(),
				grantToken: "a".repeat(32),
				parameterDigest: "b".repeat(64),
				originInstanceId: "agents",
				originGeneration: 1,
				targetRuntimeBoxId: "box",
				targetInstanceId: "box-instance",
				targetGeneration: 1,
				executionScope: "request-cwd",
				projectPathRevision: 1,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}).success,
		).toBe(false);

		const invocation = {
			schemaVersion: 1 as const,
			invocationId: crypto.randomUUID(),
			runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
			toolCallId: "tool-call",
			cwd: "/workspace/project",
			call: { tool: "read" as const, arguments: { path: "README.md" } },
		};
		expect(
			createExecutorToolParameterPayload(invocation, {
				executionScope: "project-root",
				projectPathRevision: 1,
			}),
		).not.toBe(
			createExecutorToolParameterPayload(invocation, {
				executionScope: "project-root",
				projectPathRevision: 2,
			}),
		);
	});

	test("uses one provider-sized Tool call ID bound across runtime, timeline, and approvals", () => {
		const now = new Date().toISOString();
		const runId = "018f47a2-9bcd-7def-8abc-1234567890ab";
		const sessionId = "018f47a2-9bcd-7def-8abc-1234567890ac";
		const toolCallId = `call_${"x".repeat(437)}`;
		expect(toolCallId).toHaveLength(442);

		expect(
			runtimeBoxToolInvokeInputSchema.parse({
				schemaVersion: 1,
				invocationId: crypto.randomUUID(),
				runId,
				toolCallId,
				cwd: "/workspace",
				call: {
					tool: "edit",
					arguments: { path: "README.md", edits: [{ oldText: "a", newText: "b" }] },
				},
			}).toolCallId,
		).toBe(toolCallId);
		expect(
			chatRunToolPartSchema.parse({
				schemaVersion: 1,
				id: "018f47a2-9bcd-7def-8abc-1234567890ad",
				runId,
				position: 1,
				assistantTurnId: "018f47a2-9bcd-7def-8abc-1234567890ae",
				revision: 1,
				createdAt: now,
				updatedAt: now,
				kind: "tool",
				toolCallId,
				tool: { kind: "builtin", name: "edit" },
				status: "waiting_approval",
				summary: "Edit README.md",
			}).toolCallId,
		).toBe(toolCallId);
		expect(
			approvalRequestSchema.parse({
				schemaVersion: 1,
				id: crypto.randomUUID(),
				sessionId,
				runId,
				actionId: crypto.randomUUID(),
				toolCallId,
				action: {
					tool: "edit",
					operation: "edit",
					target: { kind: "runtime-box", id: "local" },
					path: "README.md",
					redactedParams: {},
				},
				risk: { tier: "medium", overridable: true, reasons: ["file mutation"] },
				state: "pending",
				revision: 1,
				createdAt: now,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}).toolCallId,
		).toBe(toolCallId);
		expect(
			approvalRequestSchema.safeParse({
				schemaVersion: 1,
				id: crypto.randomUUID(),
				sessionId,
				runId,
				actionId: crypto.randomUUID(),
				toolCallId: "x".repeat(maxToolCallIdBytes + 1),
				action: {
					tool: "edit",
					operation: "edit",
					target: { kind: "runtime-box", id: "local" },
					path: "README.md",
					redactedParams: {},
				},
				risk: { tier: "medium", overridable: true, reasons: ["file mutation"] },
				state: "pending",
				revision: 1,
				createdAt: now,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}).success,
		).toBe(false);
	});

	test("binds Allow all to the current approval in one request", () => {
		const input = {
			sessionId: "018f47a2-9bcd-7def-8abc-1234567890ab",
			allowAll: true,
			expectedRevision: 0,
			idempotencyKey: crypto.randomUUID(),
			approveRequest: {
				approvalId: crypto.randomUUID(),
				expectedRevision: 1,
			},
		};
		expect(updateSessionApprovalPolicyInputSchema.parse(input)).toEqual(input);
		expect(
			updateSessionApprovalPolicyInputSchema.safeParse({
				...input,
				allowAll: false,
			}).success,
		).toBe(false);
	});
});
