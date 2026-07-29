import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	COMPANION_EXECUTABLE_ROLES,
	assertCompanionResourceFilenames,
	getCompanionResourceFilenames,
	getCompanionExecutableFilename,
} from "../src/shared/companion-executable-names";
import {
	assertEmbeddedCompanionEntitlements,
	createCompanionEntitlementsInspectionCommand,
	createMacAppVerificationCommand,
	resolveCompanionCodesignIdentity,
} from "./companion-signing";
import {
	adHocSigningMarkerPath,
	assertAdHocSigningMarker,
	signAndVerifyFinalizedMacApp,
} from "./mac-finalized-app-signing";
import {
	assertExpectedMacAppArchiveEntries,
	createArtifactDecompressionCommand,
	createArtifactExtractionCommand,
	createArtifactListCommand,
	resolveElectrobunZstdPath,
	resolveFinalMacPackagePaths,
} from "./mac-package-verification";
import { verifyPackagedCompanionLaunch } from "./packaged-companion-verification";

await main();

async function main(): Promise<void> {
	const targetOs = requireEnvironment("ELECTROBUN_OS");
	if (targetOs !== "macos") {
		return;
	}

	const buildDirectory = requireEnvironment("ELECTROBUN_BUILD_DIR");
	const artifactDirectory = requireEnvironment("ELECTROBUN_ARTIFACT_DIR");
	const buildEnvironment = requireEnvironment("ELECTROBUN_BUILD_ENV");
	const appName = requireEnvironment("ELECTROBUN_APP_NAME");
	const targetArch = requireEnvironment("ELECTROBUN_ARCH");
	const artifactEntries =
		buildEnvironment === "dev"
			? undefined
			: readRealDirectory(artifactDirectory, "Electrobun artifact output");
	const paths = resolveFinalMacPackagePaths({
		buildDirectory,
		artifactDirectory,
		buildEnvironment,
		appName,
		targetArch,
		artifactEntries,
	});

	if (buildEnvironment === "dev") {
		if (paths.appBundle === undefined) {
			throw new Error("Development package verification did not resolve an app bundle.");
		}
		assertRealDirectory(paths.appBundle, "final macOS development app bundle");
		signAndVerifyFinalizedMacApp(
			paths.appBundle,
			resolveCompanionCodesignIdentity(process.env),
			resolve(import.meta.dir, "..", "companion-entitlements.plist"),
		);
		await verifyCompanionsInApp(paths.appBundle, buildDirectory);
		console.info(`Verified final signed macOS app ${paths.appBundle}.`);
		return;
	}

	if (paths.updateArtifact === undefined) {
		throw new Error("Non-development package verification did not resolve an update artifact.");
	}
	assertRegularFile(paths.updateArtifact, "final Electrobun update artifact");
	const identity = resolveCompanionCodesignIdentity(process.env);
	const sourceTarPath = join(buildDirectory, `${appName}.app.tar`);
	if (identity === "-") {
		assertAdHocSigningMarker(sourceTarPath, `${appName}.app`);
	}
	const verificationDirectory = mkdtempSync(join(buildDirectory, ".moshu-artifact-verification-"));
	let verified = false;
	try {
		const tarPath = join(verificationDirectory, "update.tar");
		const extractedDirectory = join(verificationDirectory, "extracted");
		mkdirSync(extractedDirectory);
		const zstdExecutable = resolveElectrobunZstdPath(resolve(import.meta.dir, ".."), targetArch);
		assertExecutable(zstdExecutable, "Electrobun zstd executable");
		runCommand(
			createArtifactDecompressionCommand(zstdExecutable, paths.updateArtifact, tarPath),
			`Failed to decompress final artifact ${paths.updateArtifact}`,
		);
		const listing = runCommand(
			createArtifactListCommand(tarPath),
			`Failed to inspect final artifact ${paths.updateArtifact}`,
		);
		assertExpectedMacAppArchiveEntries(listing, appName);
		runCommand(
			createArtifactExtractionCommand(tarPath, extractedDirectory),
			`Failed to extract final artifact ${paths.updateArtifact}`,
		);
		const extractedEntries = readdirSync(extractedDirectory, { withFileTypes: true });
		const extractedEntry = extractedEntries[0];
		if (
			extractedEntries.length !== 1 ||
			extractedEntry === undefined ||
			extractedEntry.name !== `${appName}.app` ||
			!extractedEntry.isDirectory() ||
			extractedEntry.isSymbolicLink()
		) {
			throw new Error(
				`Expected exactly one extracted ${appName}.app; found ${
					extractedEntries.map((entry) => entry.name).join(", ") || "nothing"
				}.`,
			);
		}
		const artifactApp = join(extractedDirectory, `${appName}.app`);
		assertRealDirectory(artifactApp, "app embedded in final Electrobun update artifact");
		verifyOuterApp(artifactApp);
		await verifyCompanionsInApp(artifactApp, verificationDirectory);
		if (process.env.MOSHU_STABLE_RELEASE === "1") {
			verifyStableMacDistributionArtifacts(artifactDirectory, artifactEntries ?? [], targetArch);
		}
		verified = true;
		console.info(`Verified final signed macOS update artifact ${paths.updateArtifact}.`);
	} finally {
		rmSync(verificationDirectory, { recursive: true, force: true });
		if (verified && identity === "-") {
			rmSync(adHocSigningMarkerPath(sourceTarPath), { force: true });
		}
	}
}

