import { chmodSync, constants, readdirSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	COMPANION_EXECUTABLE_ROLES,
	getCompanionExecutableFilename,
	getExecutorToolExecutableFilenames,
	resolveCurrentHostCompanionPlatform,
} from "../src/shared/companion-executable-names";
import {
	assertEmbeddedCompanionEntitlements,
	createBundledToolCodesignCommand,
	createCompanionCodesignCommand,
	createCompanionEntitlementsInspectionCommand,
	resolveCompanionCodesignIdentity,
} from "./companion-signing";
import { verifyPackagedCompanionLaunch } from "./packaged-companion-verification";

const buildDirectory = requireEnvironment("ELECTROBUN_BUILD_DIR");
const targetOs = requireEnvironment("ELECTROBUN_OS");
const targetPlatform = resolveCurrentHostCompanionPlatform(targetOs, process.platform);
const companionDirectory = findCompanionDirectory(buildDirectory, targetPlatform);
const signingIdentity = resolveCompanionCodesignIdentity(process.env);
const companionEntitlementsPath = resolve(import.meta.dir, "..", "companion-entitlements.plist");
const executables = COMPANION_EXECUTABLE_ROLES.map((role) =>
	join(companionDirectory, getCompanionExecutableFilename(role, targetPlatform)),
);
const toolExecutables = getExecutorToolExecutableFilenames(targetPlatform).map((filename) =>
	join(companionDirectory, filename),
);

for (const executable of [...executables, ...toolExecutables]) {
	if (targetPlatform !== "win32") {
		chmodSync(executable, 0o755);
	}
	await access(executable, targetPlatform === "win32" ? constants.F_OK : constants.X_OK);
	if (!statSync(executable).isFile()) {
		throw new Error(`Bundled companion is not a regular file: ${executable}`);
	}
	if (targetPlatform === "darwin") {
		if (toolExecutables.includes(executable)) {
			signMacToolExecutable(executable, signingIdentity);
		} else {
			await access(companionEntitlementsPath, constants.R_OK);
			signMacExecutable(executable, signingIdentity, companionEntitlementsPath);
		}
		verifyMacExecutable(executable);
		if (!toolExecutables.includes(executable)) {
			verifyMacEntitlements(executable);
		}
	}
}
if (targetPlatform !== "darwin") {
	await verifyPackagedCompanionLaunch(executables as [string, string], buildDirectory);
}

console.info(
	`Prepared ${executables.length} companion and ${toolExecutables.length} tool executables in ${companionDirectory}` +
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

function signMacExecutable(executable: string, identity: string, entitlementsPath: string): void {
	runCommand(
		createCompanionCodesignCommand({ executable, identity, entitlementsPath }),
		`Failed to sign companion executable ${executable}`,
	);
}

function signMacToolExecutable(executable: string, identity: string): void {
	runCommand(
		createBundledToolCodesignCommand(executable, identity),
		`Failed to sign bundled executor tool ${executable}`,
	);
}

function verifyMacExecutable(executable: string): void {
	runCommand(
		["codesign", "--verify", "--strict", "--verbose=2", executable],
		`Companion signature verification failed for ${executable}`,
	);
}

function verifyMacEntitlements(executable: string): void {
	const output = runCommand(
		createCompanionEntitlementsInspectionCommand(executable),
		`Failed to inspect companion entitlements for ${executable}`,
	);
	assertEmbeddedCompanionEntitlements(output, executable);
}

function runCommand(command: string[], failureMessage: string): string {
	const result = Bun.spawnSync({
		cmd: command,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`${failureMessage}: ${stderr || `exit code ${result.exitCode}`}`);
	}
	return `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
}
