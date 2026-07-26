import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	type ExecutorReadyRecord,
	openBootstrapControlChannel,
	parseExecutorBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";

const PROCESS_VERSION = "0.0.1";

async function main(): Promise<void> {
	const controlChannel = await openBootstrapControlChannel(Bun.stdin.stream());
	const bootstrap = parseExecutorBootstrapRecord(controlChannel.input);
	const keepAlive = setInterval(() => undefined, 60_000);

	let stopping = false;
	const shutdown = (exitCode = 0) => {
		if (stopping) {
			return;
		}
		stopping = true;
		clearInterval(keepAlive);
		process.exit(exitCode);
	};
	process.once("SIGINT", () => shutdown());
	process.once("SIGTERM", () => shutdown());
	void controlChannel.parentClosed.then(
		() => shutdown(),
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : "Parent control channel failed.");
			shutdown(1);
		},
	);

	const ready: ExecutorReadyRecord = {
		channel: BOOTSTRAP_CHANNEL,
		controlVersion: BOOTSTRAP_CONTROL_VERSION,
		type: "READY",
		role: "executor",
		pid: process.pid,
		processVersion: PROCESS_VERSION,
		nonce: bootstrap.nonce,
		agentsServer: {
			host: bootstrap.agentsServer.endpoint.host,
			port: bootstrap.agentsServer.endpoint.port,
			nonce: bootstrap.agentsServer.nonce,
		},
	};

	try {
		await Bun.write(Bun.stdout, serializeReadyRecord(ready));
	} catch (error) {
		clearInterval(keepAlive);
		throw error;
	}
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "executor bootstrap failed.");
		process.exit(1);
	});
}
