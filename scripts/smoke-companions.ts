import { resolve } from "node:path";

import { CompanionProcessSupervisor } from "../apps/desktop/src/bun/companion-process-supervisor";
import { getCompanionExecutableFilename } from "../apps/desktop/src/shared/companion-executable-names";

const repositoryRoot = resolve(import.meta.dir, "..");
const packagedCompanionDirectory = process.env.MOSHU_COMPANION_SMOKE_DIR;
const supervisor = new CompanionProcessSupervisor({
	executables: {
		"agents-server": resolveCompanionExecutable("agents-server"),
		executor: resolveCompanionExecutable("executor"),
	},
	startupTimeoutMs: 5_000,
	shutdownTimeoutMs: 2_000,
});

try {
	const snapshot = await supervisor.start();
	const agentsServer = snapshot.processes["agents-server"];
	const executor = snapshot.processes.executor;
	if (agentsServer?.ready.role !== "agents-server" || executor?.ready.role !== "executor") {
		throw new Error("Compiled companion smoke test did not receive both READY records.");
	}
	console.info(
		JSON.stringify({
			status: "READY",
			agentsServer: {
				pid: agentsServer.identity.pid,
				processVersion: agentsServer.ready.processVersion,
				endpoint: agentsServer.ready.endpoint,
			},
			executor: {
				pid: executor.identity.pid,
				processVersion: executor.ready.processVersion,
			},
		}),
	);
} finally {
	await supervisor.shutdown();
}

function resolveCompanionExecutable(role: "agents-server" | "executor"): string {
	const directory = packagedCompanionDirectory ?? resolve(repositoryRoot, "apps", role, "dist");
	return resolve(directory, getCompanionExecutableFilename(role, process.platform));
}
