import { describe, expect, test } from "bun:test";

import {
	agentsRuntimeBoxRequestMethods,
	agentsServerBootstrapRecordSchema,
	clientProductRequestMethods,
	createProcessChatSessionInputSchema,
	runtimeBoxProductEventMethods,
	runtimeBoxToolInvokeInputSchema,
	runtimeBoxToolInvokeOutputSchema,
	runtimeBoxToolProgressEventSchema,
	maxRetainedSessionRetirements,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
	redactCompanionControlRecord,
	replayChatEventsInputSchema,
	replayChatEventsOutputSchema,
	retiredSessionTombstoneTtlMs,
	runtimeBoxProductRequestMethods,
	runtimeBoxRegisterInputSchema,
	sendAskChatMessageInputSchema,
} from "../src";

describe("product process RPC contracts", () => {
	test("keeps client and Runtime Box request allowlists disjoint", () => {
		expect(clientProductRequestMethods).toContain(productRpcMethods.chatSend);
		expect(clientProductRequestMethods).toContain(productRpcMethods.providerAuthStart);
		expect(clientProductRequestMethods).toContain(productRpcMethods.providerAuthRespond);
		expect(clientProductRequestMethods).not.toContain(productRpcMethods.runtimeBoxRegister);
		expect(runtimeBoxProductRequestMethods).toEqual([
			productRpcMethods.runtimeBoxRegister,
			productRpcMethods.runtimeBoxReady,
			productRpcMethods.runtimeBoxInvocationsReconcile,
		]);
		expect(agentsRuntimeBoxRequestMethods).toEqual([
			productRpcMethods.runtimeBoxToolInvoke,
			productRpcMethods.runtimeBoxMcpToolInvoke,
			productRpcMethods.runtimeBoxProjectValidatePath,
			productRpcMethods.runtimeBoxInvocationsAck,
			productRpcMethods.runtimeBoxInventoryGetSnapshot,
			productRpcMethods.runtimeBoxInventoryGetChanges,
			productRpcMethods.runtimeBoxMcpServersList,
			productRpcMethods.runtimeBoxMcpServersUpsert,
			productRpcMethods.runtimeBoxMcpServersSetEnabled,
			productRpcMethods.runtimeBoxMcpServersDelete,
			productRpcMethods.runtimeBoxSkillsList,
			productRpcMethods.runtimeBoxSkillsInstall,
			productRpcMethods.runtimeBoxSkillsDelete,
			productRpcMethods.runtimeBoxResourcesValidate,
			productRpcMethods.runtimeBoxSkillGetContent,
		]);
		expect(runtimeBoxProductEventMethods).toHaveLength(2);
		expect(productRpcInternalHandlerErrorCode).toBe("INTERNAL_HANDLER_ERROR");
		expect(maxRetainedSessionRetirements).toBe(256);
	});

	test("requires a bounded Runtime Box descriptor during registration", () => {
		const registration = {
			schemaVersion: 1 as const,
			status: "ready" as const,
			protocolVersion: 2 as const,
			transportSecurity: "relay-tls" as const,
			runtimeBox: {
				schemaVersion: 1 as const,
				runtimeBoxId: "moshu-local-runtime-box",
				kind: "local" as const,
				displayName: "Local Runtime Box",
				runtimeBoxVersion: "0.0.1",
				platform: "darwin" as const,
				arch: "arm64",
				capabilities: ["tool.read", "tool.bash"],
			},
		};
		expect(runtimeBoxRegisterInputSchema.parse(registration)).toEqual(registration);
		expect(() =>
			runtimeBoxRegisterInputSchema.parse({
				...registration,
				runtimeBox: {
					...registration.runtimeBox,
					capabilities: ["tool.read", "tool.read"],
				},
			}),
		).toThrow("capabilities must be unique");
	});

	test("rejects a tool result whose encoded aggregate exceeds the RPC budget", () => {
		const detail = "\u0000".repeat(250 * 1024);
		const content = "\u0000".repeat(120 * 1024);
		expect(() =>
			runtimeBoxToolInvokeOutputSchema.parse({
				schemaVersion: 1,
				invocationId: crypto.randomUUID(),
				tool: "edit",
				content: [{ type: "text", text: content }],
				details: { diff: detail, patch: detail },
			}),
		).toThrow("payload limit");
	});

	test("strictly discriminates Runtime Box tool calls, results, and progress", () => {
		const invocationId = crypto.randomUUID();
		const runId = "018f0f2c-7b19-7abc-8def-1234567890ab";
		const request = {
			schemaVersion: 1 as const,
			invocationId,
			runId,
			toolCallId: "tool-call-1",
			cwd: "/tmp/workspace",
			call: {
				tool: "read" as const,
				arguments: { path: "README.md", offset: 1, limit: 20 },
			},
		};
		expect(runtimeBoxToolInvokeInputSchema.parse(request)).toEqual(request);
		expect(() =>
			runtimeBoxToolInvokeInputSchema.parse({
				...request,
				call: { tool: "read", arguments: { path: "README.md", command: "pwd" } },
			}),
		).toThrow();

		const output = {
			schemaVersion: 1 as const,
			invocationId,
			tool: "read" as const,
			content: [{ type: "text" as const, text: "hello" }],
		};
		expect(runtimeBoxToolInvokeOutputSchema.parse(output)).toEqual(output);
		expect(() =>
			runtimeBoxToolInvokeOutputSchema.parse({
				...output,
				tool: "write",
				details: { truncation: {} },
			}),
		).toThrow();

		const progress = {
			schemaVersion: 1 as const,
			invocationId,
			tool: "bash" as const,
			sequence: 0,
			content: [],
		};
		expect(runtimeBoxToolProgressEventSchema.parse(progress)).toEqual(progress);
		expect(() => runtimeBoxToolProgressEventSchema.parse({ ...progress, tool: "read" })).toThrow();
	});

	test("accepts only the current Ask send projection", () => {
		const input = {
			requestId: crypto.randomUUID(),
			sessionId: "018f0f2c-7b18-7abc-8def-1234567890ab",
			content: "hello",
		};
		expect(sendAskChatMessageInputSchema.parse(input)).toEqual(input);
		expect(() => sendAskChatMessageInputSchema.parse({ ...input, mode: "ask" })).toThrow();
	});

	test("requires a strict bounded process-only Session create key", () => {
		const input = {
			schemaVersion: 1 as const,
			createKey: crypto.randomUUID(),
			title: "New chat",
			defaultMode: "ask" as const,
		};
		expect(createProcessChatSessionInputSchema.parse(input)).toEqual(input);
		expect(() => createProcessChatSessionInputSchema.parse({})).toThrow();
		expect(() =>
			createProcessChatSessionInputSchema.parse({ ...input, unexpected: true }),
		).toThrow();
		expect(() =>
			createProcessChatSessionInputSchema.parse({ ...input, createKey: "not-bounded-key" }),
		).toThrow();
	});

	test("makes replay cursor support lifetime explicit on both sides of the protocol", () => {
		const sessionId = "018f0f2c-7b18-7abc-8def-1234567890ab";
		const runId = "018f0f2c-7b19-7abc-8def-1234567890ab";
		expect(
			replayChatEventsInputSchema.parse({
				cursors: [{ runId, sessionId, issuedAtMs: 1_000, lastSeq: 2 }],
			}),
		).toBeDefined();
		expect(() => replayChatEventsInputSchema.parse({ cursors: [{ runId, lastSeq: 2 }] })).toThrow();
		expect(
			replayChatEventsOutputSchema.parse({
				events: [],
				cursorSupport: {
					schemaVersion: 1,
					serverTimeMs: 2_000,
					oldestSupportedCursorIssuedAtMs: 2_000 - retiredSessionTombstoneTtlMs,
					tombstoneTtlMs: retiredSessionTombstoneTtlMs,
				},
			}).cursorSupport.tombstoneTtlMs,
		).toBe(retiredSessionTombstoneTtlMs);
		expect(() => replayChatEventsOutputSchema.parse({ events: [] })).toThrow();
	});

	test("requires canonical credentials and redacts bootstrap secrets", () => {
		const record = {
			channel: "moshu-companion-bootstrap",
			controlVersion: 2,
			type: "START",
			role: "agents-server",
			nonce: "bootstrap-1",
			serverIdentity: {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-1",
				generation: 1,
			},
			peerBindings: [
				{
					credential: Buffer.alloc(32, 1).toString("base64url"),
					identity: {
						role: "client",
						peerId: "client",
						instanceId: "client-1",
						generation: 1,
					},
				},
				{
					credential: Buffer.alloc(32, 2).toString("base64url"),
					identity: {
						role: "runtime-box",
						peerId: "runtime-box",
						instanceId: "runtime-box-1",
						generation: 1,
					},
				},
			],
			paths: {
				productDatabase: "/Users/example/moshu.db",
				agentDataDirectory: "/Users/example/agent-data",
			},
		};
		expect(agentsServerBootstrapRecordSchema.parse(record)).toBeDefined();
		expect(JSON.stringify(redactCompanionControlRecord(record))).not.toContain(
			record.peerBindings[0]?.credential ?? "",
		);
		expect(JSON.stringify(redactCompanionControlRecord(record))).not.toContain(
			"/Users/example/moshu.db",
		);
	});
});
