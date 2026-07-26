import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { type AgentsServerBootstrapRecord, agentsServerReadyRecordSchema } from "@moshu/contracts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const entrypoint = resolve(import.meta.dir, "index.ts");

describe("agents-server stdout control channel", () => {
	test.each([
		["normal startup", false],
		["coordinated old-schema reset", true],
	] as const)("emits exactly one READY line during %s", async (_name, legacySchema) => {
		const directory = resolve(process.cwd(), `.agents-control-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		if (legacySchema) {
			const database = new Database(bootstrap.paths.productDatabase);
			database.exec("CREATE TABLE legacy_product (value TEXT); PRAGMA user_version = 6;");
			database.close();
			writeFileSync(bootstrap.paths.checkpointDatabase, "legacy checkpoint bytes");
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
				expect(output.stderr).toContain("Reset local product and checkpoint stores");
				expect(output.stderr).not.toContain(directory);
				expect(output.stderr).not.toContain(bootstrap.peerBindings[0]?.credential ?? "");
			} else {
				expect(output.stderr).toBe("");
			}
		} finally {
			rmSync(directory, { force: true, recursive: true });
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
		controlVersion: 1,
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
					role: "executor",
					peerId: "executor-control-test",
					instanceId: crypto.randomUUID(),
					generation: 1,
				},
			},
		],
		paths: {
			productDatabase: resolve(directory, "product.db"),
			checkpointDatabase: resolve(directory, "checkpoints.db"),
			providerConfig: resolve(directory, "provider.json"),
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
