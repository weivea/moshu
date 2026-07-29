import { describe, expect, test } from "bun:test";
import {
	companionSourceWatchPaths,
	createElectrobunConfig,
	electrobunWatchIgnorePatterns,
} from "../electrobun.config";

describe("Electrobun config", () => {
	test("disables Electrobun's timestamped signer for default ad-hoc packages", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.mac?.codesign).toBe(false);
		expect(config.build.mac?.notarize).toBe(false);
		expect(config.scripts).toEqual({
			preBuild: "scripts/build-companions.ts",
			postBuild: "scripts/prepare-companion-bundle.ts",
			postPackage: "scripts/verify-mac-package.ts",
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

	test("ignores repository metadata and generated directories outside the desktop root", () => {
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

	test("never enables macOS signing for a packaged non-mac target", () => {
		const config = createElectrobunConfig(
			{ MOSHU_COMPANION_CODESIGN_IDENTITY: "Developer ID Application: Moshu" },
			"linux",
		);
		expect(config.build.mac?.codesign).toBe(false);
	});
});
