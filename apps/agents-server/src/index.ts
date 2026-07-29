import { initializeBunAgentRuntime } from "@moshu/agent-runtime";
import {
	type AgentsServerReadyRecord,
	companionBootstrapChannel,
	companionControlVersion,
	moshuReleaseVersion,
} from "@moshu/contracts";

import {
	openBootstrapControlChannel,
	parseAgentsServerBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";
import { type CreateAgentsServerOptions, createAgentsServer } from "./create-agents-server";

const PROCESS_VERSION = moshuReleaseVersion;
const DEV_TUNNEL_WATCHDOG_MODE = "--dev-tunnel-watchdog";

export async function runAgentsServerProcess(
	options: Pick<CreateAgentsServerOptions, "createRuntime" | "fetchProviderModels"> = {},
): Promise<void> {
	initializeBunAgentRuntime();
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
			port: instance.productRpcServer.port,
			path: instance.productRpcServer.path as "/rpc",
		},
		runtimeEndpoint: {
			host: "127.0.0.1",
			port: instance.runtimeRpcServer.port,
			path: instance.runtimeRpcServer.path as "/runtime",
		},
		actionJournalEpoch: instance.actionJournalEpoch,
	};

	try {
		await Bun.write(Bun.stdout, serializeReadyRecord(ready));
	} catch (error) {
		await instance.shutdown();
		throw error;
	}
}

export async function runDevTunnelWatchdog(args: readonly string[]): Promise<number> {
	if (args[0] !== "--" || args.length < 2) {
		throw new Error("Dev Tunnel watchdog requires a command after --.");
	}
	const signal = Promise.withResolvers<"signal">();
	const onSignal = () => signal.resolve("signal");
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const parentClosed = waitForStreamClose(Bun.stdin.stream()).then(
			() => "parent" as const,
			() => "parent-error" as const,
		);
		const child = Bun.spawn({
			cmd: [...args.slice(1)],
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		const outcome = await Promise.race([
			child.exited.then((exitCode) => ({ type: "child" as const, exitCode })),
			parentClosed.then((type) => ({
				type,
				exitCode: type === "parent" ? 0 : 1,
			})),
			signal.promise.then((type) => ({ type, exitCode: 0 })),
		]);
		if (outcome.type === "child") {
			return outcome.exitCode;
		}
		await terminateWatchdogChild(child);
		return outcome.exitCode;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

async function waitForStreamClose(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (!(await reader.read()).done) {
			// The pipe carries no protocol data; only its lifetime matters.
		}
	} finally {
		reader.releaseLock();
	}
}

async function terminateWatchdogChild(child: Bun.Subprocess): Promise<void> {
	child.kill("SIGTERM");
	const graceful = await Promise.race([
		child.exited.then(() => true),
		Bun.sleep(1_000).then(() => false),
	]);
	if (!graceful) {
		child.kill("SIGKILL");
		await child.exited;
	}
}

if (import.meta.main) {
	const watchdogIndex = process.argv.indexOf(DEV_TUNNEL_WATCHDOG_MODE);
	if (watchdogIndex >= 0) {
		const exitCode = await runDevTunnelWatchdog(process.argv.slice(watchdogIndex + 1)).catch(
			(error: unknown) => {
				console.error(error instanceof Error ? error.message : "Dev Tunnel watchdog failed.");
				return 1;
			},
		);
		process.exit(exitCode);
	} else {
		await runAgentsServerProcess().catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : "agents-server bootstrap failed.");
			process.exit(1);
		});
	}
}
