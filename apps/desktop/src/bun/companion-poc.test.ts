import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
	createElectrobunCompanionCopyEntries,
	getCompanionExecutableFilename,
	resolveCurrentHostCompanionPlatform,
} from "../shared/companion-executable-names";
import {
	resolveBundledCompanionExecutables,
	resolveCompanionPocExecutables,
	resolveWorkspaceCompanionExecutables,
} from "./companion-paths";

describe("companion executable platform naming", () => {
	test("uses .exe consistently in Windows build and Electrobun copy paths", () => {
		expect(getCompanionExecutableFilename("agents-server", "win32")).toBe(
			"moshu-agents-server.exe",
		);
		expect(getCompanionExecutableFilename("executor", "win32")).toBe("moshu-executor.exe");
		expect(createElectrobunCompanionCopyEntries("win32")).toEqual({
			"../agents-server/dist/moshu-agents-server.exe": "companions/moshu-agents-server.exe",
			"../executor/dist/moshu-executor.exe": "companions/moshu-executor.exe",
		});
	});

	test("rejects Electrobun cross-target naming instead of using the build host", () => {
		expect(resolveCurrentHostCompanionPlatform("win", "win32")).toBe("win32");
		expect(() => resolveCurrentHostCompanionPlatform("win", "darwin")).toThrow(
			"only supports Electrobun's current build host",
		);
	});
});

describe("resolveBundledCompanionExecutables", () => {
	test("resolves companions from the Electrobun app resources directory", () => {
		const applicationRoot = resolve("test-fixtures", "Moshu.app");
		expect(
			resolveBundledCompanionExecutables(
				resolve(applicationRoot, "Contents", "MacOS", "bun"),
				"darwin",
			),
		).toEqual({
			"agents-server": resolve(
				applicationRoot,
				"Contents",
				"Resources",
				"app",
				"companions",
				"moshu-agents-server",
			),
			executor: resolve(
				applicationRoot,
				"Contents",
				"Resources",
				"app",
				"companions",
				"moshu-executor",
			),
		});
	});

	test("resolves workspace dist binaries for the explicit dev mode", () => {
		const workspaceRoot = resolve("test-fixtures", "workspace");
		expect(resolveWorkspaceCompanionExecutables(workspaceRoot, "darwin")).toEqual({
			"agents-server": resolve(
				workspaceRoot,
				"apps",
				"agents-server",
				"dist",
				"moshu-agents-server",
			),
			executor: resolve(workspaceRoot, "apps", "executor", "dist", "moshu-executor"),
		});
	});

	test("uses Windows filenames for packaged and workspace paths", () => {
		const applicationRoot = resolve("test-fixtures", "Moshu");
		expect(
			resolveBundledCompanionExecutables(resolve(applicationRoot, "Resources", "bun.exe"), "win32"),
		).toEqual({
			"agents-server": resolve(
				applicationRoot,
				"Resources",
				"app",
				"companions",
				"moshu-agents-server.exe",
			),
			executor: resolve(applicationRoot, "Resources", "app", "companions", "moshu-executor.exe"),
		});
		const workspaceRoot = resolve("test-fixtures", "workspace");
		expect(resolveWorkspaceCompanionExecutables(workspaceRoot, "win32")).toEqual({
			"agents-server": resolve(
				workspaceRoot,
				"apps",
				"agents-server",
				"dist",
				"moshu-agents-server.exe",
			),
			executor: resolve(workspaceRoot, "apps", "executor", "dist", "moshu-executor.exe"),
		});
	});

	test("rejects an enabled dev POC without a workspace root", () => {
		expect(() =>
			resolveCompanionPocExecutables({
				packagedEnabled: false,
				devEnabled: true,
				platform: "darwin",
			}),
		).toThrow("use `bun run dev:companions`");
	});
});
