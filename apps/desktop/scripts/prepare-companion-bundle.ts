import { chmodSync, constants, readdirSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import {
	COMPANION_EXECUTABLE_ROLES,
	getCompanionExecutableFilename,
	resolveCurrentHostCompanionPlatform,
} from "../src/shared/companion-executable-names";

const buildDirectory = requireEnvironment("ELECTROBUN_BUILD_DIR");
const targetOs = requireEnvironment("ELECTROBUN_OS");
const targetPlatform = resolveCurrentHostCompanionPlatform(targetOs, process.platform);
const companionDirectory = findCompanionDirectory(buildDirectory, targetPlatform);
const signingIdentity =
	process.env.MOSHU_COMPANION_CODESIGN_IDENTITY?.trim() ||
	process.env.ELECTROBUN_DEVELOPER_ID?.trim() ||
	"-";
const executables = COMPANION_EXECUTABLE_ROLES.map((role) =>
	join(companionDirectory, getCompanionExecutableFilename(role, targetPlatform)),
);

for (const executable of executables) {
	if (targetPlatform !== "win32") {
		chmodSync(executable, 0o755);
	}
	await access(executable, targetPlatform === "win32" ? constants.F_OK : constants.X_OK);
	if (!statSync(executable).isFile()) {
		throw new Error(`Bundled companion is not a regular file: ${executable}`);
	}
	if (targetPlatform === "darwin") {
		signMacExecutable(executable, signingIdentity);
		verifyMacExecutable(executable);
	}
}

console.info(
	`Prepared ${executables.length} companion executables in ${companionDirectory}` +
		(targetPlatform === "darwin"
			? ` with ${signingIdentity === "-" ? "ad-hoc" : "configured identity"} signatures.`
			: "."),
);

function findCompanionDirectory(buildDirectory: string, targetPlatform: NodeJS.Platform): string {
	for (const entry of readdirSync(buildDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const resources =
			targetPlatform === "darwin"
				? join(buildDirectory, entry.name, "Contents", "Resources")
				: join(buildDirectory, entry.name, "Resources");
		const candidate = join(resources, "app", "companions");
		try {
			if (statSync(candidate).isDirectory()) {
				return candidate;
			}
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
		}
	}
	throw new Error(`Electrobun companion directory was not found under ${buildDirectory}.`);
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`${name} is required by the companion packaging hook.`);
	}
	return value;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function signMacExecutable(executable: string, identity: string): void {
	const command = ["codesign", "--force", "--sign", identity];
	if (identity !== "-") {
		command.push("--options", "runtime", "--timestamp");
	}
	command.push(executable);
	runCommand(command, `Failed to sign companion executable ${executable}`);
}

function verifyMacExecutable(executable: string): void {
	runCommand(
		["codesign", "--verify", "--strict", "--verbose=2", executable],
		`Companion signature verification failed for ${executable}`,
	);
}

function runCommand(command: string[], failureMessage: string): void {
	const result = Bun.spawnSync({
		cmd: command,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`${failureMessage}: ${stderr || `exit code ${result.exitCode}`}`);
	}
}
