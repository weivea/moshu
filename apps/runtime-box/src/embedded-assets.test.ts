import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractEmbeddedRuntimeBoxAssets } from "./embedded-assets";

describe("embedded Runtime Box assets", () => {
	test("verifies and extracts versioned private assets", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-embedded-assets-"));
		try {
			const source = {
				rg: join(directory, "source-rg"),
				fd: join(directory, "source-fd"),
				photonWasm: join(directory, "source.wasm"),
			};
			writeFileSync(source.rg, "rg-binary");
			writeFileSync(source.fd, "fd-binary");
			writeFileSync(source.photonWasm, "wasm-binary");
			const asset = (sourcePath: string, filename: string, executable: boolean) => ({
				sourcePath,
				filename,
				executable,
				sha256: createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
			});
			const extracted = await extractEmbeddedRuntimeBoxAssets(
				{
					rg: asset(source.rg, "rg", true),
					fd: asset(source.fd, "fd", true),
					photonWasm: asset(source.photonWasm, "photon.wasm", false),
				},
				join(directory, "cache"),
			);
			expect(readFileSync(extracted.rg, "utf8")).toBe("rg-binary");
			expect(readFileSync(extracted.fd, "utf8")).toBe("fd-binary");
			expect(readFileSync(extracted.photonWasm, "utf8")).toBe("wasm-binary");
			if (process.platform !== "win32") {
				expect(statSync(extracted.rg).mode & 0o777).toBe(0o700);
				expect(statSync(extracted.photonWasm).mode & 0o777).toBe(0o600);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects an embedded asset whose bytes do not match the compiled hash", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-embedded-assets-bad-"));
		try {
			const source = join(directory, "asset");
			writeFileSync(source, "tampered");
			await expect(
				extractEmbeddedRuntimeBoxAssets(
					{
						rg: { sourcePath: source, filename: "rg", executable: true, sha256: "0".repeat(64) },
						fd: { sourcePath: source, filename: "fd", executable: true, sha256: "0".repeat(64) },
						photonWasm: {
							sourcePath: source,
							filename: "photon.wasm",
							executable: false,
							sha256: "0".repeat(64),
						},
					},
					join(directory, "cache"),
				),
			).rejects.toThrow("SHA-256 verification");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
