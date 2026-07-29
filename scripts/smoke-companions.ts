import { resolve } from "node:path";

import { CompanionProcessSupervisor } from "../apps/desktop/src/bun/companion-process-supervisor";
import { getCompanionExecutableFilename } from "../apps/desktop/src/shared/companion-executable-names";

const repositoryRoot = resolve(import.meta.dir, "..");
const packagedCompanionDirectory = process.env.MOSHU_COMPANION_SMOKE_DIR;
const supervisor = new CompanionProcessSupervisor({
	executables: {
		"agents-server": resolveCompanionExecutable("agents-server"),
		"runtime-box": resolveCompanionExecutable("runtime-box"),
	},
	startupTimeoutMs: 5_000,
	shutdownTimeoutMs: 2_000,
});

try {
	const snapshot = await supervisor.start();
	const agentsServer = snapshot.processes["agents-server"];
	const runtimeBox = snapshot.processes["runtime-box"];
	if (agentsServer?.ready.role !== "agents-server" || runtimeBox?.ready.role !== "runtime-box") {
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
			"runtime-box": {
				pid: runtimeBox.identity.pid,
				processVersion: runtimeBox.ready.processVersion,
			},
		}),
	);
} finally {
	await supervisor.shutdown();
}

function resolveCompanionExecutable(role: "agents-server" | "runtime-box"): string {
	const directory = packagedCompanionDirectory ?? resolve(repositoryRoot, "apps", role, "dist");
	return resolve(directory, getCompanionExecutableFilename(role, process.platform));
}
