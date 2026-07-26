import { describe, expect, test } from "bun:test";

import {
	agentsServerBootstrapRecordSchema,
	clientProductRequestMethods,
	createProcessChatSessionInputSchema,
	executorProductRequestMethods,
	maxRetainedSessionRetirements,
	productRpcInternalHandlerErrorCode,
	productRpcMethods,
	redactCompanionControlRecord,
	replayChatEventsInputSchema,
	replayChatEventsOutputSchema,
	retiredSessionTombstoneTtlMs,
	sendAskChatMessageInputSchema,
} from "../src";

describe("product process RPC contracts", () => {
	test("keeps client and executor request allowlists disjoint", () => {
		expect(clientProductRequestMethods).toContain(productRpcMethods.chatSend);
		expect(clientProductRequestMethods).not.toContain(productRpcMethods.executorRegister);
		expect(executorProductRequestMethods).toEqual([productRpcMethods.executorRegister]);
		expect(productRpcInternalHandlerErrorCode).toBe("INTERNAL_HANDLER_ERROR");
		expect(maxRetainedSessionRetirements).toBe(256);
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
			controlVersion: 1,
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
						role: "executor",
						peerId: "executor",
						instanceId: "executor-1",
						generation: 1,
					},
				},
			],
			paths: {
				productDatabase: "/tmp/moshu.db",
				checkpointDatabase: "/tmp/moshu-checkpoints.db",
				providerConfig: "/tmp/provider.json",
			},
		};
		expect(agentsServerBootstrapRecordSchema.parse(record)).toBeDefined();
		expect(JSON.stringify(redactCompanionControlRecord(record))).not.toContain(
			record.peerBindings[0]?.credential ?? "",
		);
		expect(JSON.stringify(redactCompanionControlRecord(record))).not.toContain("/tmp/moshu.db");
	});
});
