import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AskChatRuntime } from "@moshu/agent-runtime";
import type { AgentsServerBootstrapRecord } from "@moshu/contracts";
import {
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
	openAppDatabase,
} from "@moshu/database";

import { createAgentsServer } from "./create-agents-server";

describe("createAgentsServer", () => {
	test("retries crash-durable checkpoint deletion jobs before the server can become ready", async () => {
		const directory = resolve(process.cwd(), `.agents-startup-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		const database = openAppDatabase(bootstrap.paths.productDatabase);
		const session = database.sessions.create({ title: "Committed before crash" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		database.close();

		const deletionStarted = createDeferred();
		const allowDeletion = createDeferred();
		const deletedThreadIds: string[] = [];
		const runtime = {
			async deleteThread(threadId: string) {
				deletedThreadIds.push(threadId);
				deletionStarted.resolve();
				await allowDeletion.promise;
			},
			async shutdown() {},
		} as unknown as AskChatRuntime;
		let instance: Awaited<ReturnType<typeof createAgentsServer>> | undefined;
		try {
			instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => runtime,
			});
			let ready = false;
			void instance.ready.then(() => {
				ready = true;
			});
			await deletionStarted.promise;
			await Promise.resolve();
			expect(ready).toBe(false);

			allowDeletion.resolve();
			await instance.ready;
			expect(deletedThreadIds).toEqual([session.id]);
			await instance.shutdown();
			instance = undefined;

			const reopened = openAppDatabase(bootstrap.paths.productDatabase);
			try {
				expect(reopened.runs.listPendingCheckpointDeletions(10, true)).toEqual([]);
			} finally {
				reopened.close();
			}
		} finally {
			await instance?.shutdown();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("settles readiness after a bounded permanent cleanup attempt and keeps the job durable", async () => {
		const directory = resolve(process.cwd(), `.agents-startup-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		const database = openAppDatabase(bootstrap.paths.productDatabase);
		const session = database.sessions.create({ title: "Permanent cleanup" }).session;
		database.runs.deleteSessionAndRetireRuns(session.id);
		database.close();
		const deletedThreadIds: string[] = [];
		const runtime = {
			async deleteThread(threadId: string) {
				deletedThreadIds.push(threadId);
				throw new Error("permanent cleanup failure");
			},
			async shutdown() {},
		} as unknown as AskChatRuntime;
		let instance: Awaited<ReturnType<typeof createAgentsServer>> | undefined;

		try {
			instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => runtime,
				checkpointDeletionStartupTimeoutMs: 25,
				checkpointDeletionStartupMaxAttempts: 1,
			});
			await withDeadline(instance.ready, 100, "agents readiness");
			expect(deletedThreadIds).toEqual([session.id]);
			const reopened = openAppDatabase(bootstrap.paths.productDatabase);
			expect(reopened.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
			reopened.close();
		} finally {
			await instance?.shutdown();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("coordinately resets old product and checkpoint stores before opening either service", async () => {
		const directory = resolve(process.cwd(), `.agents-startup-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		const legacyProduct = new Database(bootstrap.paths.productDatabase);
		legacyProduct.exec("CREATE TABLE legacy_product (value TEXT); PRAGMA user_version = 6;");
		legacyProduct.close();
		writeFileSync(bootstrap.paths.checkpointDatabase, "legacy checkpoint bytes");
		const providerDocument = JSON.stringify({
			schemaVersion: 1,
			configuration: {
				provider: "openai-compatible",
				apiKey: "sk-preserved",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4.1-mini",
			},
		});
		writeFileSync(bootstrap.paths.providerConfig, providerDocument);
		for (const sidecar of [
			`${bootstrap.paths.productDatabase}-wal`,
			`${bootstrap.paths.productDatabase}-shm`,
			`${bootstrap.paths.checkpointDatabase}-wal`,
			`${bootstrap.paths.checkpointDatabase}-shm`,
		]) {
			writeFileSync(sidecar, "");
		}
		const runtime = {
			async deleteThread() {},
			async shutdown() {},
		} as unknown as AskChatRuntime;
		const diagnostics: string[] = [];
		let instance: Awaited<ReturnType<typeof createAgentsServer>> | undefined;

		try {
			instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => runtime,
				reportDiagnostic: (message) => diagnostics.push(message),
			});
			await instance.ready;
			const product = openAppDatabase(bootstrap.paths.productDatabase);
			expect(getDatabaseUserVersion(product.client)).toBe(currentAppDatabaseVersion);
			expect(
				product.client
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM sqlite_master WHERE name = 'legacy_product'",
					)
					.get()?.count,
			).toBe(0);
			product.close();
			const checkpoint = new Database(bootstrap.paths.checkpointDatabase, { readonly: true });
			expect(
				checkpoint.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
			).toBe(1);
			checkpoint.close();
			expect(readFileSync(bootstrap.paths.providerConfig, "utf8")).toBe(providerDocument);
			expect(diagnostics).toEqual([
				"Reset local product and checkpoint stores (product-schema-cutover, previous product schema 6).",
			]);
			expect(diagnostics[0]).not.toContain(directory);
			expect(diagnostics[0]).not.toContain("sk-preserved");
		} finally {
			await instance?.shutdown();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("resets a stale checkpoint before opening it when an interrupted reset lost product main", async () => {
		const directory = resolve(process.cwd(), `.agents-startup-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		const staleCheckpoint = new Database(bootstrap.paths.checkpointDatabase);
		staleCheckpoint.exec(
			"CREATE TABLE stale_checkpoint (value TEXT); INSERT INTO stale_checkpoint VALUES ('stale');",
		);
		staleCheckpoint.close();
		for (const sidecar of [
			`${bootstrap.paths.productDatabase}-wal`,
			`${bootstrap.paths.productDatabase}-shm`,
			`${bootstrap.paths.checkpointDatabase}-wal`,
			`${bootstrap.paths.checkpointDatabase}-shm`,
		]) {
			writeFileSync(sidecar, "");
		}
		const runtime = {
			async deleteThread() {},
			async shutdown() {},
		} as unknown as AskChatRuntime;
		const diagnostics: string[] = [];
		let instance: Awaited<ReturnType<typeof createAgentsServer>> | undefined;

		try {
			instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => runtime,
				reportDiagnostic: (message) => diagnostics.push(message),
			});
			await instance.ready;
			const product = openAppDatabase(bootstrap.paths.productDatabase);
			expect(getDatabaseUserVersion(product.client)).toBe(currentAppDatabaseVersion);
			product.close();
			const checkpoint = new Database(bootstrap.paths.checkpointDatabase, { readonly: true });
			expect(
				checkpoint
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM sqlite_master WHERE name = 'stale_checkpoint'",
					)
					.get()?.count,
			).toBe(0);
			checkpoint.close();
			expect(diagnostics).toEqual([
				"Reset local product and checkpoint stores (product-schema-cutover, previous product schema unavailable after interrupted reset).",
			]);
		} finally {
			await instance?.shutdown();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("leaves a current product schema and checkpoint store intact", async () => {
		const directory = resolve(process.cwd(), `.agents-startup-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		const bootstrap = createBootstrap(directory);
		const product = openAppDatabase(bootstrap.paths.productDatabase);
		product.close();
		const checkpoint = new Database(bootstrap.paths.checkpointDatabase);
		checkpoint.exec(
			"CREATE TABLE checkpoint_marker (value TEXT); INSERT INTO checkpoint_marker VALUES ('kept'); PRAGMA user_version = 1;",
		);
		checkpoint.close();
		const runtime = {
			async deleteThread() {},
			async shutdown() {},
		} as unknown as AskChatRuntime;
		const diagnostics: string[] = [];
		let instance: Awaited<ReturnType<typeof createAgentsServer>> | undefined;

		try {
			instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => runtime,
				reportDiagnostic: (message) => diagnostics.push(message),
			});
			await instance.ready;
			const retained = new Database(bootstrap.paths.checkpointDatabase, { readonly: true });
			expect(
				retained.query<{ value: string }, []>("SELECT value FROM checkpoint_marker").get()?.value,
			).toBe("kept");
			retained.close();
			expect(diagnostics).toEqual([]);
		} finally {
			await instance?.shutdown();
			rmSync(directory, { force: true, recursive: true });
		}
	});
});

function createBootstrap(directory: string): AgentsServerBootstrapRecord {
	return {
		channel: "moshu-companion-bootstrap",
		controlVersion: 1,
		type: "START",
		role: "agents-server",
		nonce: "startup-test",
		serverIdentity: {
			role: "agents",
			peerId: "agents-startup-test",
			instanceId: crypto.randomUUID(),
			generation: 1,
		},
		peerBindings: [
			{
				credential: Buffer.alloc(32, 7).toString("base64url"),
				identity: {
					role: "client",
					peerId: "desktop-startup-test",
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

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolvePromiseValue) => {
		resolvePromise = resolvePromiseValue;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.();
		},
	};
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}
