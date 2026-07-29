import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { moshuReleaseVersion } from "@moshu/contracts";
import {
	COMPANION_EXECUTABLE_ROLES,
	companionReleaseManifestFilename,
	getCompanionExecutableFilename,
} from "../src/shared/companion-executable-names";
import {
	verifyCompanionReleaseManifest,
	writeCompanionReleaseManifest,
} from "./companion-release-manifest";
import { createNoSystemRuntimeEnvironment } from "./packaged-companion-verification";

describe("companion release manifest", () => {
	test("keeps the desktop and both companion package versions in one release", () => {
		const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
		for (const path of [
			"package.json",
			"apps/desktop/package.json",
			"apps/agents-server/package.json",
			"apps/runtime-box/package.json",
		]) {
			const manifest = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
			expect(manifest.version).toBe(moshuReleaseVersion);
		}
	});

	test("launch verification removes system Bun and Node discovery paths", () => {
		expect(
			createNoSystemRuntimeEnvironment(
				{
					HOME: "/home/test",
					PATH: "/usr/local/bin:/usr/bin",
					BUN_INSTALL: "/home/test/.bun",
					NODE_PATH: "/opt/node_modules",
				},
				"linux",
			),
		).toEqual({
			HOME: "/home/test",
			PATH: "/moshu-no-system-runtime",
		});
	});

	test("binds both packaged companions to the release and protocol versions", () => {
		const directory = createCompanionDirectory();
		try {
			writeCompanionReleaseManifest(directory, process.platform);
			expect(() => verifyCompanionReleaseManifest(directory, process.platform)).not.toThrow();
			const manifest = JSON.parse(
				readFileSync(join(directory, companionReleaseManifestFilename), "utf8"),
			);
			expect(manifest.releaseVersion).toBe(moshuReleaseVersion);
			expect(manifest.companions).toHaveLength(2);
			expect(manifest.protocols.runtimeBox).toEqual({ current: 1, min: 1, max: 1 });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects a companion changed after the manifest was generated", () => {
		const directory = createCompanionDirectory();
		try {
			writeCompanionReleaseManifest(directory, process.platform);
			writeFileSync(
				join(directory, getCompanionExecutableFilename("runtime-box", process.platform)),
				"tampered",
			);
			expect(() => verifyCompanionReleaseManifest(directory, process.platform)).toThrow(
				"Packaged companion hash mismatch",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects a manifest from a different release", () => {
		const directory = createCompanionDirectory();
		try {
			const manifestPath = writeCompanionReleaseManifest(directory, process.platform);
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.releaseVersion = "99.0.0";
			writeFileSync(manifestPath, JSON.stringify(manifest));
			expect(() => verifyCompanionReleaseManifest(directory, process.platform)).toThrow(
				"does not match desktop version",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function createCompanionDirectory(): string {
	const directory = mkdtempSync(join(process.cwd(), ".companion-manifest-test-"));
	for (const role of COMPANION_EXECUTABLE_ROLES) {
		writeFileSync(join(directory, getCompanionExecutableFilename(role, process.platform)), role);
	}
	return directory;
}
