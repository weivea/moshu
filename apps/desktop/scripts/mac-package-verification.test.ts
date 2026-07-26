import { describe, expect, test } from "bun:test";
import {
	assertExpectedMacAppArchiveEntries,
	createArtifactDecompressionCommand,
	createArtifactExtractionCommand,
	createArtifactListCommand,
	resolveFinalMacPackagePaths,
} from "./mac-package-verification";

const canaryOptions = {
	buildDirectory: "/workspace/apps/desktop/build/canary-macos-arm64",
	artifactDirectory: "/workspace/apps/desktop/artifacts",
	buildEnvironment: "canary",
	appName: "Moshu-canary",
	targetArch: "arm64",
};

describe("final macOS package verification", () => {
	test("selects the exact artifact present in the postPackage output", () => {
		expect(
			resolveFinalMacPackagePaths({
				...canaryOptions,
				artifactEntries: [
					"canary-macos-arm64-update.json",
					"canary-macos-arm64-Moshu-canary.app.tar.zst",
					"release-win-x64-Moshu-release.tar.zst",
				],
			}),
		).toEqual({
			updateArtifact:
				"/workspace/apps/desktop/artifacts/canary-macos-arm64-Moshu-canary.app.tar.zst",
		});
	});

	test("fails closed on missing, multiple, or unexpected final artifacts", () => {
		expect(() => resolveFinalMacPackagePaths(canaryOptions)).toThrow(
			"Actual Electrobun artifact entries",
		);
		expect(() => resolveFinalMacPackagePaths({ ...canaryOptions, artifactEntries: [] })).toThrow(
			"found none",
		);
		expect(() =>
			resolveFinalMacPackagePaths({
				...canaryOptions,
				artifactEntries: ["canary-macos-arm64-Other.app.tar.zst"],
			}),
		).toThrow("Other.app.tar.zst");
		expect(() =>
			resolveFinalMacPackagePaths({
				...canaryOptions,
				artifactEntries: [
					"canary-macos-arm64-Moshu-canary.app.tar.zst",
					"canary-macos-arm64-Other.app.tar.zst",
				],
			}),
		).toThrow("Other.app.tar.zst");
	});

	test("targets the in-place app only for development builds", () => {
		expect(
			resolveFinalMacPackagePaths({
				...canaryOptions,
				buildDirectory: "/workspace/apps/desktop/build/dev-macos-arm64",
				buildEnvironment: "dev",
				appName: "Moshu-dev",
			}),
		).toEqual({
			appBundle: "/workspace/apps/desktop/build/dev-macos-arm64/Moshu-dev.app",
		});
	});

	test("lists, validates, and extracts the selected artifact without shell interpolation", () => {
		expect(
			createArtifactDecompressionCommand(
				"/electrobun/zig-zstd",
				"/artifacts/final.app.tar.zst",
				"/build/verification/update.tar",
			),
		).toEqual([
			"/electrobun/zig-zstd",
			"decompress",
			"-i",
			"/artifacts/final.app.tar.zst",
			"-o",
			"/build/verification/update.tar",
			"--no-timing",
		]);
		expect(createArtifactListCommand("/build/verification/update.tar")).toEqual([
			"tar",
			"-tf",
			"/build/verification/update.tar",
		]);
		expect(
			createArtifactExtractionCommand(
				"/build/verification/update.tar",
				"/build/verification/extracted",
			),
		).toEqual([
			"tar",
			"-xf",
			"/build/verification/update.tar",
			"-C",
			"/build/verification/extracted",
		]);
		expect(() =>
			assertExpectedMacAppArchiveEntries(
				"Moshu-canary.app/\nMoshu-canary.app/Contents/MacOS/launcher\n",
				"Moshu-canary",
			),
		).not.toThrow();
	});

	test("rejects traversal, absolute paths, extra roots, and an omitted exact app root", () => {
		for (const listing of [
			"Moshu-canary.app/\n../outside",
			"/Moshu-canary.app/",
			"Moshu-canary.app/\nother.txt",
			"Moshu-canary.app/Contents/MacOS/launcher",
			"Moshu-canary.app\\Contents\\MacOS\\launcher",
		]) {
			expect(() => assertExpectedMacAppArchiveEntries(listing, "Moshu-canary")).toThrow();
		}
	});
});
