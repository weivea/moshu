import { resolve } from "node:path";

import { CompanionProcessSupervisor } from "../apps/desktop/src/bun/companion-process-supervisor";
import { getCompanionExecutableFilename } from "../apps/desktop/src/shared/companion-executable-names";

const repositoryRoot = resolve(import.meta.dir, "..");
const supervisor = new CompanionProcessSupervisor({
	executables: {
		"agents-server": resolve(
			repositoryRoot,
			"apps",
			"agents-server",
			"dist",
			getCompanionExecutableFilename("agents-server", process.platform),
		),
		executor: resolve(
			repositoryRoot,
			"apps",
			"executor",
			"dist",
			getCompanionExecutableFilename("executor", process.platform),
		),
	},
	startupTimeoutMs: 5_000,
	shutdownTimeoutMs: 1_000,
});
const snapshot = await supervisor.start();
const agentsServer = snapshot.processes["agents-server"];
const executor = snapshot.processes.executor;
if (agentsServer === undefined || executor === undefined) {
	throw new Error("Parent-death host did not start both companions.");
}

console.info(
	JSON.stringify({
		type: "PARENT_READY",
		agentsServerPid: agentsServer.identity.pid,
		executorPid: executor.identity.pid,
	}),
);

await new Promise<never>(() => undefined);