function verifyOuterApp(appBundle: string): void {
	runCommand(
		createMacAppVerificationCommand(appBundle),
		`Final app signature verification failed for ${appBundle}`,
	);
	if (process.env.MOSHU_STABLE_RELEASE === "1") {
		runCommand(
			["xcrun", "stapler", "validate", appBundle],
			`Notarization staple validation failed for ${appBundle}`,
		);
		runCommand(
			["spctl", "--assess", "--type", "execute", "--verbose=4", appBundle],
			`Gatekeeper rejected ${appBundle}`,
		);
	}
}

function verifyStableMacDistributionArtifacts(
	artifactDirectory: string,
	entries: readonly string[],
	targetArch: string,
): void {
	const prefix = `stable-macos-${targetArch}-`;
	const dmgEntries = entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".dmg"));
	if (dmgEntries.length !== 1 || dmgEntries[0] === undefined) {
		throw new Error(
			`Expected exactly one stable signed DMG; found ${dmgEntries.join(", ") || "none"}.`,
		);
	}
	const dmgPath = join(artifactDirectory, dmgEntries[0]);
	assertRegularFile(dmgPath, "stable macOS DMG");
	runCommand(
		["codesign", "--verify", "--strict", "--verbose=2", dmgPath],
		`Stable DMG signature verification failed for ${dmgPath}`,
	);
	runCommand(
		["xcrun", "stapler", "validate", dmgPath],
		`Stable DMG notarization staple validation failed for ${dmgPath}`,
	);
	runCommand(
		["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", dmgPath],
		`Gatekeeper rejected ${dmgPath}`,
	);
}

async function verifyCompanionsInApp(appBundle: string, scratchParent: string): Promise<void> {
	const companionDirectory = join(appBundle, "Contents", "Resources", "app", "companions");
	const actualResources = readRealDirectory(
		companionDirectory,
		"packaged companion resource directory",
	);
	assertCompanionResourceFilenames(actualResources, "darwin");
	const expectedResources = getCompanionResourceFilenames("darwin");
	for (const filename of expectedResources) {
		assertRegularFile(join(companionDirectory, filename), "packaged companion resource");
	}
	const executables = COMPANION_EXECUTABLE_ROLES.map((role) =>
		join(companionDirectory, getCompanionExecutableFilename(role, "darwin")),
	) as [string, string];
	const toolExecutables: string[] = [];

	for (const executable of executables) {
		assertExecutable(executable, "packaged companion executable");
		runCommand(
			["codesign", "--verify", "--strict", "--verbose=2", executable],
			`Companion signature verification failed for ${executable}`,
		);
		const entitlements = runCommand(
			createCompanionEntitlementsInspectionCommand(executable),
			`Failed to inspect companion entitlements for ${executable}`,
		);
		assertEmbeddedCompanionEntitlements(entitlements, executable);
	}
	for (const executable of toolExecutables) {
		assertExecutable(executable, "packaged Runtime Box tool");
		runCommand(
			["codesign", "--verify", "--strict", "--verbose=2", executable],
			`RuntimeBox tool signature verification failed for ${executable}`,
		);
	}
	await verifyPackagedCompanionLaunch(executables, scratchParent);
}

function assertRegularFile(path: string, description: string): void {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Expected a regular ${description} at ${path}.`);
	}
}

function assertExecutable(path: string, description: string): void {
	assertRegularFile(path, description);
	if ((lstatSync(path).mode & 0o111) === 0) {
		throw new Error(`Expected executable permissions on ${description} at ${path}.`);
	}
}

function assertRealDirectory(path: string, description: string): void {
	const stats = lstatSync(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Expected a real ${description} at ${path}.`);
	}
}

function readRealDirectory(path: string, description: string): string[] {
	assertRealDirectory(path, description);
	return readdirSync(path);
}

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`${name} is required by the macOS package verification hook.`);
	}
	return value;
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
