import { dirname, resolve } from "node:path";

import { getCompanionExecutableFilename } from "../shared/companion-executable-names";

export interface CompanionExecutables {
	"agents-server": string;
	executor: string;
}

export function resolveBundledCompanionExecutables(
	executablePath = process.execPath,
	platform = process.platform,
): CompanionExecutables {
	const companionDirectory = resolve(
		dirname(executablePath),
		"..",
		"Resources",
		"app",
		"companions",
	);
	return {
		"agents-server": resolve(
			companionDirectory,
			getCompanionExecutableFilename("agents-server", platform),
		),
		executor: resolve(companionDirectory, getCompanionExecutableFilename("executor", platform)),
	};
}

export function resolveWorkspaceCompanionExecutables(
	workspaceRoot: string,
	platform = process.platform,
): CompanionExecutables {
	return {
		"agents-server": resolve(
			workspaceRoot,
			"apps",
			"agents-server",
			"dist",
			getCompanionExecutableFilename("agents-server", platform),
		),
		executor: resolve(
			workspaceRoot,
			"apps",
			"executor",
			"dist",
			getCompanionExecutableFilename("executor", platform),
		),
	};
}

export function resolveCompanionPocExecutables(options: {
	packagedEnabled: boolean;
	devEnabled: boolean;
	workspaceRoot?: string;
	executablePath?: string;
	platform?: NodeJS.Platform;
}): CompanionExecutables | undefined {
	if (options.packagedEnabled) {
		return resolveBundledCompanionExecutables(options.executablePath, options.platform);
	}
	if (!options.devEnabled) {
		return undefined;
	}
	if (options.workspaceRoot === undefined || options.workspaceRoot.length === 0) {
		throw new Error(
			"MOSHU_COMPANION_POC requires MOSHU_COMPANION_WORKSPACE_ROOT; use `bun run dev:companions`.",
		);
	}
	return resolveWorkspaceCompanionExecutables(options.workspaceRoot, options.platform);
}
