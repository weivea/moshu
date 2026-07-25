import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const parent = Bun.spawn({
	cmd: [process.execPath, resolve(import.meta.dir, "companion-parent-host.ts")],
	cwd: repositoryRoot,
	env: process.env,
	stdin: "ignore",
	stdout: "pipe",
	stderr: "inherit",
});

let companionPids: number[] = [];
try {
	const parentReady = parseParentReady(await readLineWithTimeout(parent.stdout, 5_000));
	companionPids = [parentReady.agentsServerPid, parentReady.executorPid];
	parent.kill("SIGKILL");
	await parent.exited;

	await waitForProcessesToExit(companionPids, 5_000);
	console.info(
		JSON.stringify({
			status: "PARENT_DEATH_CLEAN",
			parentPid: parent.pid,
			companionPids,
		}),
	);
} catch (error) {
	safeKill(parent.pid);
	for (const pid of companionPids) {
		safeKill(pid);
	}
	throw error;
}

async function readLineWithTimeout(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	const reader = stream.getReader();
	const bytes: number[] = [];
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				while (true) {
					const result = await reader.read();
					if (result.done) {
						throw new Error("Parent host exited before reporting companion PIDs.");
					}
					for (const byte of result.value) {
						bytes.push(byte);
						if (bytes.length > 4096) {
							throw new Error("Parent host control record exceeded 4096 bytes.");
						}
						if (byte === 0x0a) {
							return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
						}
					}
				}
			})(),
			new Promise<string>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(new Error(`Parent host did not report companion PIDs within ${timeoutMs}ms.`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		reader.releaseLock();
	}
}

function parseParentReady(input: string): {
	agentsServerPid: number;
	executorPid: number;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		throw new Error("Parent host emitted malformed JSON.");
	}
	if (
		!isObject(parsed) ||
		parsed.type !== "PARENT_READY" ||
		!isPid(parsed.agentsServerPid) ||
		!isPid(parsed.executorPid)
	) {
		throw new Error("Parent host emitted an invalid readiness record.");
	}
	return {
		agentsServerPid: parsed.agentsServerPid,
		executorPid: parsed.executorPid,
	};
}

async function waitForProcessesToExit(pids: readonly number[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(isProcessAlive)) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Companions survived parent death: ${pids.filter(isProcessAlive).join(", ")}`,
			);
		}
		await Bun.sleep(25);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrno(error, "ESRCH")) {
			return false;
		}
		throw error;
	}
}

function safeKill(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!isErrno(error, "ESRCH")) {
			throw error;
		}
	}
}

function isPid(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
