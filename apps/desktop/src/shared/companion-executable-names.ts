export const COMPANION_EXECUTABLE_ROLES = ["agents-server", "executor"] as const;

export type CompanionExecutableRole = (typeof COMPANION_EXECUTABLE_ROLES)[number];

const COMPANION_EXECUTABLE_BASE_NAMES: Record<CompanionExecutableRole, string> = {
	"agents-server": "moshu-agents-server",
	executor: "moshu-executor",
};

export function getCompanionExecutableFilename(
	role: CompanionExecutableRole,
	platform: NodeJS.Platform = process.platform,
): string {
	const extension = platform === "win32" ? ".exe" : "";
	return `${COMPANION_EXECUTABLE_BASE_NAMES[role]}${extension}`;
}

export function createElectrobunCompanionCopyEntries(
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	return Object.fromEntries(
		COMPANION_EXECUTABLE_ROLES.map((role) => {
			const filename = getCompanionExecutableFilename(role, platform);
			return [`../${role}/dist/${filename}`, `companions/${filename}`];
		}),
	);
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
