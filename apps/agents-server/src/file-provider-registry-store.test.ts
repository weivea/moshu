import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type CredentialStore,
	ModelRuntime,
	ProviderCapacityError,
	SecretVaultCredentialStore,
} from "@moshu/agent-runtime";
import { maxProviderCount, type ProviderModel } from "@moshu/contracts";

import { FileProviderRegistryStore } from "./file-provider-registry-store";

describe("FileProviderRegistryStore", () => {
	test("persists secret-free custom providers while credentials remain in the vault", async () => {
		await withRegistry(async ({ filename, vault, open }) => {
			const store = await open();
			const created = await store.create({
				displayName: "Gateway",
				api: "openai-responses",
				baseUrl: "https://gateway.example/v1/",
				apiKey: "fake-create-secret",
				customHeaders: { "X-Org": "fake-header-secret" },
				models: [model("model-a")],
			});
			expect(created).toMatchObject({
				displayName: "Gateway",
				source: "custom",
				api: "openai-responses",
				baseUrl: "https://gateway.example/v1",
				authMethods: ["api_key"],
				credential: { configured: true, type: "api_key" },
			});
			expect(readFileSync(filename, "utf8")).not.toContain("fake-create-secret");
			expect(readFileSync(filename, "utf8")).not.toContain("fake-header-secret");
			expect(await vault.read(created.id)).toEqual({
				type: "api_key",
				key: "fake-create-secret",
				env: { "X-Org": "fake-header-secret" },
			});

			await store.update({ providerId: created.id, displayName: "Renamed", enabled: false });
			const reopened = await open();
			expect(reopened.get(created.id)).toMatchObject({
				displayName: "Renamed",
				enabled: false,
				customHeaderNames: ["X-Org"],
			});
			expect(await vault.read(created.id)).toMatchObject({ key: "fake-create-secret" });

			await reopened.delete(created.id);
			expect((await open()).get(created.id)).toBeNull();
			expect(await vault.read(created.id)).toBeUndefined();
		});
	});

	test("writes owner-only configuration and parent directories", async () => {
		await withRegistry(async ({ filename, root, open }) => {
			const store = await open();
			await store.create({
				displayName: "Gateway",
				api: "anthropic-messages",
				baseUrl: "https://gateway.example/v1",
				apiKey: "fake-permission-secret",
			});
			expect(statSync(filename).mode & 0o777).toBe(0o600);
			expect(statSync(root).mode & 0o777).toBe(0o700);
		});
	});

	test("preserves enabled model ids and clears invalid default selections", async () => {
		await withRegistry(async ({ open }) => {
			const store = await open();
			const created = await store.create({
				displayName: "Gateway",
				api: "openai-completions",
				baseUrl: "https://gateway.example/v1",
				models: [model("model-a"), model("model-b")],
			});
			store.setModelsEnabled(created.id, ["model-a", "model-b"]);
			store.setDefaultModel({ providerId: created.id, modelId: "model-b", thinkingLevel: "high" });
			expect(store.getDefaultModel()).toEqual({
				providerId: created.id,
				modelId: "model-b",
				thinkingLevel: "high",
			});

			const refreshed = await store.setModels(
				created.id,
				[model("model-a", false), model("model-b", false), model("model-c", false)],
				"2026-07-27T00:00:00.000Z",
			);
			expect(
				Object.fromEntries(refreshed.models.map((entry) => [entry.id, entry.enabled])),
			).toEqual({
				"model-a": true,
				"model-b": true,
				"model-c": false,
			});
			store.setModelsEnabled(created.id, ["model-a"]);
			expect(store.getDefaultModel()).toBeNull();
		});
	});

	test("enforces custom provider capacity without hardcoding builtin providers", async () => {
		await withRegistry(async ({ open }) => {
			const store = await open();
			for (let index = 0; index < maxProviderCount; index += 1) {
				await store.create({
					displayName: `Provider ${index}`,
					api: "openai-responses",
					baseUrl: `https://provider-${index}.example/v1`,
				});
			}
			expect(store.list().filter((provider) => provider.source === "custom")).toHaveLength(
				maxProviderCount,
			);
			await expect(
				store.create({
					displayName: "Overflow",
					api: "openai-responses",
					baseUrl: "https://overflow.example/v1",
				}),
			).rejects.toBeInstanceOf(ProviderCapacityError);
		});
	});

	test("persists builtin enabled and model preferences and clears a disabled default", async () => {
		await withRegistry(async ({ open }) => {
			const store = await open();
			const builtin = store
				.list()
				.find((provider) => provider.source === "builtin" && provider.models.length > 0);
			if (builtin === undefined) throw new Error("Expected a built-in Provider with models.");
			const selectedModel = builtin.models[0];
			if (selectedModel === undefined) throw new Error("Expected a built-in Provider model.");
			store.setModelsEnabled(builtin.id, [selectedModel.id]);
			store.setDefaultModel({ providerId: builtin.id, modelId: selectedModel.id });
			await store.update({ providerId: builtin.id, enabled: false });
			expect(store.getDefaultModel()).toBeNull();

			const reopened = await open();
			expect(reopened.get(builtin.id)).toMatchObject({ source: "builtin", enabled: false });
			expect(
				reopened
					.get(builtin.id)
					?.models.filter((candidate) => candidate.enabled)
					.map((m) => m.id),
			).toEqual([selectedModel.id]);
			await expect(
				reopened.update({ providerId: builtin.id, displayName: "Not allowed" }),
			).rejects.toThrow("read-only");
		});
	});

	test("rejects malformed current-schema configuration instead of silently resetting it", async () => {
		await withRegistry(async ({ filename, open }) => {
			writeFileSync(
				filename,
				JSON.stringify({
					schemaVersion: 5,
					providers: "not-an-array",
					builtinPreferences: [],
				}),
			);
			await expect(open()).rejects.toThrow("configuration file is invalid");
		});
	});

	test("does not create an empty credential and removes registered secret headers after logout", async () => {
		await withRegistry(async ({ vault, open, getRuntime }) => {
			const store = await open();
			const empty = await store.create({
				displayName: "No credentials",
				api: "openai-responses",
				baseUrl: "https://empty.example/v1",
			});
			expect(await vault.read(empty.id)).toBeUndefined();
			expect(empty.credential.configured).toBe(false);

			const secured = await store.create({
				displayName: "Secured",
				api: "openai-responses",
				baseUrl: "https://secured.example/v1",
				apiKey: "fake-key",
				customHeaders: { "X-Secret": "fake-header" },
			});
			await vault.delete(secured.id);
			await store.onCredentialChanged(secured.id);
			expect(store.get(secured.id)?.credential.configured).toBe(false);
			expect(JSON.stringify(getRuntime().getRegisteredProviderConfig(secured.id))).not.toContain(
				"fake-header",
			);
		});
	});

	test("serializes concurrent mutations without losing either Provider update", async () => {
		await withRegistry(async ({ open }) => {
			const store = await open();
			const first = await store.create({
				displayName: "First",
				api: "openai-responses",
				baseUrl: "https://first.example/v1",
			});
			const second = await store.create({
				displayName: "Second",
				api: "openai-responses",
				baseUrl: "https://second.example/v1",
			});
			await Promise.all([
				store.update({ providerId: first.id, displayName: "First updated" }),
				store.update({ providerId: second.id, enabled: false }),
			]);
			expect(store.get(first.id)?.displayName).toBe("First updated");
			expect(store.get(second.id)?.enabled).toBe(false);
		});
	});

	test("refreshes only the selected public Pi Provider", async () => {
		const root = join(process.cwd(), ".test-artifacts", `provider-refresh-${crypto.randomUUID()}`);
		const refreshed: string[] = [];
		const providers = ["provider-a", "provider-b"].map((id) => ({
			id,
			name: id,
			auth: {},
			getModels: () => [],
			refreshModels: async () => {
				refreshed.push(id);
				return [];
			},
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		}));
		const runtime = {
			getProviders: () => providers,
			getProvider: (id: string) => providers.find((provider) => provider.id === id),
			getModels: () => [],
			getProviderAuthStatus: () => ({ configured: false }),
			isUsingOAuth: () => false,
		} as unknown as ModelRuntime;
		const credentials = {
			read: async () => undefined,
		} as unknown as CredentialStore;
		try {
			const store = new FileProviderRegistryStore(
				join(root, "providers.json"),
				runtime,
				credentials,
			);
			await store.refreshModels("provider-b");
			expect(refreshed).toEqual(["provider-b"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function model(id: string, enabled = true): ProviderModel {
	return {
		id,
		displayName: id,
		api: "openai-responses",
		input: ["text"],
		reasoning: true,
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		thinkingLevels: ["off", "minimal", "low", "medium", "high"],
		enabled,
	};
}

async function withRegistry(
	run: (context: {
		root: string;
		filename: string;
		vault: SecretVaultCredentialStore;
		open(): Promise<FileProviderRegistryStore>;
		getRuntime(): ModelRuntime;
	}) => Promise<void>,
): Promise<void> {
	const root = join(process.cwd(), ".test-artifacts", `provider-store-${crypto.randomUUID()}`);
	const filename = join(root, "providers.json");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const vault = new SecretVaultCredentialStore(join(root, "credentials", "vault.json"));
	let latestRuntime: ModelRuntime | undefined;
	const open = async (): Promise<FileProviderRegistryStore> => {
		const runtime = await ModelRuntime.create({
			credentials: vault,
			modelsPath: null,
			allowModelNetwork: false,
		});
		latestRuntime = runtime;
		const store = new FileProviderRegistryStore(filename, runtime, vault);
		await store.initialize();
		return store;
	};
	try {
		await run({
			root,
			filename,
			vault,
			open,
			getRuntime() {
				if (latestRuntime === undefined) throw new Error("Registry is not open.");
				return latestRuntime;
			},
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
