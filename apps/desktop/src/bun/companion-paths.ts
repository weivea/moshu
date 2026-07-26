import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

import { getCompanionExecutableFilename } from "../shared/companion-executable-names";

export interface CompanionExecutables {
	"agents-server": string;
	executor: string;
}

export type CompanionExecutableSource = "bundled" | "workspace";

interface CompanionResolutionOptions {
	workspaceRoot?: string;
	executablePath?: string;
	platform?: NodeJS.Platform;
	bundleMarkerExists?: (filename: string) => boolean;
}

export function resolveBundledCompanionExecutables(
	executablePath = process.execPath,
	platform = process.platform,
): CompanionExecutables {
	const path = getPathApi(platform);
	const companionDirectory = path.resolve(
		path.dirname(executablePath),
		"..",
		"Resources",
		"app",
		"companions",
	);
	return {
		"agents-server": path.resolve(
			companionDirectory,
			getCompanionExecutableFilename("agents-server", platform),
		),
		executor: path.resolve(
			companionDirectory,
			getCompanionExecutableFilename("executor", platform),
		),
	};
}

export function resolveWorkspaceCompanionExecutables(
	workspaceRoot: string,
	platform = process.platform,
): CompanionExecutables {
	const path = getPathApi(platform);
	return {
		"agents-server": path.resolve(
			workspaceRoot,
			"apps",
			"agents-server",
			"dist",
			getCompanionExecutableFilename("agents-server", platform),
		),
		executor: path.resolve(
			workspaceRoot,
			"apps",
			"executor",
			"dist",
			getCompanionExecutableFilename("executor", platform),
		),
	};
}

export function resolveCompanionExecutables(
	options: CompanionResolutionOptions,
): CompanionExecutables {
	const executablePath = options.executablePath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	if (resolveCompanionExecutableSource(options) === "workspace") {
		return resolveWorkspaceCompanionExecutables(
			options.workspaceRoot ?? fail("Development companion workspace root is missing."),
			platform,
		);
	}
	return resolveBundledCompanionExecutables(executablePath, platform);
}

export function resolveCompanionExecutableSource(
	options: CompanionResolutionOptions,
): CompanionExecutableSource {
	const workspaceOverridePresent =
		options.workspaceRoot !== undefined && options.workspaceRoot.length > 0;
	const executablePath = options.executablePath ?? process.execPath;
	const platform = options.platform ?? process.platform;
	return workspaceOverridePresent &&
		!isPackagedCompanionExecution(executablePath, platform, options.bundleMarkerExists)
		? "workspace"
		: "bundled";
}

export function isPackagedCompanionExecution(
	executablePath = process.execPath,
	platform = process.platform,
	bundleMarkerExists: (filename: string) => boolean = existsSync,
): boolean {
	const normalizedPath = executablePath.replaceAll("\\", "/");
	const matchesRuntime =
		platform === "darwin"
			? /\.app\/Contents\/MacOS\/bun$/i.test(normalizedPath)
			: platform === "win32"
				? /\/bin\/bun\.exe$/i.test(normalizedPath)
				: platform === "linux"
					? /\/bin\/bun$/.test(normalizedPath)
					: false;
	if (!matchesRuntime) {
		return false;
	}
	const path = getPathApi(platform);
	const bundleRoot = path.resolve(path.dirname(executablePath), "..");
	if (platform === "darwin" || /^Moshu(?:-(?:dev|canary))?$/i.test(path.basename(bundleRoot))) {
		return true;
	}
	return bundleMarkerExists(path.join(bundleRoot, "Resources", "main.js"));
}

function getPathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
	return platform === "win32" ? win32 : posix;
}

function fail(message: string): never {
	throw new Error(message);
}
