import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { createProviderAuthDiagnosticLog } from "./provider-auth-diagnostic-log";

describe("createProviderAuthDiagnosticLog", () => {
	test("writes restrictive JSONL and rotates a bounded log", () => {
		const root = join(process.cwd(), ".test-artifacts", `auth-log-${crypto.randomUUID()}`);
		const filename = join(root, "diagnostics", "provider-auth.jsonl");
		mkdirSync(root, { recursive: true });
		try {
			const write = createProviderAuthDiagnosticLog(filename, {
				maxBytes: 300,
				now: () => new Date("2026-07-27T12:00:00.000Z"),
			});
			for (let index = 0; index < 4; index += 1) {
				write({
					event: "provider_notification",
					providerId: "github-copilot",
					authType: "oauth",
					notificationType: "device_code",
				});
			}

			expect(statSync(join(root, "diagnostics")).mode & 0o777).toBe(0o700);
			expect(statSync(filename).mode & 0o777).toBe(0o600);
			expect(statSync(`${filename}.previous`).mode & 0o777).toBe(0o600);
			expect(readFileSync(filename, "utf8")).toContain('"providerId":"github-copilot"');
			expect(readFileSync(filename, "utf8")).not.toContain("DEVICE-CODE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("recreates a log cleared while the server is running", () => {
		const root = join(process.cwd(), ".test-artifacts", `auth-log-${crypto.randomUUID()}`);
		const filename = join(root, "diagnostics", "provider-auth.jsonl");
		mkdirSync(root, { recursive: true });
		try {
			const write = createProviderAuthDiagnosticLog(filename);
			rmSync(filename);
			write({
				event: "attempt_started",
				attemptId: crypto.randomUUID(),
				providerId: "github-copilot",
				authType: "oauth",
			});

			expect(statSync(filename).mode & 0o777).toBe(0o600);
			expect(readFileSync(filename, "utf8")).toContain('"event":"attempt_started"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
