import { delimiter, resolve } from "node:path";

export const requiredCompanionEntitlements = [
	"com.apple.security.cs.allow-jit",
	"com.apple.security.cs.allow-unsigned-executable-memory",
] as const;

export type CodesignEnvironment = Record<string, string | undefined>;
export type MacPackageSigningMode = "ad-hoc" | "developer-id" | "not-macos";

export function resolveCompanionCodesignIdentity(environment: CodesignEnvironment): string {
	return (
		environment.MOSHU_COMPANION_CODESIGN_IDENTITY?.trim() ||
		environment.ELECTROBUN_DEVELOPER_ID?.trim() ||
		"-"
	);
}

export function createElectrobunCodesignEnvironment(
	environment: CodesignEnvironment,
	platform: NodeJS.Platform,
): CodesignEnvironment {
	if (platform !== "darwin") {
		return environment;
	}
	const identity = resolveCompanionCodesignIdentity(environment);
	return {
		...environment,
		MOSHU_COMPANION_CODESIGN_IDENTITY: identity,
		ELECTROBUN_DEVELOPER_ID: identity,
	};
}

export function resolveMacPackageSigningMode(
	environment: CodesignEnvironment,
	platform: NodeJS.Platform,
): MacPackageSigningMode {
	if (platform !== "darwin") {
		return "not-macos";
	}
	return resolveCompanionCodesignIdentity(environment) === "-" ? "ad-hoc" : "developer-id";
}

export function createElectrobunPackageEnvironment(
	environment: CodesignEnvironment,
	platform: NodeJS.Platform,
	desktopDirectory: string,
): CodesignEnvironment {
	const codesignEnvironment = createElectrobunCodesignEnvironment(environment, platform);
	const mode = resolveMacPackageSigningMode(codesignEnvironment, platform);
	if (mode === "not-macos") {
		return codesignEnvironment;
	}
	const result = {
		...codesignEnvironment,
		MOSHU_MAC_PACKAGE_SIGNING_MODE: mode,
	};
	if (mode === "developer-id") {
		return result;
	}
	const hookDirectory = resolve(desktopDirectory, "scripts", "electrobun-ad-hoc-bin");
	return {
		...result,
		PATH: `${hookDirectory}${delimiter}${codesignEnvironment.PATH ?? ""}`,
	};
}

export function createCompanionCodesignCommand(options: {
	executable: string;
	identity: string;
	entitlementsPath: string;
}): string[] {
	const command = [
		"codesign",
		"--force",
		"--sign",
		options.identity,
		"--entitlements",
		options.entitlementsPath,
	];
	if (options.identity !== "-") {
		command.push("--options", "runtime", "--timestamp");
	}
	command.push(options.executable);
	return command;
}

export function createBundledToolCodesignCommand(executable: string, identity: string): string[] {
	const command = ["codesign", "--force", "--sign", identity];
	if (identity !== "-") {
		command.push("--options", "runtime", "--timestamp");
	}
	command.push(executable);
	return command;
}

export function createOuterAppCodesignCommand(appBundle: string, identity: string): string[] {
	const command = ["codesign", "--force", "--sign", identity];
	if (identity !== "-") {
		command.push("--options", "runtime", "--timestamp");
	}
	command.push(appBundle);
	return command;
}

export function createMacAppVerificationCommand(appBundle: string): string[] {
	return ["codesign", "--verify", "--deep", "--strict", "--verbose=2", appBundle];
}

export function createCompanionEntitlementsInspectionCommand(executable: string): string[] {
	return ["codesign", "-d", "--entitlements", ":-", "--xml", executable];
}

export function assertEmbeddedCompanionEntitlements(output: string, executable: string): void {
	const compact = output.replace(/\s+/g, "");
	for (const entitlement of requiredCompanionEntitlements) {
		if (!compact.includes(`<key>${entitlement}</key><true/>`)) {
			throw new Error(
				`Companion executable ${executable} is missing required entitlement ${entitlement}.`,
			);
		}
	}
}
