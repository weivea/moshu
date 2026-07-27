import { describe, expect, test } from "bun:test";
import type { AuthInteraction, AuthType, Credential, Models } from "@earendil-works/pi-ai";

import { HeadlessAuthController } from "../src";

describe("HeadlessAuthController", () => {
	test("returns immediately and translates a secret prompt without echoing its response", async () => {
		let received = "";
		const runtime = {
			async login(
				_providerId: string,
				_type: AuthType,
				interaction: AuthInteraction,
			): Promise<Credential> {
				interaction.notify({ type: "progress", message: "Waiting" });
				received = await interaction.prompt({ type: "secret", message: "API key" });
				return { type: "api_key", key: received };
			},
			async logout(): Promise<void> {},
		} as unknown as Models;
		const controller = new HeadlessAuthController(runtime);
		const started = controller.start({
			schemaVersion: 2,
			providerId: "anthropic",
			authType: "api_key",
		});
		expect(started.attempt.status).toBe("waiting_for_interaction");
		expect(started.attempt.challenge?.type).toBe("secret");
		const challengeId = started.attempt.challenge?.id;
		if (challengeId === undefined) throw new Error("Expected a pending challenge.");
		controller.respond({
			attemptId: started.attempt.id,
			challengeId,
			value: "fake-input-only-secret",
		});
		await Bun.sleep(0);
		const completed = controller.get(started.attempt.id);
		expect(completed.attempt.status).toBe("completed");
		expect(JSON.stringify(completed)).not.toContain("fake-input-only-secret");
		expect(received).toBe("fake-input-only-secret");
	});

	test("forwards every public notification and non-secret prompt variant without interpreting URLs", async () => {
		const responses: string[] = [];
		const models = {
			async login(
				_providerId: string,
				_type: AuthType,
				interaction: AuthInteraction,
			): Promise<Credential> {
				interaction.notify({
					type: "info",
					message: "Choose an account",
					links: [{ url: "https://docs.example.test/auth", label: "Help" }],
				});
				interaction.notify({
					type: "auth_url",
					url: "http://127.0.0.1:8765/callback?state=opaque-provider-state",
					instructions: "Open this URL.",
				});
				interaction.notify({
					type: "device_code",
					userCode: "FAKE-CODE",
					verificationUri: "https://example.test/device",
					intervalSeconds: 5,
					expiresInSeconds: 600,
				});
				interaction.notify({ type: "progress", message: "Waiting for provider" });
				responses.push(await interaction.prompt({ type: "text", message: "Account" }));
				responses.push(
					await interaction.prompt({
						type: "select",
						message: "Tenant",
						options: [{ id: "tenant-a", label: "Tenant A", description: "Primary" }],
					}),
				);
				responses.push(
					await interaction.prompt({
						type: "manual_code",
						message: "Code for a provider that explicitly requests one",
						placeholder: "code",
					}),
				);
				return { type: "oauth", access: "fake", refresh: "fake", expires: Date.now() + 60_000 };
			},
			async logout(): Promise<void> {},
		} as unknown as Models;
		const controller = new HeadlessAuthController(models);
		const started = controller.start({
			schemaVersion: 2,
			providerId: "test-provider",
			authType: "oauth",
		});
		expect(started.attempt.notifications).toEqual([
			{
				type: "info",
				message: "Choose an account",
				links: [{ url: "https://docs.example.test/auth", label: "Help" }],
			},
			{
				type: "auth_url",
				url: "http://127.0.0.1:8765/callback?state=opaque-provider-state",
				instructions: "Open this URL.",
			},
			{
				type: "device_code",
				userCode: "FAKE-CODE",
				verificationUri: "https://example.test/device",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			},
			{ type: "progress", message: "Waiting for provider" },
		]);

		for (const value of ["account", "tenant-a", "manual-code"]) {
			const pending = controller.get(started.attempt.id).attempt.challenge;
			if (pending === undefined) throw new Error("Expected a pending auth challenge.");
			controller.respond({
				attemptId: started.attempt.id,
				challengeId: pending.id,
				value,
			});
			await Bun.sleep(0);
		}
		expect(controller.get(started.attempt.id).attempt.status).toBe("completed");
		expect(responses).toEqual(["account", "tenant-a", "manual-code"]);
	});

	test("does not project provider errors that echo secret input", async () => {
		const diagnostics: unknown[] = [];
		const models = {
			async login(
				_providerId: string,
				_type: AuthType,
				interaction: AuthInteraction,
			): Promise<Credential> {
				const secret = await interaction.prompt({ type: "secret", message: "API key" });
				throw new Error(
					`Rejected secret: ${secret}; {"device_code":"ABCD-EFGH","access_token":"gho_fake-token"}`,
				);
			},
			async logout(): Promise<void> {},
		} as unknown as Models;
		const controller = new HeadlessAuthController(models, {
			reportDiagnostic: (event) => diagnostics.push(event),
		});
		const started = controller.start({
			schemaVersion: 2,
			providerId: "test-provider",
			authType: "api_key",
		});
		const challengeId = started.attempt.challenge?.id;
		if (challengeId === undefined) throw new Error("Expected a pending challenge.");
		controller.respond({
			attemptId: started.attempt.id,
			challengeId,
			value: "fake-never-project-secret",
		});
		await Bun.sleep(0);
		const failed = controller.get(started.attempt.id);
		expect(failed.attempt).toMatchObject({
			status: "failed",
			error: "Authentication failed.",
		});
		expect(JSON.stringify(failed)).not.toContain("fake-never-project-secret");
		expect(JSON.stringify(diagnostics)).not.toContain("fake-never-project-secret");
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				event: "attempt_failed",
				providerId: "test-provider",
				challengeType: "secret",
				error: expect.objectContaining({
					name: "Error",
					message:
						'Rejected secret: [REDACTED]; {"device_code":[REDACTED],"access_token":[REDACTED]}',
				}),
			}),
		);
	});

	test("bounds attempts and notifications, deduplicates active login, and prunes terminal state", async () => {
		let now = 1_000;
		const models = {
			async login(
				_providerId: string,
				_type: AuthType,
				interaction: AuthInteraction,
			): Promise<Credential> {
				for (let index = 0; index < 5; index += 1) {
					interaction.notify({ type: "progress", message: `step-${index}` });
				}
				await interaction.prompt({ type: "text", message: "Continue" });
				return { type: "api_key", key: "fake" };
			},
			async logout(): Promise<void> {},
		} as unknown as Models;
		const controller = new HeadlessAuthController(models, {
			maxAttempts: 1,
			maxNotifications: 2,
			terminalTtlMs: 10,
			now: () => now,
		});
		const first = controller.start({
			schemaVersion: 2,
			providerId: "test-provider",
			authType: "api_key",
		});
		const duplicate = controller.start({
			schemaVersion: 2,
			providerId: "test-provider",
			authType: "api_key",
		});
		expect(duplicate.attempt.id).toBe(first.attempt.id);
		expect(duplicate.attempt.notifications.map((event) => event.type)).toEqual([
			"progress",
			"progress",
		]);
		controller.cancel(first.attempt.id);
		now += 10;
		expect(() => controller.get(first.attempt.id)).toThrow("not found");
	});

	test("cancels provider attempts before logout, invokes credential hooks, and disposes pending login", async () => {
		const calls: string[] = [];
		const models = {
			async login(
				providerId: string,
				_type: AuthType,
				interaction: AuthInteraction,
			): Promise<Credential> {
				calls.push(`login:${providerId}`);
				await interaction.prompt({ type: "secret", message: "Key" });
				return { type: "api_key", key: "fake" };
			},
			async logout(providerId: string): Promise<void> {
				calls.push(`logout:${providerId}`);
			},
		} as unknown as Models;
		const controller = new HeadlessAuthController(models, {
			onCredentialChanged: async (providerId) => {
				calls.push(`changed:${providerId}`);
			},
		});
		const started = controller.start({
			schemaVersion: 2,
			providerId: "test-provider",
			authType: "api_key",
		});
		await controller.logout("test-provider");
		expect(controller.get(started.attempt.id).attempt.status).toBe("cancelled");
		expect(calls).toEqual(["login:test-provider", "logout:test-provider", "changed:test-provider"]);

		const pending = controller.start({
			schemaVersion: 2,
			providerId: "other-provider",
			authType: "api_key",
		});
		await controller.dispose();
		expect(controller.get(pending.attempt.id).attempt.status).toBe("cancelled");
		expect(() =>
			controller.start({
				schemaVersion: 2,
				providerId: "new-provider",
				authType: "api_key",
			}),
		).toThrow("shutting down");
	});
});
