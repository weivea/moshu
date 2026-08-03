import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
	companionSourceWatchPaths,
	createElectrobunConfig,
	electrobunWatchIgnorePatterns,
} from "../electrobun.config";
import { stagedThirdPartyNoticesSource } from "./stage-package-resources";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");

function isWithin(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function resolveConfiguredWatchDirectories(
	config: ReturnType<typeof createElectrobunConfig>,
): string[] {
	const copyDirectories = Object.keys(config.build.copy ?? {}).map((source) => {
		const sourcePath = resolve(desktopRoot, source);
		try {
			return statSync(sourcePath).isDirectory() ? sourcePath : dirname(sourcePath);
		} catch {
			return dirname(sourcePath);
		}
	});
	const explicitDirectories = (config.build.watch ?? []).map((path) => resolve(desktopRoot, path));
	return [...copyDirectories, ...explicitDirectories];
}

describe("Electrobun config", () => {
	test("disables Electrobun's timestamped signer for default ad-hoc packages", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.mac?.codesign).toBe(false);
		expect(config.build.mac?.notarize).toBe(false);
		expect(config.scripts).toEqual({
			preBuild: "scripts/build-companions.ts",
			postBuild: "scripts/prepare-companion-bundle.ts",
			postPackage: "scripts/post-package.ts",
		});
	});

	test("rebuilds the desktop app when companion sources change", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.watch).toEqual(companionSourceWatchPaths);
		expect(config.build.watch).toEqual([
			"../agents-server/src",
			"../runtime-box/src",
			"../../packages/agent-runtime/src",
			"../../packages/contracts/src",
			"../../packages/database/src",
			"../../packages/process-rpc/src",
		]);
	});

	test("does not watch unrelated repository files through package copy sources", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.copy).toMatchObject({
			[stagedThirdPartyNoticesSource]: "licenses/THIRD_PARTY_NOTICES.txt",
		});
		expect(config.build.copy).not.toHaveProperty("../../THIRD_PARTY_NOTICES.txt");

		const watchDirectories = resolveConfiguredWatchDirectories(config);
		expect(
			watchDirectories.some((directory) =>
				isWithin(resolve(repositoryRoot, "README.md"), directory),
			),
		).toBe(false);
		expect(
			watchDirectories.some((directory) =>
				isWithin(resolve(repositoryRoot, "packages/contracts/src/index.ts"), directory),
			),
		).toBe(true);
	});

	test("ignores generated directories within configured watch roots", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.watchIgnore).toEqual(electrobunWatchIgnorePatterns);
		const ignores = electrobunWatchIgnorePatterns.map((pattern) => new Bun.Glob(pattern));
		for (const path of [
			"/repo/.git/fsmonitor--daemon/cookies/38344-74",
			"/repo/node_modules/.cache/dependency",
			"/repo/.cache/executor-tools/rg",
			"/repo/apps/agents-server/dist/moshu-agents-server",
			"/repo/apps/desktop/build/dev-macos-arm64/Moshu-dev.app",
			"/repo/apps/desktop/artifacts/update.json",
			"/repo/packages/contracts/coverage/report.json",
		]) {
			expect(ignores.some((glob) => glob.match(path))).toBe(true);
		}
		expect(ignores.some((glob) => glob.match("/repo/packages/contracts/src/index.ts"))).toBe(false);
	});

	test("uses the companion Developer ID for Electrobun's hardened outer signing", () => {
		const identity = "Developer ID Application: Moshu (TEAMID)";
		const config = createElectrobunConfig(
			{ MOSHU_COMPANION_CODESIGN_IDENTITY: identity },
			"darwin",
		);
		expect(config.build.mac?.codesign).toBe(true);
		expect(config.build.mac?.notarize).toBe(false);
	});

	test("enables notarization, DMG output, and the release origin only for stable builds", () => {
		const config = createElectrobunConfig(
			{
				MOSHU_STABLE_RELEASE: "1",
				MOSHU_APP_IDENTIFIER: "com.example.moshu",
				MOSHU_RELEASE_BASE_URL: "https://updates.example.test/moshu",
				ELECTROBUN_DEVELOPER_ID: "Developer ID Application: Moshu (TEAMID)",
			},
			"darwin",
		);
		expect(config.app.identifier).toBe("com.example.moshu");
		expect(config.build.mac).toMatchObject({
			codesign: true,
			notarize: true,
			createDmg: true,
		});
		expect(config.release.baseUrl).toBe("https://updates.example.test/moshu");
	});

	test("never enables macOS signing for a packaged non-mac target", () => {
		const config = createElectrobunConfig(
			{ MOSHU_COMPANION_CODESIGN_IDENTITY: "Developer ID Application: Moshu" },
			"linux",
		);
		expect(config.build.mac?.codesign).toBe(false);
	});
});
