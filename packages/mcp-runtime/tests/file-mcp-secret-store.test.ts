import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMcpSecretStore } from "../src";

describe("FileMcpSecretStore", () => {
	test("uses a persistent private HMAC key for secret-safe idempotency fingerprints", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-secret-fingerprint-"));
		try {
			const store = new FileMcpSecretStore(directory);
			const first = store.fingerprint({
				environment: { B_TOKEN: "second", A_TOKEN: "first" },
			});
			expect(
				store.fingerprint({
					environment: { A_TOKEN: "first", B_TOKEN: "second" },
				}),
			).toBe(first);
			expect(
				store.fingerprint({
					environment: { A_TOKEN: "changed", B_TOKEN: "second" },
				}),
			).not.toBe(first);
			expect(
				new FileMcpSecretStore(directory).fingerprint({
					environment: { A_TOKEN: "first", B_TOKEN: "second" },
				}),
			).toBe(first);
			expect(first).not.toContain("first");
			if (process.platform !== "win32") {
				expect(lstatSync(join(directory, "idempotency.key")).mode & 0o077).toBe(0);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
