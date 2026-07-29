import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CompanionProcessSupervisor } from "../src/bun/companion-process-supervisor";

export async function verifyPackagedCompanionLaunch(
	executables: readonly [string, string],
	scratchParent: string,
): Promise<void> {
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
