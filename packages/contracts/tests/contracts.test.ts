import { describe, expect, test } from "bun:test";
import {
	appErrorSchema,
	chatMessageSchema,
	chatRunErrorEventSchema,
	createChatSessionInputSchema,
	createProviderInputSchema,
	deleteChatSessionOutputSchema,
	providerSummarySchema,
	runProviderStateSchema,
	runtimeInfoSchema,
	sendChatMessageInputSchema,
	setChatSessionArchivedInputSchema,
	setChatSessionModelInputSchema,
	testProviderInputSchema,
	testProviderOutputSchema,
	updateChatSessionInputSchema,
} from "../src";

describe("shared contracts", () => {
	const providerId = "01984df0-cf16-7df0-8a4a-a1fc9dc9299d";
	const sessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
	const runId = "01984df0-cf18-7c89-9d11-3686130434c8";
	const messageId = "01984df0-cf19-7bb2-a5cd-69e8a802db2f";
	const eventId = "01984df0-cf1a-7178-b174-42fc83c3e87d";
	const createdAt = "2026-07-25T04:15:28.349Z";

	test("accepts safe application errors", () => {
		const result = appErrorSchema.parse({
			code: "RUNTIME_UNAVAILABLE",
			category: "runtime",
			messageKey: "errors.runtimeUnavailable",
			safeMessage: "The runtime is unavailable.",
			retryable: true,
		});

		expect(result.code).toBe("RUNTIME_UNAVAILABLE");
	});

	test("rejects unknown runtime channels", () => {
		expect(() =>
			runtimeInfoSchema.parse({
				apiVersion: 1,
				appName: "墨枢",
				appVersion: "0.0.1",
				channel: "nightly",
				electrobunVersion: "1.18.1",
				bunVersion: "1.3.14",
				platform: "darwin",
				arch: "arm64",
				deepAgents: { loaded: true, version: "1.11.0" },
			}),
		).toThrow();
	});

	test("accepts strict send message input with provider secrets", () => {
		const result = sendChatMessageInputSchema.parse({
			sessionId,
			content: "你好，墨枢。",
			mode: "ask",
			provider: {
				schemaVersion: 1,
				providerId,
				name: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-5.4",
				apiKey: "sk-test-secret",
			},
		});

		expect(result.provider.apiKey).toBe("sk-test-secret");
	});

	test("rejects provider state objects that expose api keys", () => {
		expect(() =>
			runProviderStateSchema.parse({
				schemaVersion: 1,
				providerId,
				name: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-5.4",
				status: "ready",
				apiKey: "sk-test-secret",
			}),
		).toThrow();
	});

	test("keeps provider summaries free of api keys and header values", () => {
		expect(() =>
			providerSummarySchema.parse({
				schemaVersion: 1,
				id: providerId,
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				enabled: true,
				apiKey: "sk-test-secret",
				customHeaderNames: [],
				models: [],
			}),
		).toThrow();

		const summary = providerSummarySchema.parse({
			schemaVersion: 1,
			id: providerId,
			displayName: "OpenAI",
			type: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			enabled: true,
			apiKeyMask: "••••••••cret",
			customHeaderNames: ["X-Org"],
			models: [
				{
					id: "gpt-5.4",
					enabled: true,
					contextWindowTokens: 272_000,
					reasoningEfforts: ["low", "medium", "high"],
				},
			],
		});

		expect(summary.models[0]?.reasoningEfforts).toEqual(["low", "medium", "high"]);
		expect(JSON.stringify(summary)).not.toContain("sk-test-secret");
	});

	test("rejects unsupported provider types and malformed custom headers", () => {
		expect(() =>
			createProviderInputSchema.parse({
				schemaVersion: 1,
				displayName: "Gateway",
				type: "gemini",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-test",
			}),
		).toThrow();

		expect(() =>
			createProviderInputSchema.parse({
				schemaVersion: 1,
				displayName: "Gateway",
				type: "openai-compatible",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-test",
				customHeaders: { "Bad Header": "value" },
			}),
		).toThrow();

		expect(
			createProviderInputSchema.parse({
				schemaVersion: 1,
				displayName: "Gateway",
				type: "anthropic-compatible",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-test",
				customHeaders: { "X-Org": "acme" },
			}).customHeaders,
		).toEqual({ "X-Org": "acme" });
	});

	test("requires exactly one provider test target", () => {
		expect(() => testProviderInputSchema.parse({ schemaVersion: 1 })).toThrow();
		expect(() =>
			testProviderInputSchema.parse({
				schemaVersion: 1,
				providerId,
				draft: {
					displayName: "Gateway",
					type: "openai-compatible",
					baseUrl: "https://example.com/v1",
				},
			}),
		).toThrow();
		expect(testProviderInputSchema.parse({ schemaVersion: 1, providerId }).providerId).toBe(
			providerId,
		);
	});

	test("accepts a nullable session model selection", () => {
		expect(setChatSessionModelInputSchema.parse({ sessionId, model: null }).model).toBeNull();
		expect(
			setChatSessionModelInputSchema.parse({
				sessionId,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					reasoning: { budgetTokens: 8_192 },
				},
			}).model?.reasoning?.budgetTokens,
		).toBe(8_192);
	});

	test("accepts structured Provider connection test results", () => {
		const result = testProviderOutputSchema.parse({
			schemaVersion: 1,
			ok: false,
			latencyMs: 42,
			error: {
				code: "PROVIDER_AUTHENTICATION_FAILED",
				category: "authentication",
				messageKey: "errors.providerAuthenticationFailed",
				safeMessage: "Provider authentication failed.",
				retryable: false,
			},
		});

		expect(result.error?.category).toBe("authentication");
	});

	test("accepts strict Session management inputs", () => {
		expect(
			updateChatSessionInputSchema.parse({
				sessionId,
				title: "Renamed chat",
			}).title,
		).toBe("Renamed chat");
		expect(
			setChatSessionArchivedInputSchema.parse({
				sessionId,
				archived: true,
			}).archived,
		).toBe(true);
		expect(
			deleteChatSessionOutputSchema.parse({
				sessionId,
			}).sessionId,
		).toBe(sessionId);
	});

	test("requires failed assistant messages to carry structured errors", () => {
		expect(() =>
			chatMessageSchema.parse({
				schemaVersion: 1,
				id: messageId,
				sessionId,
				runId,
				role: "assistant",
				status: "failed",
				content: "",
				sequence: 2,
				createdAt,
				updatedAt: createdAt,
			}),
		).toThrow();
	});

	test("accepts cancelled assistant messages with partial content", () => {
		const message = chatMessageSchema.parse({
			schemaVersion: 1,
			id: messageId,
			sessionId,
			runId,
			role: "assistant",
			status: "cancelled",
			content: "Partial response",
			sequence: 2,
			createdAt,
			updatedAt: createdAt,
		});

		expect(message.status).toBe("cancelled");
	});

	test("parses normalized run error events", () => {
		const event = chatRunErrorEventSchema.parse({
			schemaVersion: 1,
			id: eventId,
			runId,
			sessionId,
			seq: 4,
			type: "run.error",
			source: {
				kind: "system",
			},
			visibility: "user",
			createdAt,
			payload: {
				error: {
					code: "PROVIDER_TIMEOUT",
					category: "provider",
					messageKey: "errors.providerTimeout",
					safeMessage: "The provider timed out.",
					retryable: true,
				},
			},
		});

		expect(event.payload.error.category).toBe("provider");
	});

	test("rejects extra fields in strict user inputs", () => {
		expect(() =>
			createChatSessionInputSchema.parse({
				title: "Session",
				defaultMode: "ask",
				unknown: true,
			}),
		).toThrow();
	});
});
