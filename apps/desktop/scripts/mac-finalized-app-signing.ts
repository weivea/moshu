import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	COMPANION_EXECUTABLE_ROLES,
	type CompanionExecutableRole,
	assertCompanionResourceFilenames,
	getCompanionResourceFilenames,
	getCompanionExecutableFilename,
	getExecutorToolExecutableFilenames,
} from "../src/shared/companion-executable-names";
import {
	assertEmbeddedCompanionEntitlements,
	createBundledToolCodesignCommand,
	createCompanionCodesignCommand,
	createCompanionEntitlementsInspectionCommand,
	createMacAppVerificationCommand,
	createOuterAppCodesignCommand,
} from "./companion-signing";

export interface FinalizedMacCodesignPlan {
	nested: string[][];
	outer: string[];
	verify: string[][];
}

const lockedElectrobunMacCode = [
	{ name: "bspatch", entitlements: false },
	{ name: "bun", entitlements: true },
	{ name: "libNativeWrapper.dylib", entitlements: false },
	{ name: "libasar.dylib", entitlements: false },
	{ name: "zig-zstd", entitlements: false },
	{ name: "launcher", entitlements: false },
] as const;

function companionExecutable(appPath: string, role: CompanionExecutableRole): string {
	return join(
		appPath,
		"Contents",
		"Resources",
		"app",
		"companions",
		getCompanionExecutableFilename(role, "darwin"),
	);
}

function companionResourceDirectory(appPath: string): string {
	return join(appPath, "Contents", "Resources", "app", "companions");
}

function executorToolExecutables(appPath: string): string[] {
	return getExecutorToolExecutableFilenames("darwin").map((filename) =>
		join(companionResourceDirectory(appPath), filename),
	);
}

function createNestedCodesignCommand(
	executablePath: string,
	identity: string,
	entitlementsPath?: string,
): string[] {
	const command = ["codesign", "--force"];
	if (identity !== "-") {
		command.push("--options", "runtime", "--timestamp");
	}
	command.push("--sign", identity);
	if (entitlementsPath) {
		command.push("--entitlements", entitlementsPath);
	}
	command.push(executablePath);
	return command;
}

export function createFinalizedMacCodesignPlan(
	appPath: string,
	identity: string,
	entitlementsPath: string,
): FinalizedMacCodesignPlan {
	const companions = COMPANION_EXECUTABLE_ROLES.map((role) => companionExecutable(appPath, role));
	const tools = executorToolExecutables(appPath);
	return {
		nested: [
			...companions.map((executable) =>
				createCompanionCodesignCommand({
					executable,
					identity,
					entitlementsPath,
				}),
			),
			...tools.map((executable) => createBundledToolCodesignCommand(executable, identity)),
			...lockedElectrobunMacCode.map(({ name, entitlements }) =>
				createNestedCodesignCommand(
					join(appPath, "Contents", "MacOS", name),
					identity,
					entitlements ? entitlementsPath : undefined,
				),
			),
		],
		outer: createOuterAppCodesignCommand(appPath, identity),
		verify: [
			createMacAppVerificationCommand(appPath),
			...companions.flatMap((executable) => [
				["codesign", "--verify", "--strict", executable],
				createCompanionEntitlementsInspectionCommand(executable),
			]),
			...tools.map((executable) => ["codesign", "--verify", "--strict", executable]),
		],
	};
}

function assertDirectory(path: string, description: string): void {
	const stats = lstatSync(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`${description} must be a real directory: ${path}`);
	}
}

function assertExecutable(path: string): void {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
		throw new Error(`Expected a regular executable, not a symlink: ${path}`);
	}
}

