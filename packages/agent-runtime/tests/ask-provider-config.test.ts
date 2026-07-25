import { describe, expect, test } from "bun:test";
import { InMemoryAskProviderConfigStore, normalizeAskProviderConfiguration } from "../src";

describe("InMemoryAskProviderConfigStore", () => {
	test("stores normalized provider state without exposing api keys in status", () => {
		const store = new InMemoryAskProviderConfigStore();

		store.set({
			provider: "openai-compatible",
			apiKey: "sk-secret",
			model: "gpt-4.1-mini",
			endpoint: "https://example.com/v1/",
		});

		expect(store.getStatus()).toEqual({
			configured: true,
			baseUrl: "https://example.com/v1",
			model: "gpt-4.1-mini",
			apiKeyMask: "••••••••cret",
		});
		expect(store.get()).toEqual({
			provider: "openai-compatible",
			apiKey: "sk-secret",
			baseUrl: "https://example.com/v1",
			model: "gpt-4.1-mini",
		});
		expect("apiKey" in store.getStatus()).toBe(false);

		store.clear();

		expect(store.getStatus()).toEqual({ configured: false });
		expect(store.get()).toBeNull();
	});

	test("uses a bounded mask without exposing short keys", () => {
		const store = new InMemoryAskProviderConfigStore();

		store.set({
			provider: "openai-compatible",
			apiKey: "tiny",
			model: "test-model",
			endpoint: "https://example.com/v1",
		});
		expect(store.getStatus().apiKeyMask).toBe("••••••••");

		store.set({
			provider: "openai-compatible",
			apiKey: "x".repeat(4096),
			model: "test-model",
			endpoint: "https://example.com/v1",
		});
		expect(store.getStatus().apiKeyMask).toBe("••••••••xxxx");
	});

	test("requires baseUrl for openai-compatible providers", () => {
		expect(() =>
			normalizeAskProviderConfiguration({
				provider: "openai-compatible",
				apiKey: "sk-secret",
				model: "gpt-4.1-mini",
			}),
		).toThrow("OpenAI-compatible provider configuration requires a baseUrl or endpoint.");
	});
});
