import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	test("keeps Product RPC available when the persisted Runtime ingress port conflicts", async () => {
		await withServerDirectory(async (directory) => {
			const blocker = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response("occupied"),
			});
			if (blocker.port === undefined) {
				throw new Error("Port blocker did not bind a port.");
			}
			const bootstrap = createBootstrap(directory);
			const database = openAppDatabase(bootstrap.paths.productDatabase);
			database.remoteAccess.setRuntimeIngressPort(blocker.port);
			database.remoteAccess.setEnabled(true);
			database.close();
			const instance = await createAgentsServer({
				bootstrap,
				serverVersion: "test",
				createRuntime: () => fakeRuntime(),
			});
			try {
				expect(instance.productRpcServer.port).toBeGreaterThan(0);
				expect(instance.runtimeRpcServer.port).not.toBe(blocker.port);
				expect(instance.devTunnelService.getStatus()).toMatchObject({
					enabled: true,
					state: "repair_required",
					runtimeIngressPort: instance.runtimeRpcServer.port,
				});
			} finally {
				await instance.shutdown();
				await blocker.stop(true);
			}
		});
	});

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
				expect(receivedExecutorGateway).toBe(instance.runtimeBoxRegistry);
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

	test("resets an old product schema and only removes app-owned Pi Sessions", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const legacy = new Database(bootstrap.paths.productDatabase);
			legacy.exec("CREATE TABLE legacy_product (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			mkdirSync(bootstrap.paths.agentDataDirectory, { recursive: true });
			const marker = join(bootstrap.paths.agentDataDirectory, "pi-data-marker");
			writeFileSync(marker, "keep");
			const sessions = join(bootstrap.paths.agentDataDirectory, "sessions");
			mkdirSync(sessions);
			writeFileSync(join(sessions, "obsolete.jsonl"), "remove");
			const credentials = join(bootstrap.paths.agentDataDirectory, "credentials");
			const diagnosticsDirectory = join(bootstrap.paths.agentDataDirectory, "diagnostics");
			const mcpDirectory = join(bootstrap.paths.agentDataDirectory, "mcp-secrets");
			const skillsDirectory = join(bootstrap.paths.agentDataDirectory, "server-skills");
			mkdirSync(credentials);
			mkdirSync(diagnosticsDirectory);
			mkdirSync(mcpDirectory);
			mkdirSync(skillsDirectory);
			writeFileSync(join(credentials, "marker"), "credentials");
			writeFileSync(join(diagnosticsDirectory, "marker"), "diagnostics");
			writeFileSync(join(mcpDirectory, "marker"), "mcp");
			writeFileSync(join(bootstrap.paths.agentDataDirectory, "providers.json"), '{"providers":[]}');
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
				expect(existsSync(sessions)).toBe(false);
				expect(readFileSync(marker, "utf8")).toBe("keep");
				expect(readFileSync(join(credentials, "marker"), "utf8")).toBe("credentials");
				expect(readFileSync(join(diagnosticsDirectory, "marker"), "utf8")).toBe("diagnostics");
				expect(readFileSync(join(mcpDirectory, "marker"), "utf8")).toBe("mcp");
				expect(existsSync(skillsDirectory)).toBe(true);
				expect(existsSync(join(bootstrap.paths.agentDataDirectory, "providers.json"))).toBe(true);
				expect(diagnostics).toEqual([
					"Reset the local product store (product-schema-cutover, previous product schema 6).",
				]);
				expect(diagnostics[0]).not.toContain(directory);
			} finally {
				await instance.shutdown();
			}
		});
	});

	test("stops a coordinated reset when Pi Session storage is a symlink", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const legacy = new Database(bootstrap.paths.productDatabase);
			legacy.exec("PRAGMA user_version = 6;");
			legacy.close();
			mkdirSync(bootstrap.paths.agentDataDirectory, { recursive: true });
			const external = join(directory, "external-sessions");
			mkdirSync(external);
			const externalMarker = join(external, "keep.jsonl");
			writeFileSync(externalMarker, "keep");
			symlinkSync(external, join(bootstrap.paths.agentDataDirectory, "sessions"));

			await expect(
				createAgentsServer({
					bootstrap,
					serverVersion: "test",
					createRuntime: () => fakeRuntime(),
				}),
			).rejects.toThrow("Pi Session storage must be a regular directory.");
			expect(readFileSync(externalMarker, "utf8")).toBe("keep");
			const preserved = new Database(bootstrap.paths.productDatabase, { readonly: true });
			try {
				expect(
					preserved.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
				).toBe(6);
			} finally {
				preserved.close();
			}
		});
	});

	test("stops a coordinated reset when Pi Session storage is not a directory", async () => {
		await withServerDirectory(async (directory) => {
			const bootstrap = createBootstrap(directory);
			const legacy = new Database(bootstrap.paths.productDatabase);
			legacy.exec("PRAGMA user_version = 6;");
			legacy.close();
			mkdirSync(bootstrap.paths.agentDataDirectory, { recursive: true });
			const sessions = join(bootstrap.paths.agentDataDirectory, "sessions");
			writeFileSync(sessions, "unsafe");

			await expect(
				createAgentsServer({
					bootstrap,
					serverVersion: "test",
					createRuntime: () => fakeRuntime(),
				}),
			).rejects.toThrow("Pi Session storage must be a regular directory.");
			expect(readFileSync(sessions, "utf8")).toBe("unsafe");
			const preserved = new Database(bootstrap.paths.productDatabase, { readonly: true });
			try {
				expect(
					preserved.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
				).toBe(6);
			} finally {
				preserved.close();
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
			{
				credential: Buffer.alloc(32, 8).toString("base64url"),
				identity: {
					role: "runtime-box",
					peerId: "runtime-box-startup-test",
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
