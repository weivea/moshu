import { describe, expect, test } from "bun:test";
import {
	appErrorSchema,
	chatProviderStatusSchema,
	chatMessageSchema,
	chatRunErrorEventSchema,
	createChatSessionInputSchema,
	openAiCompatibleProviderStateSchema,
	runtimeInfoSchema,
	sendChatMessageInputSchema,
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
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-5.4",
				apiKey: "sk-test-secret",
			},
		});

		expect(result.provider.apiKey).toBe("sk-test-secret");
	});

	test("rejects provider state objects that expose api keys", () => {
		expect(() =>
			openAiCompatibleProviderStateSchema.parse({
				schemaVersion: 1,
				providerId,
				name: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-5.4",
				status: "ready",
				apiKey: "sk-test-secret",
			}),
		).toThrow();
	});

	test("requires configured provider status to include a model", () => {
		expect(() =>
			chatProviderStatusSchema.parse({
				schemaVersion: 1,
				configured: true,
				baseUrl: "https://api.openai.com/v1",
				model: "",
			}),
		).toThrow();
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
