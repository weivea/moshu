import { join, resolve } from "node:path";

interface FinalMacPackageOptions {
	buildDirectory: string;
	artifactDirectory: string;
	buildEnvironment: string;
	appName: string;
	targetArch: string;
	artifactEntries?: readonly string[];
}

export function expectedFinalMacUpdateArtifactName(
	options: Pick<FinalMacPackageOptions, "buildEnvironment" | "appName" | "targetArch">,
): string {
	return `${options.buildEnvironment}-macos-${options.targetArch}-${options.appName}.app.tar.zst`;
}

export function resolveFinalMacPackagePaths(options: FinalMacPackageOptions): {
	appBundle?: string;
	updateArtifact?: string;
} {
	if (options.buildEnvironment === "dev") {
		return { appBundle: join(options.buildDirectory, `${options.appName}.app`) };
	}
	if (options.artifactEntries === undefined) {
		throw new Error("Actual Electrobun artifact entries are required for non-development builds.");
	}
	const expectedName = expectedFinalMacUpdateArtifactName(options);
	const scopedPrefix = `${options.buildEnvironment}-macos-${options.targetArch}-`;
	const candidates = options.artifactEntries.filter(
		(entry) => entry.startsWith(scopedPrefix) && entry.endsWith(".app.tar.zst"),
	);
	if (candidates.length !== 1 || candidates[0] !== expectedName) {
		throw new Error(
			`Expected exactly ${expectedName} in Electrobun's artifact output; found ${candidates.join(", ") || "none"}.`,
		);
	}
	return { updateArtifact: join(options.artifactDirectory, candidates[0]) };
}

export function resolveElectrobunZstdPath(desktopDirectory: string, targetArch: string): string {
	return resolve(
		desktopDirectory,
		"node_modules",
		"electrobun",
		`dist-macos-${targetArch}`,
		"zig-zstd",
	);
}

export function createArtifactDecompressionCommand(
	zstdExecutable: string,
	artifact: string,
	tarPath: string,
): string[] {
	return [zstdExecutable, "decompress", "-i", artifact, "-o", tarPath, "--no-timing"];
}

export function createArtifactListCommand(tarPath: string): string[] {
	return ["tar", "-tf", tarPath];
}

export function createArtifactExtractionCommand(tarPath: string, destination: string): string[] {
	return ["tar", "-xf", tarPath, "-C", destination];
}

export function assertExpectedMacAppArchiveEntries(listing: string, appName: string): void {
	const expectedRoot = `${appName}.app`;
	let foundRoot = false;
	const entries = listing
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) {
		throw new Error("Final Electrobun update archive is empty.");
	}
	for (const rawEntry of entries) {
		if (rawEntry.includes("\\") || rawEntry.startsWith("/")) {
			throw new Error(`Unsafe path in final Electrobun update archive: ${rawEntry}`);
		}
		const entry = rawEntry.replace(/\/+$/, "");
		const segments = entry.split("/");
		if (
			segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
			segments[0] !== expectedRoot
		) {
			throw new Error(`Unexpected path in final Electrobun update archive: ${rawEntry}`);
		}
		if (entry === expectedRoot) {
			foundRoot = true;
		}
	}
	if (!foundRoot) {
		throw new Error(`Final Electrobun update archive is missing exact root ${expectedRoot}.`);
	}
}
