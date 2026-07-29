import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CompanionProcessSupervisor } from "../src/bun/companion-process-supervisor";
import { verifyCompanionReleaseManifest } from "./companion-release-manifest";

export async function verifyPackagedCompanionLaunch(
	executables: readonly [string, string],
	scratchParent: string,
): Promise<void> {
	verifyCompanionReleaseManifest(dirname(executables[0]), process.platform);
	const directory = mkdtempSync(join(scratchParent, ".moshu-companion-launch-"));
	const supervisor = new CompanionProcessSupervisor({
		executables: {
			"agents-server": executables[0],
			"runtime-box": executables[1],
		},
		dataPaths: {
			productDatabase: join(directory, "moshu.db"),
			agentDataDirectory: join(directory, "agent-data"),
		},
		environment: createNoSystemRuntimeEnvironment(process.env, process.platform),
		restartPolicy: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
	});
	try {
		const snapshot = await supervisor.start();
		if (snapshot.status !== "running") {
			throw new Error(`Packaged companion launch ended in ${snapshot.status}.`);
		}
	} finally {
		await supervisor.shutdown();
		rmSync(directory, { recursive: true, force: true });
	}
}

export function createNoSystemRuntimeEnvironment(
	source: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): Record<string, string> {
	const environment: Record<string, string> = {
		PATH: platform === "win32" ? "C:\\moshu-no-system-runtime" : "/moshu-no-system-runtime",
	};
	for (const name of [
		"HOME",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"TMP",
		"TEMP",
		"USERPROFILE",
		"SystemRoot",
		"WINDIR",
	]) {
		const value = source[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	return environment;
}
