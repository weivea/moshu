import { describe, expect, test } from "bun:test";
import { createElectrobunConfig } from "../electrobun.config";

describe("Electrobun signing hooks", () => {
	test("disables Electrobun's timestamped signer for default ad-hoc packages", () => {
		const config = createElectrobunConfig({}, "darwin");
		expect(config.build.mac?.codesign).toBe(false);
		expect(config.build.mac?.notarize).toBe(false);
		expect(config.scripts).toEqual({
			postBuild: "scripts/prepare-companion-bundle.ts",
			postPackage: "scripts/verify-mac-package.ts",
		});
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
