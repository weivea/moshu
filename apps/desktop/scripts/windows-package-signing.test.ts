import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	createWindowsSignCommand,
	resolveStableWindowsInstallerArchive,
	signAndVerifyWindowsBundle,
	signAndVerifyWindowsInstallerArtifact,
} from "./windows-package-signing";

describe("Windows package signing", () => {
	test("uses Authenticode SHA-256 with an RFC 3161 timestamp", () => {
		expect(
			createWindowsSignCommand(
				"C:\\Moshu\\moshu-runtime-box.exe",
				"AA BB CC DD",
				"https://timestamp.example.test",
			),
		).toEqual([
			"signtool",
			"sign",
			"/sha1",
			"AABBCCDD",
			"/fd",
			"SHA256",
			"/tr",
			"https://timestamp.example.test",
			"/td",
			"SHA256",
			"C:\\Moshu\\moshu-runtime-box.exe",
		]);
	});

	test("signs and verifies every executable and library in the finalized bundle", () => {
		const directory = mkdtempSync(join(process.cwd(), ".windows-signing-test-"));
		try {
			mkdirSync(join(directory, "Resources"));
			writeFileSync(join(directory, "Moshu.exe"), "launcher");
			writeFileSync(join(directory, "Resources", "runtime.dll"), "library");
			writeFileSync(join(directory, "Resources", "readme.txt"), "not code");
			const commands: string[][] = [];
			signAndVerifyWindowsBundle({
				bundleDirectory: directory,
				certificateSha1: "A".repeat(40),
				timestampUrl: "https://timestamp.example.test",
				run: (command) => commands.push(command),
			});
			expect(commands).toHaveLength(4);
			expect(commands.filter((command) => command[1] === "sign")).toHaveLength(2);
			expect(commands.filter((command) => command[1] === "verify")).toHaveLength(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("selects exactly one final stable installer ZIP", () => {
		const directory = mkdtempSync(join(process.cwd(), ".windows-installer-test-"));
		try {
			const expected = join(directory, "stable-win-x64-Moshu.zip");
			writeFileSync(expected, "zip");
			writeFileSync(join(directory, "stable-win-x64-update.json"), "{}");
			expect(resolveStableWindowsInstallerArchive(directory, "x64")).toBe(expected);
			writeFileSync(join(directory, "stable-win-x64-Other.zip"), "zip");
			expect(() => resolveStableWindowsInstallerArchive(directory, "x64")).toThrow("exactly one");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("signs Setup.exe before recreating the final installer ZIP", () => {
		const directory = mkdtempSync(join(process.cwd(), ".windows-installer-sign-test-"));
		const archive = join(directory, "stable-win-x64-Moshu.zip");
		try {
			writeFileSync(archive, "unsigned zip");
			const commands: string[][] = [];
			const result = signAndVerifyWindowsInstallerArtifact({
				artifactDirectory: directory,
				arch: "x64",
				certificateSha1: "A".repeat(40),
				timestampUrl: "https://timestamp.example.test",
				run(command) {
					commands.push(command);
					const script = command.at(-1) ?? "";
					if (script.startsWith("Expand-Archive")) {
						const destination = /-DestinationPath '([^']+)'/.exec(script)?.[1];
						if (destination === undefined) {
							throw new Error("Expected an extraction destination.");
						}
						mkdirSync(join(destination, ".installer"));
						writeFileSync(join(destination, "Moshu Setup.exe"), "unsigned installer");
					}
					if (script.startsWith("Compress-Archive")) {
						writeFileSync(archive, "signed zip");
					}
				},
			});
			expect(result).toBe(archive);
			expect(commands.map((command) => command.slice(0, 2))).toEqual([
				["powershell", "-NoProfile"],
				["signtool", "sign"],
				["signtool", "verify"],
				["powershell", "-NoProfile"],
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
