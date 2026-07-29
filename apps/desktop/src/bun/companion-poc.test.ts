import { describe, expect, test } from "bun:test";
import { posix, resolve, win32 } from "node:path";

import {
	assertCompanionResourceFilenames,
	createElectrobunCompanionCopyEntries,
	getCompanionExecutableFilename,
	resolveCurrentHostCompanionPlatform,
} from "../shared/companion-executable-names";
import {
	isPackagedCompanionExecution,
	resolveBundledCompanionExecutables,
	resolveCompanionExecutableSource,
	resolveCompanionExecutables,
	resolveWorkspaceCompanionExecutables,
} from "./companion-paths";
import { assertCompanionExecutablesAvailable } from "./companion-poc";

describe("companion executable platform naming", () => {
	test("uses .exe consistently in Windows build and Electrobun copy paths", () => {
		expect(getCompanionExecutableFilename("agents-server", "win32")).toBe(
			"moshu-agents-server.exe",
		);
		expect(getCompanionExecutableFilename("runtime-box", "win32")).toBe("moshu-runtime-box.exe");
		expect(createElectrobunCompanionCopyEntries("win32")).toEqual({
			"../agents-server/dist/moshu-agents-server.exe": "companions/moshu-agents-server.exe",
			"../runtime-box/dist/moshu-runtime-box.exe": "companions/moshu-runtime-box.exe",
		});
	});

	test("rejects Electrobun cross-target naming instead of using the build host", () => {
		expect(resolveCurrentHostCompanionPlatform("win", "win32")).toBe("win32");
		expect(() => resolveCurrentHostCompanionPlatform("win", "darwin")).toThrow(
			"only supports Electrobun's current build host",
		);
	});

	test("packages only the two self-contained companions", () => {
		expect(() =>
			assertCompanionResourceFilenames(["moshu-runtime-box", "moshu-agents-server"], "darwin"),
		).not.toThrow();
		expect(() =>
			assertCompanionResourceFilenames(
				["moshu-runtime-box", "moshu-agents-server", "extra"],
				"darwin",
			),
		).toThrow("Unexpected Moshu companion resource layout");
	});
});

