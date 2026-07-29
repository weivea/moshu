import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { type AgentsServerBootstrapRecord, agentsServerReadyRecordSchema } from "@moshu/contracts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const entrypoint = resolve(import.meta.dir, "index.ts");

describe("agents-server stdout control channel", () => {
	test.each([
		["normal startup", false],
		["old product-schema reset", true],
	] as const)("emits exactly one READY line during %s", async (_name, legacySchema) => {
		const directory = resolve(process.cwd(), `.agents-control-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		if (legacySchema) {
			const database = new Database(bootstrap.paths.productDatabase);
			database.exec("CREATE TABLE legacy_product (value TEXT); PRAGMA user_version = 6;");
			database.close();
		}

		try {
			const output = await runEntrypoint(bootstrap);
			const stdoutLines = output.stdout.trimEnd().split("\n");
			expect(stdoutLines).toHaveLength(1);
			expect(agentsServerReadyRecordSchema.parse(JSON.parse(stdoutLines[0] ?? ""))).toEqual(
				expect.objectContaining({
					type: "READY",
					role: "agents-server",
					nonce: bootstrap.nonce,
				}),
			);
			expect(output.stdout).not.toContain("Reset local product");
			if (legacySchema) {
				expect(output.stderr).toContain("Reset the local product store");
				expect(output.stderr).not.toContain(directory);
				expect(output.stderr).not.toContain(bootstrap.peerBindings[0]?.credential ?? "");
			} else {
				expect(output.stderr).toBe("");
			}
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("Dev Tunnel watchdog terminates its child when the parent pipe closes", async () => {
		const watched = [
			"console.log(JSON.stringify({ pid: process.pid }));",
			"setInterval(() => undefined, 1000);",
		].join("");
		const watchdog = spawn(
			process.execPath,
			[entrypoint, "--dev-tunnel-watchdog", "--", process.execPath, "-e", watched],
			{
				cwd: repositoryRoot,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		watchdog.stdout.setEncoding("utf8");
		let stdout = "";
		let watchedPid: number | undefined;
		const ready = new Promise<void>((resolveReady, rejectReady) => {
			watchdog.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				const line = stdout.split("\n")[0];
				if (
					stdout.includes("\n") &&
					line !== undefined &&
					line.length > 0 &&
					watchedPid === undefined
				) {
					const parsed = JSON.parse(line) as { pid?: unknown };
					if (typeof parsed.pid !== "number") {
						rejectReady(new Error("Watchdog child did not publish its PID."));
						return;
					}
					watchedPid = parsed.pid;
					resolveReady();
				}
			});
			watchdog.once("exit", (code) => {
				if (watchedPid === undefined) {
					rejectReady(new Error(`Watchdog exited before child readiness with code ${code}.`));
				}
			});
		});
		const closed = new Promise<number | null>((resolveClose) =>
			watchdog.once("close", resolveClose),
		);
		try {
			await within(ready, 5_000, "watchdog child readiness");
			watchdog.stdin.end();
			expect(await within(closed, 5_000, "watchdog parent-close shutdown")).toBe(0);
			if (watchedPid === undefined) {
				throw new Error("Watchdog child PID was not captured.");
			}
			expect(isProcessAlive(watchedPid)).toBe(false);
		} finally {
			if (watchdog.exitCode === null && watchdog.signalCode === null) {
				watchdog.kill("SIGTERM");
			}
			if (watchedPid !== undefined && isProcessAlive(watchedPid)) {
				process.kill(watchedPid, "SIGKILL");
			}
		}
	});
});

async function runEntrypoint(
	bootstrap: AgentsServerBootstrapRecord,
): Promise<{ stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [entrypoint], {
		cwd: repositoryRoot,
		env: { ...process.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let stdout = "";
	let stderr = "";
	let ready = false;
	const closed = new Promise<number | null>((resolveClose) => {
		child.once("close", resolveClose);
	});
	const readyLine = new Promise<void>((resolveReady, rejectReady) => {
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (!ready && stdout.includes("\n")) {
				ready = true;
				resolveReady();
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("exit", (code) => {
			if (!ready) {
				rejectReady(new Error(`agents-server exited before READY with code ${code}.`));
			}
		});
	});

	try {
		child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
		await within(readyLine, 5_000, "agents-server READY");
		child.stdin.end();
		const exitCode = await within(closed, 5_000, "agents-server parent-close shutdown");
		expect(exitCode).toBe(0);
		return { stdout, stderr };
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
}

function createBootstrap(directory: string): AgentsServerBootstrapRecord {
	return {
		channel: "moshu-companion-bootstrap",
		controlVersion: 2,
		type: "START",
		role: "agents-server",
		nonce: crypto.randomUUID(),
		serverIdentity: {
			role: "agents",
			peerId: "agents-control-test",
			instanceId: crypto.randomUUID(),
			generation: 1,
		},
		peerBindings: [
			{
				credential: Buffer.alloc(32, 71).toString("base64url"),
				identity: {
					role: "client",
					peerId: "desktop-control-test",
					instanceId: crypto.randomUUID(),
					generation: 1,
				},
			},
			{
				credential: Buffer.alloc(32, 72).toString("base64url"),
				identity: {
					role: "runtime-box",
					peerId: "runtime-box-control-test",
					instanceId: crypto.randomUUID(),
					generation: 1,
				},
			},
		],
		paths: {
			productDatabase: resolve(directory, "product.db"),
			agentDataDirectory: resolve(directory, "agent-data"),
		},
	};
}

function within<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolveOperation, rejectOperation) => {
		const timer = setTimeout(
			() => rejectOperation(new Error(`${label} exceeded ${timeoutMs}ms.`)),
			timeoutMs,
		);
		operation.then(
			(value) => {
				clearTimeout(timer);
				resolveOperation(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				rejectOperation(error);
			},
		);
	});
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
