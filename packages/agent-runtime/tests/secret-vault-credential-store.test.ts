import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SecretVaultCredentialStore } from "../src";

describe("SecretVaultCredentialStore", () => {
	test("preserves slow and fast writes to different providers across store instances", async () => {
		await withVault(async ({ path }) => {
			const first = new SecretVaultCredentialStore(path);
			const second = new SecretVaultCredentialStore(path);
			const callbackStarted = Promise.withResolvers<void>();
			const releaseCallback = Promise.withResolvers<void>();
			const slow = first.modify("provider-a", async () => {
				callbackStarted.resolve();
				await releaseCallback.promise;
				return { type: "api_key", key: "fake-a" };
			});
			await callbackStarted.promise;

			await second.modify("provider-b", async () => ({ type: "api_key", key: "fake-b" }));
			releaseCallback.resolve();
			await slow;

			expect(await first.read("provider-a")).toEqual({ type: "api_key", key: "fake-a" });
			expect(await second.read("provider-b")).toEqual({ type: "api_key", key: "fake-b" });
		});
	});

	test("does not resurrect a deleted provider when another provider commits later", async () => {
		await withVault(async ({ path }) => {
			const first = new SecretVaultCredentialStore(path);
			const second = new SecretVaultCredentialStore(path);
			await first.modify("provider-a", async () => ({ type: "api_key", key: "fake-a" }));
			const callbackStarted = Promise.withResolvers<void>();
			const releaseCallback = Promise.withResolvers<void>();
			const slow = first.modify("provider-b", async () => {
				callbackStarted.resolve();
				await releaseCallback.promise;
				return { type: "api_key", key: "fake-b" };
			});
			await callbackStarted.promise;

			await second.delete("provider-a");
			releaseCallback.resolve();
			await slow;

			expect(await first.read("provider-a")).toBeUndefined();
			expect(await first.read("provider-b")).toEqual({ type: "api_key", key: "fake-b" });
		});
	});

	test("serializes the full async callback for the same provider across store instances", async () => {
		await withVault(async ({ path }) => {
			const first = new SecretVaultCredentialStore(path);
			const second = new SecretVaultCredentialStore(path);
			const callbackStarted = Promise.withResolvers<void>();
			const releaseCallback = Promise.withResolvers<void>();
			let secondCallbackStarted = false;
			const slow = first.modify("anthropic", async () => {
				callbackStarted.resolve();
				await releaseCallback.promise;
				return { type: "api_key", key: "fake-first" };
			});
			await callbackStarted.promise;
			const queued = second.modify("anthropic", async (current) => {
				secondCallbackStarted = true;
				return {
					type: "api_key",
					key: `${current?.type === "api_key" ? current.key : ""}-second`,
				};
			});
			await Bun.sleep(20);
			expect(secondCallbackStarted).toBe(false);

			releaseCallback.resolve();
			await Promise.all([slow, queued]);
			expect(await first.read("anthropic")).toEqual({
				type: "api_key",
				key: "fake-first-second",
			});
		});
	});

	test("uses restrictive permissions, atomic storage, and secret-free parse errors", async () => {
		await withVault(async ({ root, path }) => {
			const vault = new SecretVaultCredentialStore(path);
			await vault.modify("anthropic", async () => ({
				type: "api_key",
				key: "fake-permission-secret",
			}));
			expect(await vault.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(join(root, "credentials")).mode & 0o777).toBe(0o700);
			expect(statSync(join(root, "credentials", ".provider-locks")).mode & 0o777).toBe(0o700);
			expect(readFileSync(path, "utf8")).not.toContain("undefined");

			writeFileSync(path, '{"provider":{"key":"fake-never-log-secret"', { mode: 0o600 });
			const error = await vault.read("anthropic").catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toContain("fake-never-log-secret");
		});
	});

	test("preserves custom secret header metadata when API-key login replaces only the key", async () => {
		await withVault(async ({ path }) => {
			const vault = new SecretVaultCredentialStore(path);
			await vault.modify("custom-provider", async () => ({
				type: "api_key",
				key: "fake-old",
				env: { "X-Private": "fake-header-secret" },
			}));
			await vault.modify("custom-provider", async () => ({
				type: "api_key",
				key: "fake-replacement",
			}));
			expect(await vault.read("custom-provider")).toEqual({
				type: "api_key",
				key: "fake-replacement",
				env: { "X-Private": "fake-header-secret" },
			});
		});
	});
});

async function withVault(
	run: (paths: { root: string; path: string }) => Promise<void>,
): Promise<void> {
	const root = join(process.cwd(), ".test-artifacts", `vault-${crypto.randomUUID()}`);
	const path = join(root, "credentials", "vault.json");
	mkdirSync(root, { recursive: true });
	try {
		await run({ root, path });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
