import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AskChatRuntime } from "@moshu/agent-runtime";
import type { AgentsServerBootstrapRecord } from "@moshu/contracts";
import {
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
	openAppDatabase,
} from "@moshu/database";

import { createAgentsServer } from "./create-agents-server";

describe("createAgentsServer", () => {
	test("retries durable agent-session cleanup before readiness", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const database = openAppDatabase(bootstrap.paths.productDatabase);
			const session = database.sessions.create({ title: "Committed before crash" }).session;
			database.runs.deleteSessionAndRetireRuns(session.id);
			database.close();
			const deletionStarted = Promise.withResolvers<void>();
			const allowDeletion = Promise.withResolvers<void>();
			const deleted: string[] = [];
			let receivedExecutorGateway: unknown;
			const runtime = fakeRuntime(async (id) => {
				deleted.push(id);
				deletionStarted.resolve();
				await allowDeletion.promise;
			});
			const instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: (_providers, _modelRuntime, executorGateway) => {
					receivedExecutorGateway = executorGateway;
					return runtime;
				},
			});
			try {
				expect(receivedExecutorGateway).toBe(instance.executorReadiness);
				let ready = false;
				void instance.ready.then(() => {
					ready = true;
				});
				await deletionStarted.promise;
				await Promise.resolve();
				expect(ready).toBe(false);
				allowDeletion.resolve();
				await instance.ready;
				expect(deleted).toEqual([session.agentSessionId]);
				const reopened = openAppDatabase(bootstrap.paths.productDatabase);
				expect(reopened.runs.listPendingAgentSessionCleanups(10, true)).toEqual([]);
				reopened.close();
			} finally {
				await instance.shutdown();
			}
		});
	});

	test("bounds permanent startup cleanup failures and retains the durable job", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const database = openAppDatabase(bootstrap.paths.productDatabase);
			const session = database.sessions.create({ title: "Permanent cleanup" }).session;
			database.runs.deleteSessionAndRetireRuns(session.id);
			database.close();
			const deleted: string[] = [];
			const instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () =>
					fakeRuntime(async (id) => {
						deleted.push(id);
						throw new Error("permanent fake cleanup failure");
					}),
				agentSessionCleanupStartupTimeoutMs: 25,
				agentSessionCleanupStartupMaxAttempts: 1,
			});
			try {
				await withDeadline(instance.ready, 150, "agents readiness");
				expect(deleted).toEqual([session.agentSessionId]);
				const reopened = openAppDatabase(bootstrap.paths.productDatabase);
				expect(reopened.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
				reopened.close();
			} finally {
				await instance.shutdown();
			}
		});
	});

	test("resets an old product schema without deleting app-owned Pi data", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const legacy = new Database(bootstrap.paths.productDatabase);
			legacy.exec("CREATE TABLE legacy_product (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			mkdirSync(bootstrap.paths.agentDataDirectory, { recursive: true });
			const marker = join(bootstrap.paths.agentDataDirectory, "pi-data-marker");
			writeFileSync(marker, "keep");
			const diagnostics: string[] = [];
			const instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => fakeRuntime(),
				reportDiagnostic: (message) => diagnostics.push(message),
			});
			try {
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
				expect(readFileSync(marker, "utf8")).toBe("keep");
				expect(diagnostics).toEqual([
					"Reset the local product store (product-schema-cutover, previous product schema 6).",
				]);
				expect(diagnostics[0]).not.toContain(directory);
			} finally {
				await instance.shutdown();
			}
		});
	});

	test("leaves a current product schema intact without reset diagnostics", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const product = openAppDatabase(bootstrap.paths.productDatabase);
			const session = product.sessions.create({ title: "Retained" }).session;
			product.close();
			const diagnostics: string[] = [];
			const instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => fakeRuntime(),
				reportDiagnostic: (message) => diagnostics.push(message),
			});
			try {
				await instance.ready;
				const reopened = openAppDatabase(bootstrap.paths.productDatabase);
				expect(reopened.sessions.get({ sessionId: session.id }).title).toBe("Retained");
				reopened.close();
				expect(diagnostics).toEqual([]);
			} finally {
				await instance.shutdown();
			}
		});
	});
});

function fakeRuntime(
	deleteThread: (threadId: string) => Promise<void> = async () => {},
): AskChatRuntime {
	return {
		run: async () => {
			throw new Error("Not used.");
		},
		stream: () => {
			throw new Error("Not used.");
		},
		cancel: () => false,
		getThreadMessages: async () => [],
		deleteThread,
		shutdown: async () => {},
	};
}

function createBootstrap(directory: string): AgentsServerBootstrapRecord {
	return {
		channel: "moshu-companion-bootstrap",
		controlVersion: 2,
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
			agentDataDirectory: resolve(directory, "agent-data"),
		},
	};
}

async function withServerDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = resolve(
		process.cwd(),
		".test-artifacts",
		`agents-startup-${crypto.randomUUID()}`,
	);
	mkdirSync(directory, { recursive: true });
	try {
		await run(directory);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
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
		if (timer !== undefined) clearTimeout(timer);
	}
}
