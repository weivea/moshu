import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAskProviderConfigStore } from "./file-provider-config-store";

describe("FileAskProviderConfigStore", () => {
	test("persists normalized Provider configuration with owner-only permissions", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-provider-"));
		const filename = join(directory, "provider.json");

		try {
			const store = new FileAskProviderConfigStore(filename);
			store.set({
				provider: "openai-compatible",
				apiKey: "sk-persisted-secret",
				model: "gpt-4.1-mini",
				endpoint: "https://example.com/v1/",
			});

			const restored = new FileAskProviderConfigStore(filename);
			expect(restored.get()).toEqual({
				provider: "openai-compatible",
				apiKey: "sk-persisted-secret",
				baseUrl: "https://example.com/v1",
				model: "gpt-4.1-mini",
			});
			expect(restored.getStatus()).toMatchObject({
				configured: true,
				baseUrl: "https://example.com/v1",
				model: "gpt-4.1-mini",
			});
			expect(restored.getStatus().apiKeyMask?.endsWith("cret")).toBe(true);
			expect(statSync(filename).mode & 0o777).toBe(0o600);
			expect(readFileSync(filename, "utf8")).toContain("sk-persisted-secret");

			writeFileSync(`${filename}.tmp`, "stale-secret");
			restored.clear();
			expect(restored.get()).toBeNull();
			expect(() => readFileSync(`${filename}.tmp`, "utf8")).toThrow();
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("removes stale temporary credential files during startup", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-provider-"));
		const filename = join(directory, "provider.json");

		try {
			writeFileSync(`${filename}.tmp`, "stale-secret");
			const store = new FileAskProviderConfigStore(filename);
			expect(store.get()).toBeNull();
			expect(() => readFileSync(`${filename}.tmp`, "utf8")).toThrow();
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("rejects malformed Provider configuration files", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-provider-"));
		const filename = join(directory, "provider.json");

		try {
			writeFileSync(filename, JSON.stringify({ schemaVersion: 99 }));
			expect(() => new FileAskProviderConfigStore(filename)).toThrow(
				"Provider configuration file has an unsupported format.",
			);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
