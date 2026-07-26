import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { AgentsServerDataPaths } from "@moshu/contracts";

import {
	type CompanionExecutableSource,
	type CompanionExecutables,
	resolveCompanionExecutableSource,
	resolveCompanionExecutables,
} from "./companion-paths";
import {
	CompanionProcessSupervisor,
	type CompanionProcessSupervisorOptions,
	type CompanionSupervisorSnapshot,
} from "./companion-process-supervisor";

export interface StartCompanionRuntimeOptions {
	dataPaths: AgentsServerDataPaths;
	connectClient: NonNullable<CompanionProcessSupervisorOptions["connectClient"]>;
	onSupervisorCreated?(supervisor: CompanionProcessSupervisor): void;
}

export async function startCompanionRuntime(
	options: StartCompanionRuntimeOptions,
): Promise<CompanionProcessSupervisor> {
	const resolution = {
		workspaceRoot: process.env.MOSHU_COMPANION_WORKSPACE_ROOT,
		executablePath: process.execPath,
		platform: process.platform,
	};
	const source = resolveCompanionExecutableSource(resolution);
	const executables = resolveCompanionExecutables(resolution);
	await assertCompanionExecutablesAvailable(executables, source);

	const supervisor = new CompanionProcessSupervisor({
		executables,
		dataPaths: options.dataPaths,
		connectClient: options.connectClient,
		hooks: {
			onCrash(event) {
				console.error(
					`${event.role} generation ${event.generation} (pid ${event.pid}) disconnected with code ${event.exitCode}.`,
				);
			},
			onRestartScheduled(event) {
				console.info(`Restarting companion pair (attempt ${event.attempt}) in ${event.delayMs}ms.`);
			},
			onRestarted(snapshot) {
				logReadySnapshot("Companion pair recovered", snapshot);
			},
			onRestartBudgetExhausted(event) {
				console.error(
					`Companion restart budget exhausted after ${event.attempts} attempts.`,
					event.cause,
				);
			},
			onFatalError(error) {
				console.error("Companion runtime failure.", error);
			},
		},
	});
	options.onSupervisorCreated?.(supervisor);
	const snapshot = await supervisor.start();
	logReadySnapshot("Companion runtime ready", snapshot);
	return supervisor;
}

export async function assertCompanionExecutablesAvailable(
	executables: CompanionExecutables,
	source: CompanionExecutableSource,
	checkAccess: (filename: string, mode: number) => Promise<void> = access,
): Promise<void> {
	for (const role of ["agents-server", "executor"] as const) {
		try {
			await checkAccess(executables[role], constants.X_OK);
		} catch {
			const sourceLabel = source === "bundled" ? "Bundled" : "Development";
			throw new Error(`${sourceLabel} ${role} companion is missing or not executable.`);
		}
	}
}

function logReadySnapshot(message: string, snapshot: CompanionSupervisorSnapshot): void {
	console.info(message, {
		status: snapshot.status,
		agentsServer: snapshot.processes["agents-server"]?.identity,
		executor: snapshot.processes.executor?.identity,
	});
}
