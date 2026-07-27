import {
	type AgentsServerReadyRecord,
	companionBootstrapChannel,
	companionControlVersion,
} from "@moshu/contracts";

import {
	openBootstrapControlChannel,
	parseAgentsServerBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";
import { type CreateAgentsServerOptions, createAgentsServer } from "./create-agents-server";

const PROCESS_VERSION = "0.0.1";

export async function runAgentsServerProcess(
	options: Pick<
		CreateAgentsServerOptions,
		"createRuntime" | "testProviderConnection" | "fetchProviderModels"
	> = {},
): Promise<void> {
	const controlChannel = await openBootstrapControlChannel(Bun.stdin.stream());
	const bootstrap = parseAgentsServerBootstrapRecord(controlChannel.input);
	const instance = await createAgentsServer({
		bootstrap,
		serverVersion: PROCESS_VERSION,
		...options,
	});

	let stopping = false;
	const shutdown = async (exitCode = 0): Promise<void> => {
		if (stopping) {
			return;
		}
		stopping = true;
		try {
			await instance.shutdown();
		} finally {
			process.exit(exitCode);
		}
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
	void controlChannel.parentClosed.then(
		() => void shutdown(),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : "Parent control channel failed.");
			void shutdown(1);
		},
	);
	try {
		await instance.ready;
	} catch (error) {
		await instance.shutdown();
		throw error;
	}
	if (stopping) {
		return;
	}

	const ready: AgentsServerReadyRecord = {
		channel: companionBootstrapChannel,
		controlVersion: companionControlVersion,
		type: "READY",
		role: "agents-server",
		pid: process.pid,
		processVersion: PROCESS_VERSION,
		nonce: bootstrap.nonce,
		serverIdentity: bootstrap.serverIdentity,
		endpoint: {
			host: "127.0.0.1",
			port: instance.rpcServer.port,
			path: instance.rpcServer.path as "/rpc",
		},
	};

	try {
		await Bun.write(Bun.stdout, serializeReadyRecord(ready));
	} catch (error) {
		await instance.shutdown();
		throw error;
	}
}

if (import.meta.main) {
	await runAgentsServerProcess().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "agents-server bootstrap failed.");
		process.exit(1);
	});
}
