import { describe, expect, test } from "bun:test";
import {
	createFinalizedMacCodesignPlan,
	parseFinalAppTarInvocation,
} from "./mac-finalized-app-signing";

const app = "/workspace/build/canary-macos-arm64/Moshu-canary.app";
const entitlements = "/workspace/apps/desktop/companion-entitlements.plist";

describe("finalized macOS app signing", () => {
	test("signs every nested executable before the outer app without timestamping ad-hoc identity", () => {
		const plan = createFinalizedMacCodesignPlan(app, "-", entitlements);
		expect(plan.nested).toEqual([
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				entitlements,
				`${app}/Contents/Resources/app/companions/moshu-agents-server`,
			],
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				entitlements,
				`${app}/Contents/Resources/app/companions/moshu-executor`,
			],
			["codesign", "--force", "--sign", "-", `${app}/Contents/MacOS/bspatch`],
			[
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				entitlements,
				`${app}/Contents/MacOS/bun`,
			],
			["codesign", "--force", "--sign", "-", `${app}/Contents/MacOS/libNativeWrapper.dylib`],
			["codesign", "--force", "--sign", "-", `${app}/Contents/MacOS/libasar.dylib`],
			["codesign", "--force", "--sign", "-", `${app}/Contents/MacOS/zig-zstd`],
			["codesign", "--force", "--sign", "-", `${app}/Contents/MacOS/launcher`],
		]);
		expect(plan.outer).toEqual(["codesign", "--force", "--sign", "-", app]);
		expect(plan.nested.flat().concat(plan.outer)).not.toContain("--timestamp");
		expect(plan.verify[0]).toEqual([
			"codesign",
			"--verify",
			"--deep",
			"--strict",
			"--verbose=2",
			app,
		]);
	});

	test("uses hardened runtime and timestamps for every Developer ID signature", () => {
		const identity = "Developer ID Application: Moshu (TEAMID)";
		const plan = createFinalizedMacCodesignPlan(app, identity, entitlements);
		expect(plan.nested[0]).toEqual([
			"codesign",
			"--force",
			"--sign",
			identity,
			"--entitlements",
			entitlements,
			"--options",
			"runtime",
			"--timestamp",
			`${app}/Contents/Resources/app/companions/moshu-agents-server`,
		]);
		expect(plan.nested[3]).toEqual([
			"codesign",
			"--force",
			"--options",
			"runtime",
			"--timestamp",
			"--sign",
			identity,
			"--entitlements",
			entitlements,
			`${app}/Contents/MacOS/bun`,
		]);
		expect(plan.outer).toEqual([
			"codesign",
			"--force",
			"--sign",
			identity,
			"--options",
			"runtime",
			"--timestamp",
			app,
		]);
	});

	test("recognizes only Electrobun's finalized app tar invocation", () => {
		expect(
			parseFinalAppTarInvocation(
				["-cf", `${app}.tar`, "Moshu-canary.app"],
				"/workspace/build/canary-macos-arm64",
			),
		).toEqual({
			appPath: app,
			tarPath: `${app}.tar`,
		});
		expect(
			parseFinalAppTarInvocation(
				["-cf", "/workspace/build/canary-macos-arm64/data.tar", "data"],
				"/workspace/build/canary-macos-arm64",
			),
		).toBeUndefined();
		expect(() =>
			parseFinalAppTarInvocation(
				["-cf", "../Moshu-canary.app.tar", "Moshu-canary.app"],
				"/workspace/build/canary-macos-arm64",
			),
		).toThrow("beside the app bundle");
	});
});
