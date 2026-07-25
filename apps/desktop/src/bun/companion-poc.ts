import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { BuildConfig } from "electrobun/bun";

import { resolveCompanionPocExecutables } from "./companion-paths";
import {
	CompanionProcessSupervisor,
	type CompanionSupervisorSnapshot,
} from "./companion-process-supervisor";

export interface StartCompanionPocOptions {
	onSupervisorCreated?(supervisor: CompanionProcessSupervisor): void;
}

export async function startCompanionPocIfEnabled(
	options: StartCompanionPocOptions = {},
): Promise<CompanionProcessSupervisor | undefined> {
	const buildConfig = await BuildConfig.get();
	const executables = resolveCompanionPocExecutables({
		packagedEnabled: buildConfig.runtime?.companionPocEnabled === true,
		devEnabled: process.env.MOSHU_COMPANION_POC === "1",
		workspaceRoot: process.env.MOSHU_COMPANION_WORKSPACE_ROOT,
	});
	if (executables === undefined) {
		return undefined;
	}

	await Promise.all([
		access(executables["agents-server"], constants.X_OK),
		access(executables.executor, constants.X_OK),
	]);

	const supervisor = new CompanionProcessSupervisor({
		executables,
		hooks: {
			onCrash(event) {
				console.error(
					`${event.role} generation ${event.generation} (pid ${event.pid}) exited with code ${event.exitCode}.`,
				);
			},
			onRestartScheduled(event) {
				console.info(`Restarting companion pair (attempt ${event.attempt}) in ${event.delayMs}ms.`);
			},
			onRestarted(snapshot) {
				logReadySnapshot("Companion pair restarted", snapshot);
			},
			onRestartBudgetExhausted(event) {
				console.error(
					`Companion restart budget exhausted after ${event.attempts} attempts.`,
					event.cause,
				);
			},
		},
	});
	options.onSupervisorCreated?.(supervisor);
	const snapshot = await supervisor.start();
	logReadySnapshot("Companion POC started", snapshot);
	return supervisor;
}

function logReadySnapshot(message: string, snapshot: CompanionSupervisorSnapshot): void {
	const agentsServer = snapshot.processes["agents-server"];
	const executor = snapshot.processes.executor;
	console.info(message, {
		agentsServer: agentsServer
			? {
					pid: agentsServer.identity.pid,
					generation: agentsServer.identity.generation,
					endpoint:
						agentsServer.ready.role === "agents-server" ? agentsServer.ready.endpoint : undefined,
				}
			: undefined,
		executor: executor
			? {
					pid: executor.identity.pid,
					generation: executor.identity.generation,
				}
			: undefined,
	});
}
