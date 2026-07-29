import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function signAndVerifyWindowsBundle(options: {
	bundleDirectory: string;
	certificateSha1: string;
	timestampUrl: string;
	run?: (command: string[]) => void;
}): void {
	const run = options.run ?? runCommand;
	const files = collectWindowsCode(options.bundleDirectory);
	if (files.length === 0) {
		throw new Error(`Stable Windows bundle contains no signable code: ${options.bundleDirectory}`);
	}
	for (const path of files) {
		run(createWindowsSignCommand(path, options.certificateSha1, options.timestampUrl));
		run(["signtool", "verify", "/pa", "/all", path]);
	}
}

export function createWindowsSignCommand(
	path: string,
	certificateSha1: string,
	timestampUrl: string,
): string[] {
	return [
		"signtool",
		"sign",
		"/sha1",
		certificateSha1.replaceAll(" ", ""),
		"/fd",
		"SHA256",
		"/tr",
		timestampUrl,
		"/td",
		"SHA256",
		path,
	];
}

export function signAndVerifyWindowsInstallerArtifact(options: {
	artifactDirectory: string;
	arch: string;
	certificateSha1: string;
	timestampUrl: string;
	run?: (command: string[]) => void;
}): string {
	const archivePath = resolveStableWindowsInstallerArchive(options.artifactDirectory, options.arch);
	const extractionDirectory = mkdtempSync(
		join(options.artifactDirectory, ".moshu-installer-sign-"),
	);
	const run = options.run ?? runCommand;
	try {
		run([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Expand-Archive -LiteralPath ${powershellLiteral(archivePath)} -DestinationPath ${powershellLiteral(extractionDirectory)} -Force`,
		]);
		const entries = readdirSync(extractionDirectory, { withFileTypes: true });
		const installers = entries.filter(
			(entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".exe"),
		);
		const metadataDirectory = entries.find(
			(entry) => entry.name === ".installer" && entry.isDirectory() && !entry.isSymbolicLink(),
		);
		if (installers.length !== 1 || metadataDirectory === undefined) {
			throw new Error("Stable Windows installer ZIP has an unexpected layout.");
		}
		signAndVerifyWindowsBundle({
			bundleDirectory: extractionDirectory,
			certificateSha1: options.certificateSha1,
			timestampUrl: options.timestampUrl,
			run,
		});
		rmSync(archivePath);
		run([
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Compress-Archive -Path ${powershellLiteral(join(extractionDirectory, "*"))} -DestinationPath ${powershellLiteral(archivePath)} -Force`,
		]);
		if (!existsSync(archivePath)) {
			throw new Error("Stable Windows installer ZIP was not recreated after signing.");
		}
		return archivePath;
	} finally {
		rmSync(extractionDirectory, { recursive: true, force: true });
	}
}

export function resolveStableWindowsInstallerArchive(
	artifactDirectory: string,
	arch: string,
): string {
	const prefix = `stable-win-${arch}-`;
	const entries = readdirSync(artifactDirectory, { withFileTypes: true }).filter(
		(entry) =>
			entry.isFile() &&
			!entry.isSymbolicLink() &&
			entry.name.startsWith(prefix) &&
			entry.name.endsWith(".zip"),
	);
	if (entries.length !== 1 || entries[0] === undefined) {
		throw new Error(
			`Expected exactly one stable Windows installer ZIP; found ${
				entries.map((entry) => entry.name).join(", ") || "none"
			}.`,
		);
	}
	return join(artifactDirectory, entries[0].name);
}

function collectWindowsCode(directory: string): string[] {
	const stats = lstatSync(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Windows bundle root must be a real directory: ${directory}`);
	}
	const output: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Windows release bundle must not contain symlinks: ${path}`);
		}
		if (entry.isDirectory()) {
			output.push(...collectWindowsCode(path));
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".exe") || entry.name.endsWith(".dll"))) {
			output.push(path);
		}
	}
	return output.sort();
}

function runCommand(command: string[]): void {
	const result = Bun.spawnSync({
		cmd: command,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(`Windows signing command failed with exit code ${result.exitCode}.`);
	}
}

function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