describe("resolveBundledCompanionExecutables", () => {
	test("resolves companions from the Electrobun app resources directory", () => {
		const applicationRoot = posix.resolve("test-fixtures", "Moshu.app");
		expect(
			resolveBundledCompanionExecutables(
				posix.join(applicationRoot, "Contents/MacOS/bun"),
				"darwin",
			),
		).toEqual({
			"agents-server": posix.resolve(
				applicationRoot,
				"Contents",
				"Resources",
				"app",
				"companions",
				"moshu-agents-server",
			),
			"runtime-box": posix.resolve(
				applicationRoot,
				"Contents",
				"Resources",
				"app",
				"companions",
				"moshu-runtime-box",
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
			"runtime-box": resolve(workspaceRoot, "apps", "runtime-box", "dist", "moshu-runtime-box"),
		});
	});

	test("uses Windows filenames for packaged and workspace paths", () => {
		const applicationRoot = win32.resolve("C:\\test-fixtures\\Moshu");
		expect(
			resolveBundledCompanionExecutables(win32.join(applicationRoot, "bin", "bun.exe"), "win32"),
		).toEqual({
			"agents-server": win32.resolve(
				applicationRoot,
				"Resources",
				"app",
				"companions",
				"moshu-agents-server.exe",
			),
			"runtime-box": win32.resolve(
				applicationRoot,
				"Resources",
				"app",
				"companions",
				"moshu-runtime-box.exe",
			),
		});
		const workspaceRoot = win32.resolve("C:\\test-fixtures\\workspace");
		expect(resolveWorkspaceCompanionExecutables(workspaceRoot, "win32")).toEqual({
			"agents-server": win32.resolve(
				workspaceRoot,
				"apps",
				"agents-server",
				"dist",
				"moshu-agents-server.exe",
			),
			"runtime-box": win32.resolve(
				workspaceRoot,
				"apps",
				"runtime-box",
				"dist",
				"moshu-runtime-box.exe",
			),
		});
	});

	test("uses bundled companions when no workspace root is supplied", () => {
		const executablePath = posix.resolve("test-fixtures", "Moshu.app", "Contents", "MacOS", "bun");
		expect(
			resolveCompanionExecutables({
				executablePath,
				platform: "darwin",
			}),
		).toEqual(resolveBundledCompanionExecutables(executablePath, "darwin"));
	});

	test.each([
		["macOS", posix.resolve("test-fixtures", "Moshu.app", "Contents", "MacOS", "bun"), "darwin"],
		["Windows", win32.resolve("C:\\test-fixtures\\Moshu\\bin\\bun.exe"), "win32"],
		["Linux", posix.resolve("/opt/Moshu/bin/bun"), "linux"],
	] as const)(
		"ignores the workspace override in a packaged %s runtime",
		(_name, executablePath, platform) => {
			const workspaceRoot = resolve("external", "unverified-workspace");
			const options = {
				workspaceRoot,
				executablePath,
				platform,
			};

			expect(isPackagedCompanionExecution(executablePath, platform)).toBe(true);
			expect(resolveCompanionExecutableSource(options)).toBe("bundled");
			expect(resolveCompanionExecutables(options)).toEqual(
				resolveBundledCompanionExecutables(executablePath, platform),
			);
		},
	);

	test.each([
		["macOS", resolve("tools", "bun"), "darwin"],
		["Windows", "C:\\tools\\bun.exe", "win32"],
		["Linux", "/usr/local/bin/bun", "linux"],
		["Linux user install", "/home/developer/.bun/bin/bun", "linux"],
		["Windows project install", "C:\\work\\project\\bin\\bun.exe", "win32"],
	] as const)(
		"honors an explicit workspace override only in unpackaged %s development",
		(_name, executablePath, platform) => {
			const workspaceRoot = resolve("test-fixtures", "workspace");
			const options = { workspaceRoot, executablePath, platform };

			expect(isPackagedCompanionExecution(executablePath, platform)).toBe(false);
			expect(resolveCompanionExecutableSource(options)).toBe("workspace");
			expect(resolveCompanionExecutables(options)).toEqual(
				resolveWorkspaceCompanionExecutables(workspaceRoot, platform),
			);
		},
	);

	test.each([
		[
			"Windows",
			"C:\\ExampleBundle\\bin\\bun.exe",
			"win32",
			"C:\\ExampleBundle\\Resources\\main.js",
		],
		["Linux", "/opt/ExampleBundle/bin/bun", "linux", "/opt/ExampleBundle/Resources/main.js"],
	] as const)(
		"requires the exact Electrobun %s bundle marker",
		(_name, executablePath, platform, expectedMarker) => {
			const inspected: string[] = [];
			expect(
				isPackagedCompanionExecution(executablePath, platform, (filename) => {
					inspected.push(filename);
					return filename === expectedMarker;
				}),
			).toBe(true);
			expect(inspected).toEqual([expectedMarker]);
			expect(isPackagedCompanionExecution(executablePath, platform, () => false)).toBe(false);
		},
	);

	test.each([
		["stable Windows", "C:\\Program Files\\Moshu\\bin\\bun.exe", "win32"],
		["canary Windows", "C:\\Program Files\\Moshu-canary\\bin\\BUN.EXE", "win32"],
		["development Linux", "/opt/Moshu-dev/bin/bun", "linux"],
		["renamed macOS", "/Applications/Local Moshu.app/Contents/MacOS/bun", "darwin"],
	] as const)(
		"recognizes the real %s layout even when bundle metadata is unavailable",
		(_name, executablePath, platform) => {
			expect(isPackagedCompanionExecution(executablePath, platform, () => false)).toBe(true);
		},
	);

	test("reports a missing bundled executable without exposing its path", async () => {
		const executables = {
			"agents-server": resolve("private", "signed", "moshu-agents-server"),
			"runtime-box": resolve("private", "signed", "moshu-runtime-box"),
		};
		const error = await assertCompanionExecutablesAvailable(
			executables,
			"bundled",
			async (filename) => {
				throw new Error(`ENOENT: ${filename}`);
			},
		).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Bundled agents-server companion is missing or not executable.",
		);
		expect((error as Error).message).not.toContain(executables["agents-server"]);
	});

	test("keeps packaged missing-companion diagnostics bundled despite a workspace override", async () => {
		const executablePath = win32.resolve("C:\\Program Files\\Moshu\\bin\\bun.exe");
		const options = {
			workspaceRoot: win32.resolve("C:\\unverified\\workspace"),
			executablePath,
			platform: "win32" as const,
			bundleMarkerExists: () => true,
		};
		const source = resolveCompanionExecutableSource(options);
		const executables = resolveCompanionExecutables(options);

		expect(source).toBe("bundled");
		expect(executables).toEqual(resolveBundledCompanionExecutables(executablePath, "win32"));
		await expect(
			assertCompanionExecutablesAvailable(executables, source, async () => {
				throw new Error("missing");
			}),
		).rejects.toThrow("Bundled agents-server companion is missing or not executable.");
	});
});
