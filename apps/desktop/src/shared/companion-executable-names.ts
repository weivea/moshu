import {
	executorToolBinaryNames,
	getExecutorToolBinaryFilename,
} from "../../../../packages/contracts/src/executor-tool-assets";

export const COMPANION_EXECUTABLE_ROLES = ["agents-server", "runtime-box"] as const;

export type CompanionExecutableRole = (typeof COMPANION_EXECUTABLE_ROLES)[number];

const COMPANION_EXECUTABLE_BASE_NAMES: Record<CompanionExecutableRole, string> = {
	"agents-server": "moshu-agents-server",
	"runtime-box": "moshu-runtime-box",
};

export function getCompanionExecutableFilename(
	role: CompanionExecutableRole,
	platform: NodeJS.Platform = process.platform,
): string {
	const extension = platform === "win32" ? ".exe" : "";
	return `${COMPANION_EXECUTABLE_BASE_NAMES[role]}${extension}`;
}

export function getCompanionExecutableFilenames(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return COMPANION_EXECUTABLE_ROLES.map((role) => getCompanionExecutableFilename(role, platform));
}

export function getExecutorToolExecutableFilenames(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return executorToolBinaryNames.map((tool) => getExecutorToolBinaryFilename(tool, platform));
}

export function getCompanionResourceFilenames(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return getCompanionExecutableFilenames(platform);
}

export function assertCompanionResourceFilenames(
	entries: readonly string[],
	platform: NodeJS.Platform = process.platform,
): void {
	const actual = [...entries].sort();
	const expected = getCompanionResourceFilenames(platform).sort();
	if (
		actual.length !== expected.length ||
		actual.some((entry, index) => entry !== expected[index])
	) {
		throw new Error(`Unexpected Moshu companion resource layout: ${actual.join(", ") || "empty"}.`);
	}
}

export function createElectrobunCompanionCopyEntries(
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const companions = Object.fromEntries(
		COMPANION_EXECUTABLE_ROLES.map((role) => {
			const filename = getCompanionExecutableFilename(role, platform);
			return [`../${role}/dist/${filename}`, `companions/${filename}`];
		}),
	);
	return companions;
}

export function resolveCurrentHostCompanionPlatform(
	electrobunOs: string,
	hostPlatform: NodeJS.Platform = process.platform,
): NodeJS.Platform {
	const targetPlatform = toNodePlatform(electrobunOs);
	if (targetPlatform !== hostPlatform) {
		throw new Error(
			`Companion packaging only supports Electrobun's current build host; target ${electrobunOs} does not match host ${hostPlatform}.`,
		);
	}
	return targetPlatform;
}

function toNodePlatform(electrobunOs: string): NodeJS.Platform {
	switch (electrobunOs) {
		case "macos":
			return "darwin";
		case "linux":
			return "linux";
		case "win":
			return "win32";
		default:
			throw new Error(`Unsupported Electrobun target OS: ${electrobunOs}`);
	}
}
