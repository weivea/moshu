import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	assertExecutorToolAssetSha256,
	assertExecutorToolManifest,
	calculateExecutorToolAssetSha256,
	readExecutorToolManifest,
	resolveExecutorToolTargetKey,
} from "./executor-tool-assets";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("executor tool assets", () => {
	test("pins complete rg and fd metadata for every supported target", () => {
		const manifest = readExecutorToolManifest();
		expect(manifest.tools.rg.version).toBe("15.2.0");
		expect(manifest.tools.fd.version).toBe("10.3.0");
		for (const tool of ["rg", "fd"] as const) {
			expect(Object.keys(manifest.tools[tool].targets).sort()).toEqual([
				"darwin-arm64",
				"darwin-x64",
				"linux-arm64",
				"linux-x64",
				"win32-arm64",
				"win32-x64",
			]);
		}
	});

	test("rejects extra tools and incomplete target maps", () => {
		const manifest = structuredClone(readExecutorToolManifest());
		expect(() =>
			assertExecutorToolManifest({
				...manifest,
				tools: { ...manifest.tools, unexpected: manifest.tools.rg },
			}),
		).toThrow("exactly rg and fd");

		const incomplete = structuredClone(manifest);
		Reflect.deleteProperty(incomplete.tools.fd.targets, "linux-x64");
		expect(() => assertExecutorToolManifest(incomplete)).toThrow("manifest entry fd is invalid");
	});

	test("calculates and enforces the pinned archive SHA-256", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-tool-assets-"));
		temporaryDirectories.push(directory);
		const archive = join(directory, "asset.tar.gz");
		writeFileSync(archive, "fixed archive bytes");
		const expected = createHash("sha256").update("fixed archive bytes").digest("hex");

		expect(calculateExecutorToolAssetSha256(archive)).toBe(expected);
		expect(() => assertExecutorToolAssetSha256(archive, expected)).not.toThrow();
		expect(() => assertExecutorToolAssetSha256(archive, "0".repeat(64), "test asset")).toThrow(
			"SHA-256 mismatch for test asset",
		);
	});

	test("accepts only supported host target keys", () => {
		expect(resolveExecutorToolTargetKey("darwin", "arm64")).toBe("darwin-arm64");
		expect(() => resolveExecutorToolTargetKey("freebsd", "x64")).toThrow(
			"Unsupported executor tool target",
		);
	});
});