function assertRegularFile(path: string): void {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Expected a regular file, not a symlink: ${path}`);
	}
}

function run(command: string[]): string {
	const [executable, ...arguments_] = command;
	if (executable === undefined) {
		throw new Error("Cannot execute an empty signing command.");
	}
	const result = spawnSync(executable, arguments_, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(
			`${command.join(" ")} failed (${result.status ?? "signal"}): ${result.stderr || result.stdout}`,
		);
	}
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function signAndVerifyFinalizedMacApp(
	appPath: string,
	identity: string,
	entitlementsPath: string,
): void {
	assertDirectory(appPath, "Finalized macOS app");
	const macCodeDirectory = join(appPath, "Contents", "MacOS");
	assertDirectory(macCodeDirectory, "Electrobun macOS code directory");
	const actualMacCode = readdirSync(macCodeDirectory).sort();
	const expectedMacCode = lockedElectrobunMacCode.map(({ name }) => name).sort();
	if (
		actualMacCode.length !== expectedMacCode.length ||
		actualMacCode.some((entry, index) => entry !== expectedMacCode[index])
	) {
		throw new Error(
			`Unexpected Electrobun macOS code layout: ${actualMacCode.join(", ") || "empty"}.`,
		);
	}
	const resourcesDirectory = companionResourceDirectory(appPath);
	assertDirectory(resourcesDirectory, "Moshu companion resource directory");
	const actualCompanionResources = readdirSync(resourcesDirectory);
	assertCompanionResourceFilenames(actualCompanionResources, "darwin");
	const expectedCompanionResources = getCompanionResourceFilenames("darwin");
	for (const filename of expectedCompanionResources) {
		assertRegularFile(join(resourcesDirectory, filename));
	}
	const plan = createFinalizedMacCodesignPlan(appPath, identity, entitlementsPath);
	for (const command of plan.nested) {
		assertExecutable(command.at(-1) as string);
		run(command);
	}
	run(plan.outer);
	for (const command of plan.verify) {
		const output = run(command);
		if (command[1] === "-d") {
			assertEmbeddedCompanionEntitlements(output, command.at(-1) as string);
		}
	}
}

export interface FinalAppTarInvocation {
	appPath: string;
	tarPath: string;
}

export function parseFinalAppTarInvocation(
	arguments_: string[],
	cwd: string,
): FinalAppTarInvocation | undefined {
	const [operation, tarArgument, appEntry] = arguments_;
	if (
		arguments_.length !== 3 ||
		operation !== "-cf" ||
		tarArgument === undefined ||
		appEntry === undefined ||
		!appEntry.endsWith(".app") ||
		basename(tarArgument) !== `${appEntry}.tar`
	) {
		return undefined;
	}
	const tarPath = resolve(cwd, tarArgument);
	if (dirname(tarPath) !== resolve(cwd)) {
		throw new Error(`Final app tar must be written beside the app bundle: ${tarPath}`);
	}
	return {
		appPath: join(resolve(cwd), appEntry),
		tarPath,
	};
}

export function adHocSigningMarkerPath(tarPath: string): string {
	return `${tarPath}.moshu-adhoc-signed`;
}

export function writeAdHocSigningMarker(tarPath: string, appPath: string): void {
	const markerPath = adHocSigningMarkerPath(tarPath);
	const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.writing`;
	const payload = `${JSON.stringify({
		schema: 1,
		app: basename(appPath),
		identity: "-",
	})}\n`;
	let descriptor: number | undefined;
	try {
		writeFileSync(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
		descriptor = openSync(temporaryPath, "r");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, markerPath);
		const directoryDescriptor = openSync(dirname(markerPath), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
		rmSync(temporaryPath, { force: true });
	}
}

export function assertAdHocSigningMarker(tarPath: string, expectedApp: string): void {
	const markerPath = adHocSigningMarkerPath(tarPath);
	const stats = lstatSync(markerPath);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Invalid ad-hoc pre-archive signing marker: ${markerPath}`);
	}
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
		schema?: unknown;
		app?: unknown;
		identity?: unknown;
	};
	if (marker.schema !== 1 || marker.app !== expectedApp || marker.identity !== "-") {
		throw new Error(`Unexpected ad-hoc pre-archive signing marker: ${markerPath}`);
	}
}
