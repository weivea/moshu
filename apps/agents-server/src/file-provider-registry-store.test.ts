import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderCapacityError } from "@moshu/agent-runtime";
import { maxProviderCount } from "@moshu/contracts";

import { FileProviderRegistryStore } from "./file-provider-registry-store";

interface PersistedRegistryDocument {
	schemaVersion: number;
	providers: Array<{
		id: string;
		type: string;
		apiKey: string;
		baseUrl: string;
		models: Array<{ id: string; enabled: boolean; supportedEndpoints?: string[] }>;
	}>;
	defaultModel?: { providerId: string; modelId: string };
}

const modelsFetchedAt = "2026-07-27T00:00:00.000Z";

function withRegistryFile<T>(run: (filename: string) => T): T {
	const directory = mkdtempSync(join(tmpdir(), "moshu-registry-"));
	const filename = join(directory, "providers.json");
	try {
		return run(filename);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function readDocument(filename: string): PersistedRegistryDocument {
	return JSON.parse(readFileSync(filename, "utf8")) as PersistedRegistryDocument;
}

describe("FileProviderRegistryStore", () => {
	test("persists create, update, and delete round-trips across restarts", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1/",
				apiKey: "sk-secret",
				customHeaders: { "X-Org": "acme-secret" },
			});
			expect(created.enabled).toBe(true);
			expect(created.models).toEqual([]);
			expect(created.baseUrl).toBe("https://api.openai.com/v1");

			const afterCreate = new FileProviderRegistryStore(filename);
			expect(afterCreate.get(created.id)).toMatchObject({
				displayName: "OpenAI",
				type: "openai-compatible",
				apiKey: "sk-secret",
				customHeaders: { "X-Org": "acme-secret" },
			});

			afterCreate.update({ providerId: created.id, displayName: "OpenAI Prod", enabled: false });
			const afterUpdate = new FileProviderRegistryStore(filename);
			expect(afterUpdate.get(created.id)).toMatchObject({
				displayName: "OpenAI Prod",
				enabled: false,
				apiKey: "sk-secret",
			});

			afterUpdate.delete(created.id);
			const afterDelete = new FileProviderRegistryStore(filename);
			expect(afterDelete.get(created.id)).toBeNull();
			expect(afterDelete.list()).toEqual([]);
		});
	});

	test("writes owner-only files and clears a stale temporary sibling on construction", () => {
		withRegistryFile((filename) => {
			writeFileSync(`${filename}.tmp`, "stale-secret");
			const store = new FileProviderRegistryStore(filename);
			expect(existsSync(`${filename}.tmp`)).toBe(false);

			store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret",
			});
			expect(statSync(filename).mode & 0o777).toBe(0o600);
			expect(readFileSync(filename, "utf8")).toContain("sk-secret");
			expect(existsSync(`${filename}.tmp`)).toBe(false);
		});
	});

	test("keeps the stored API key when it is omitted and clears empty custom headers", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-original",
				customHeaders: { "X-Org": "acme-secret" },
			});

			const renamed = store.update({ providerId: created.id, displayName: "Renamed" });
			expect(renamed.apiKey).toBe("sk-original");
			expect(renamed.customHeaders).toEqual({ "X-Org": "acme-secret" });

			const cleared = store.update({ providerId: created.id, customHeaders: {} });
			expect(cleared.apiKey).toBe("sk-original");
			expect(cleared.customHeaders).toBeUndefined();

			const rotated = store.update({ providerId: created.id, apiKey: "sk-rotated" });
			expect(rotated.apiKey).toBe("sk-rotated");
		});
	});

	test("preserves previously-enabled model ids and refreshes the fetch timestamp", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret",
			});
			store.setModels(
				created.id,
				[
					{ id: "gpt-5.4", enabled: false },
					{ id: "gpt-4o", enabled: false },
				],
				"2026-01-01T00:00:00.000Z",
			);
			store.setModelsEnabled(created.id, ["gpt-5.4"]);

			const refreshed = store.setModels(
				created.id,
				[
					{ id: "gpt-5.4", enabled: false },
					{ id: "gpt-4o", enabled: false },
					{ id: "o5", enabled: false },
				],
				"2026-02-02T00:00:00.000Z",
			);
			const enabledById = new Map(refreshed.models.map((model) => [model.id, model.enabled]));
			expect(enabledById.get("gpt-5.4")).toBe(true);
			expect(enabledById.get("gpt-4o")).toBe(false);
			expect(enabledById.get("o5")).toBe(false);
			expect(refreshed.modelsFetchedAt).toBe("2026-02-02T00:00:00.000Z");
		});
	});

	test("drops a default model when its model is disabled", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret",
			});
			store.setModels(
				created.id,
				[
					{ id: "gpt-5.4", enabled: false },
					{ id: "gpt-4o", enabled: false },
				],
				"2026-01-01T00:00:00.000Z",
			);
			store.setModelsEnabled(created.id, ["gpt-5.4", "gpt-4o"]);
			store.setDefaultModel({ providerId: created.id, modelId: "gpt-4o" });
			expect(store.getDefaultModel()).toEqual({ providerId: created.id, modelId: "gpt-4o" });

			const flipped = store.setModelsEnabled(created.id, ["gpt-5.4"]);
			const enabledById = new Map(flipped.models.map((model) => [model.id, model.enabled]));
			expect(enabledById.get("gpt-5.4")).toBe(true);
			expect(enabledById.get("gpt-4o")).toBe(false);
			expect(store.getDefaultModel()).toBeNull();
		});
	});

	test("clears the default model when its provider is deleted", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "OpenAI",
				type: "openai-compatible",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-secret",
			});
			store.setModels(created.id, [{ id: "gpt-5.4", enabled: false }], "2026-01-01T00:00:00.000Z");
			store.setModelsEnabled(created.id, ["gpt-5.4"]);
			store.setDefaultModel({ providerId: created.id, modelId: "gpt-5.4" });
			expect(store.getDefaultModel()).not.toBeNull();

			store.delete(created.id);
			expect(store.getDefaultModel()).toBeNull();
		});
	});

	test("migrates a legacy single-provider document in place", () => {
		withRegistryFile((filename) => {
			writeFileSync(
				filename,
				JSON.stringify({
					schemaVersion: 1,
					configuration: {
						provider: "openai-compatible",
						apiKey: "sk-legacy",
						model: "gpt-4.1-mini",
						baseUrl: "https://api.openai.com/v1",
					},
				}),
			);

			const store = new FileProviderRegistryStore(filename);
			const providers = store.list();
			expect(providers).toHaveLength(1);
			const provider = providers[0];
			expect(provider?.apiKey).toBe("sk-legacy");
			expect(provider?.type).toBe("openai-compatible");
			expect(provider?.models).toEqual([{ id: "gpt-4.1-mini", enabled: true }]);
			expect(store.getDefaultModel()).toEqual({
				providerId: provider?.id ?? "",
				modelId: "gpt-4.1-mini",
			});

			const persisted = readDocument(filename);
			expect(persisted.schemaVersion).toBe(3);
			expect(persisted.providers).toHaveLength(1);
			expect(persisted.providers[0]?.models).toEqual([{ id: "gpt-4.1-mini", enabled: true }]);
			expect(persisted.defaultModel?.modelId).toBe("gpt-4.1-mini");
			expect(statSync(filename).mode & 0o777).toBe(0o600);
		});
	});

	test("migrates v2 protocol types while preserving legacy Responses routing", () => {
		withRegistryFile((filename) => {
			const chatProviderId = "0192f0aa-0000-7000-8000-000000000011";
			const responsesProviderId = "0192f0aa-0000-7000-8000-000000000012";
			const anthropicProviderId = "0192f0aa-0000-7000-8000-000000000013";
			writeFileSync(
				filename,
				JSON.stringify({
					schemaVersion: 2,
					providers: [
						{
							id: chatProviderId,
							displayName: "Chat gateway",
							type: "openai-chat-completions",
							baseUrl: "https://chat.example/v1",
							apiKey: "sk-chat",
							enabled: true,
							models: [{ id: "chat-model", enabled: true }],
						},
						{
							id: responsesProviderId,
							displayName: "Responses gateway",
							type: "openai-responses",
							baseUrl: "https://responses.example/v1",
							apiKey: "sk-responses",
							enabled: true,
							models: [{ id: "responses-model", enabled: true }],
						},
						{
							id: anthropicProviderId,
							displayName: "Anthropic gateway",
							type: "anthropic-messages",
							baseUrl: "https://anthropic.example/v1",
							apiKey: "sk-anthropic",
							enabled: true,
							models: [{ id: "claude-model", enabled: true }],
						},
					],
					defaultModel: {
						providerId: responsesProviderId,
						modelId: "responses-model",
					},
				}),
			);

			const store = new FileProviderRegistryStore(filename);
			expect(store.list().map((provider) => provider.type)).toEqual([
				"openai-compatible",
				"openai-compatible",
				"anthropic-compatible",
			]);
			expect(store.get(responsesProviderId)?.models[0]?.supportedEndpoints).toEqual(["/responses"]);
			expect(store.getDefaultModel()).toEqual({
				providerId: responsesProviderId,
				modelId: "responses-model",
			});

			const persisted = readDocument(filename);
			expect(persisted.schemaVersion).toBe(3);
			expect(persisted.providers.map((provider) => provider.type)).toEqual([
				"openai-compatible",
				"openai-compatible",
				"anthropic-compatible",
			]);
		});
	});

	test("never writes a catalog entry it cannot read back", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "Gateway",
				type: "openai-compatible",
				baseUrl: "https://gateway.example/v1",
				apiKey: "sk-gateway",
			});

			const stored = store.setModels(
				created.id,
				[
					{ id: "good-model", enabled: false },
					{ id: "x".repeat(400), enabled: false },
				],
				"2026-07-27T00:00:00.000Z",
			);

			expect(stored.models.map((model) => model.id)).toEqual(["good-model"]);
			expect(() => new FileProviderRegistryStore(filename)).not.toThrow();
			expect(new FileProviderRegistryStore(filename).list()[0]?.models).toHaveLength(1);
		});
	});

	test("skips an unreadable stored model instead of failing to open the registry", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			const created = store.create({
				displayName: "Gateway",
				type: "openai-compatible",
				baseUrl: "https://gateway.example/v1",
				apiKey: "sk-gateway",
			});
			store.setModels(created.id, [{ id: "good-model", enabled: false }], modelsFetchedAt);

			const document = readDocument(filename) as PersistedRegistryDocument & {
				providers: Array<{ models: unknown[] }>;
			};
			document.providers[0]?.models.push({ id: 42, enabled: "yes" });
			writeFileSync(filename, JSON.stringify(document), "utf8");

			const reopened = new FileProviderRegistryStore(filename);
			expect(reopened.list()[0]?.models.map((model) => model.id)).toEqual(["good-model"]);
		});
	});

	test("rejects creating more providers than the configured capacity", () => {
		withRegistryFile((filename) => {
			const store = new FileProviderRegistryStore(filename);
			for (let index = 0; index < maxProviderCount; index += 1) {
				store.create({
					displayName: `Provider ${index}`,
					type: "openai-compatible",
					baseUrl: "https://api.openai.com/v1",
					apiKey: `sk-${index}`,
				});
			}
			expect(store.list()).toHaveLength(maxProviderCount);
			expect(() =>
				store.create({
					displayName: "Overflow",
					type: "openai-compatible",
					baseUrl: "https://api.openai.com/v1",
					apiKey: "sk-overflow",
				}),
			).toThrow(ProviderCapacityError);
		});
	});
});
