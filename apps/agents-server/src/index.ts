import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	type AgentsServerReadyRecord,
	openBootstrapControlChannel,
	parseAgentsServerBootstrapRecord,
	serializeReadyRecord,
} from "./bootstrap";

const PROCESS_VERSION = "0.0.1";

async function main(): Promise<void> {
	const controlChannel = await openBootstrapControlChannel(Bun.stdin.stream());
	const bootstrap = parseAgentsServerBootstrapRecord(controlChannel.input);
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket) {
				socket.end();
			},
		},
	});

	let stopping = false;
	const shutdown = (exitCode = 0) => {
		if (stopping) {
			return;
		}
		stopping = true;
		listener.stop(true);
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

	const ready: AgentsServerReadyRecord = {
		channel: BOOTSTRAP_CHANNEL,
		controlVersion: BOOTSTRAP_CONTROL_VERSION,
		type: "READY",
		role: "agents-server",
		pid: process.pid,
		processVersion: PROCESS_VERSION,
		nonce: bootstrap.nonce,
		endpoint: {
			host: "127.0.0.1",
			port: listener.port,
		},
	};

	try {
		await Bun.write(Bun.stdout, serializeReadyRecord(ready));
	} catch (error) {
		listener.stop(true);
		throw error;
	}
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "agents-server bootstrap failed.");
		process.exit(1);
	});
}
