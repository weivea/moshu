import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpLifecycleManager } from "./mcp-lifecycle-manager";
import { McpToolOutcomeUnknownError } from "./mcp-client";
import { RuntimeResourceStore } from "./runtime-resource-store";

describe("McpLifecycleManager", () => {
	test("loads credentials only into the target connection and publishes live Tool inventory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "database-tools",
				displayName: "Database Tools",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
				secret: { environment: { DATABASE_TOKEN: "runtime-box-only" } },
			});
			let receivedSecret: unknown;
			let closeCalls = 0;
			let toolCalls = 0;
			const manager = new McpLifecycleManager(store, {
				connect: async (input) => {
					receivedSecret = input.secret;
					return {
						tools: [
							{
								stableToolId: "tool-query",
								name: "query",
								schemaHash: "a".repeat(64),
								inputSchema: {
									type: "object",
									properties: { sql: { type: "string" } },
									required: ["sql"],
								},
							},
						],
						async callTool(stableToolId, argumentsValue) {
							toolCalls += 1;
							return { stableToolId, argumentsValue };
						},
						async close() {
							closeCalls += 1;
						},
					};
				},
			});
			await manager.start();
			expect(receivedSecret).toEqual({
				environment: { DATABASE_TOKEN: "runtime-box-only" },
			});
			const ready = store.listMcpServers("runtime-box-test").items[0];
			expect(ready).toMatchObject({
				health: "ready",
				tools: [{ stableToolId: "tool-query", name: "query" }],
			});
			if (ready === undefined) {
				throw new Error("Expected an MCP Server.");
			}
			const binding = {
				version: ready.version,
				contentHash: ready.contentHash,
				schemaHash: ready.tools[0]?.schemaHash ?? "",
			};
			expect(
				manager.isToolReady("database-tools", "tool-query", {
					...binding,
					version: crypto.randomUUID(),
				}),
			).toBe(false);
			await expect(
				manager.callTool(
					"database-tools",
					"tool-query",
					{ sql: "select stale" },
					{
						...binding,
						schemaHash: "f".repeat(64),
					},
				),
			).rejects.toThrow("not ready");
			expect(toolCalls).toBe(0);
			expect(
				await manager.callTool("database-tools", "tool-query", { sql: "select 1" }, binding),
			).toEqual({
				stableToolId: "tool-query",
				argumentsValue: { sql: "select 1" },
			});
			expect(toolCalls).toBe(1);

			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: ready.stableResourceId,
				expectedVersion: ready.version,
				displayName: ready.displayName,
				enabled: false,
				transport: ready.transport,
			});
			await waitFor(() => store.listMcpServers("runtime-box-test").items[0]?.health === "stopped");
			expect(closeCalls).toBe(1);
			expect(manager.isToolReady("database-tools", "tool-query", binding)).toBe(false);
			await manager.shutdown();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("an old call failure cannot close a replacement shared connection", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-replacement-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "shared-server",
				displayName: "Shared",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			const oldCall = Promise.withResolvers<never>();
			let connectCount = 0;
			const closeCalls = [0, 0];
			const manager = new McpLifecycleManager(store, {
				connect: async () => {
					const index = connectCount++;
					return {
						tools: [
							{
								stableToolId: "tool-query",
								name: "query",
								schemaHash: "a".repeat(64),
								inputSchema: { type: "object", properties: {} },
							},
						],
						async callTool() {
							if (index === 0) {
								return oldCall.promise;
							}
							return { content: [{ type: "text", text: "replacement" }] };
						},
						async close() {
							closeCalls[index] = (closeCalls[index] ?? 0) + 1;
						},
					};
				},
			});
			await manager.start();
			const first = store.listMcpServers("runtime-box").items[0];
			if (first === undefined) {
				throw new Error("Expected the first MCP connection.");
			}
			const firstBinding = {
				version: first.version,
				contentHash: first.contentHash,
				schemaHash: first.tools[0]?.schemaHash ?? "",
			};
			const pendingCall = manager.callTool("shared-server", "tool-query", {}, firstBinding);
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: first.stableResourceId,
				expectedVersion: first.version,
				displayName: first.displayName,
				enabled: true,
				transport: first.transport,
			});
			await waitFor(
				() =>
					connectCount === 2 && store.listMcpServers("runtime-box").items[0]?.health === "ready",
			);
			const replacement = store.listMcpServers("runtime-box").items[0];
			if (replacement === undefined) {
				throw new Error("Expected the replacement MCP connection.");
			}
			oldCall.reject(new McpToolOutcomeUnknownError("old request lost"));
			await expect(pendingCall).rejects.toBeInstanceOf(McpToolOutcomeUnknownError);
			expect(closeCalls[1]).toBe(0);
			await expect(
				manager.callTool(
					"shared-server",
					"tool-query",
					{},
					{
						version: replacement.version,
						contentHash: replacement.contentHash,
						schemaHash: replacement.tools[0]?.schemaHash ?? "",
					},
				),
			).resolves.toMatchObject({ content: [{ text: "replacement" }] });
			await manager.shutdown();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("tracks deletion cleanup until shutdown completes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-delete-drain-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			const created = store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "delete-server",
				displayName: "Delete",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			const closeStarted = Promise.withResolvers<void>();
			const releaseClose = Promise.withResolvers<void>();
			const manager = new McpLifecycleManager(store, {
				connect: async () => ({
					tools: [],
					async callTool() {
						return null;
					},
					async close() {
						closeStarted.resolve();
						await releaseClose.promise;
					},
				}),
			});
			await manager.start();
			const live = store.listMcpServers("runtime-box").items[0];
			store.deleteMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: created.stableResourceId,
				expectedVersion: live?.version ?? created.version,
				deleteCredentials: true,
			});
			await closeStarted.promise;
			let shutdownSettled = false;
			const shutdown = manager.shutdown().then(() => {
				shutdownSettled = true;
			});
			await Bun.sleep(0);
			expect(shutdownSettled).toBe(false);
			releaseClose.resolve();
			await shutdown;
			expect(shutdownSettled).toBe(true);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("closes an uncommitted connection when deletion wins a pending connect", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-pending-delete-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			const created = store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "pending-server",
				displayName: "Pending",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			const connectStarted = Promise.withResolvers<void>();
			const releaseConnect = Promise.withResolvers<void>();
			let closeCalls = 0;
			const manager = new McpLifecycleManager(store, {
				reportDiagnostic() {},
				connect: async () => {
					connectStarted.resolve();
					await releaseConnect.promise;
					return {
						tools: [],
						async callTool() {
							return null;
						},
						async close() {
							closeCalls += 1;
							if (closeCalls === 1) {
								throw new Error("first pending cleanup failed");
							}
						},
					};
				},
			});
			const starting = manager.start();
			await connectStarted.promise;
			store.deleteMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: created.stableResourceId,
				expectedVersion: created.version,
				deleteCredentials: true,
			});
			releaseConnect.resolve();
			await starting;
			await waitFor(() => closeCalls === 2);
			await manager.shutdown();
			expect(closeCalls).toBe(2);
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("retries failed cleanup before installing a replacement connection", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-close-retry-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "retry-server",
				displayName: "Retry",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			let connectCount = 0;
			let closeCalls = 0;
			const manager = new McpLifecycleManager(store, {
				reconnectDelayMs: 10,
				reportDiagnostic() {},
				connect: async () => {
					connectCount += 1;
					return {
						tools: [],
						async callTool() {
							return null;
						},
						async close() {
							closeCalls += 1;
							if (closeCalls <= 2) {
								throw new Error("close failed");
							}
						},
					};
				},
			});
			await manager.start();
			const live = store.listMcpServers("runtime-box").items[0];
			if (live === undefined) {
				throw new Error("Expected an MCP Server.");
			}
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: live.stableResourceId,
				expectedVersion: live.version,
				displayName: live.displayName,
				enabled: true,
				transport: live.transport,
			});
			await waitFor(
				() =>
					closeCalls === 3 &&
					connectCount === 2 &&
					store.listMcpServers("runtime-box").items[0]?.health === "ready",
			);
			await manager.shutdown();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("continues reconnecting after repeated connection failures", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-lifecycle-connect-retry-"));
		try {
			const store = new RuntimeResourceStore(join(directory, "resources"));
			store.upsertMcpServer({
				commandId: crypto.randomUUID(),
				stableResourceId: "connect-retry-server",
				displayName: "Connect retry",
				enabled: true,
				transport: {
					type: "stdio",
					command: "/unused/mcp",
					args: [],
					startupTimeoutMs: 10_000,
				},
			});
			const firstClosed = Promise.withResolvers<void>();
			let connectCount = 0;
			const manager = new McpLifecycleManager(store, {
				reconnectDelayMs: 5,
				reportDiagnostic() {},
				connect: async () => {
					connectCount += 1;
					if (connectCount === 2 || connectCount === 3) {
						throw new Error("temporary connect failure");
					}
					return {
						tools: [],
						...(connectCount === 1 ? { closed: firstClosed.promise } : {}),
						async callTool() {
							return null;
						},
						async close() {},
					};
				},
			});
			await manager.start();
			firstClosed.resolve();
			await waitFor(
				() =>
					connectCount === 4 && store.listMcpServers("runtime-box").items[0]?.health === "ready",
			);
			await manager.shutdown();
			store.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Condition timed out.");
		}
		await Bun.sleep(5);
	}
}
