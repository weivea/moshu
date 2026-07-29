import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectMcpServer, McpToolOutcomeUnknownError } from "./mcp-client";

describe("MCP client", () => {
	test("initializes, inventories, and invokes a stdio MCP Server", async () => {
		const script = String.raw`
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
			rl.on("line", (line) => {
				const message = JSON.parse(line);
				if (message.method === "initialize") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						serverInfo: { name: "fixture", version: "1" }
					}});
				} else if (message.method === "tools/list") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						tools: [{
							name: "echo",
							description: "Echo input",
							inputSchema: {
								type: "object",
								properties: { text: { type: "string" } },
								required: ["text"],
								additionalProperties: false
							}
						}]
					}});
				} else if (message.method === "tools/call") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						content: [{ type: "text", text: message.params.arguments.text }]
					}});
				}
			});
		`;
		const connection = await connectMcpServer({
			transport: {
				type: "stdio",
				command: process.execPath,
				args: ["-e", script],
				startupTimeoutMs: 10_000,
			},
		});
		try {
			expect(connection.tools).toHaveLength(1);
			expect(connection.tools[0]).toMatchObject({ name: "echo" });
			const stableToolId = connection.tools[0]?.stableToolId;
			if (stableToolId === undefined) {
				throw new Error("Expected an MCP Tool.");
			}
			await expect(connection.callTool(stableToolId, { text: "hello" })).resolves.toEqual({
				content: [{ type: "text", text: "hello" }],
			});
		} finally {
			await connection.close();
		}
	});

	test("initializes and closes a Streamable HTTP MCP session", async () => {
		let deleteCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					expect(request.headers.get("mcp-session-id")).toBe("session-1");
					deleteCalls += 1;
					return new Response(null, { status: 204 });
				}
				const message = (await request.json()) as {
					id?: number;
					method: string;
					params?: { arguments?: unknown };
				};
				if (message.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				const result =
					message.method === "initialize"
						? { protocolVersion: "2025-03-26", capabilities: {} }
						: message.method === "tools/list"
							? {
									tools: [
										{
											name: "echo",
											inputSchema: { type: "object", properties: {} },
										},
									],
								}
							: { content: [{ type: "text", text: JSON.stringify(message.params?.arguments) }] };
				if (message.method === "tools/call") {
					const encoder = new TextEncoder();
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								for (const [id, eventResult] of [
									[999, { ignored: true }],
									[message.id, result],
								] as const) {
									enqueueSplit(
										controller,
										encoder.encode(
											`data: ${JSON.stringify({
												jsonrpc: "2.0",
												id,
												result: eventResult,
											})}\r\n\r\n`,
										),
									);
								}
							},
						}),
						{
							headers: {
								"content-type": "text/event-stream",
								"mcp-session-id": "session-1",
							},
						},
					);
				}
				return Response.json(
					{ jsonrpc: "2.0", id: message.id, result },
					{ headers: { "mcp-session-id": "session-1" } },
				);
			},
		});
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "streamable-http",
					url: server.url.toString(),
					timeoutMs: 10_000,
				},
			});
			const toolId = connection.tools[0]?.stableToolId;
			if (toolId === undefined) {
				throw new Error("Expected an HTTP MCP Tool.");
			}
			await expect(connection.callTool(toolId, { value: 1 })).resolves.toMatchObject({
				content: [{ type: "text" }],
			});
			await connection.close();
			expect(deleteCalls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("closes an expired Streamable HTTP session so lifecycle can reconnect", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const message = (await request.json()) as { id?: number; method: string };
				if (message.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				if (message.method === "tools/call") {
					return new Response(null, { status: 404 });
				}
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result:
							message.method === "initialize"
								? { protocolVersion: "2025-03-26", capabilities: {} }
								: {
										tools: [
											{
												name: "expire",
												inputSchema: { type: "object", properties: {} },
											},
										],
									},
					},
					{ headers: { "mcp-session-id": "expired-session" } },
				);
			},
		});
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "streamable-http",
					url: server.url.toString(),
					timeoutMs: 10_000,
				},
			});
			const toolId = connection.tools[0]?.stableToolId;
			if (toolId === undefined || connection.closed === undefined) {
				throw new Error("Expected an expiring HTTP MCP session.");
			}
			const error = await connection.callTool(toolId, {}).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(McpToolOutcomeUnknownError);
			await connection.closed;
		} finally {
			await server.stop(true);
		}
	});

	test("deletes an HTTP session when post-initialize setup fails", async () => {
		let deleteCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					deleteCalls += 1;
					return new Response(null, { status: 204 });
				}
				const message = (await request.json()) as { id?: number; method: string };
				if (message.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				if (message.method === "tools/list") {
					return new Response(null, { status: 500 });
				}
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result: { protocolVersion: "2025-03-26", capabilities: {} },
					},
					{ headers: { "mcp-session-id": "setup-session" } },
				);
			},
		});
		try {
			await expect(
				connectMcpServer({
					transport: {
						type: "streamable-http",
						url: server.url.toString(),
						timeoutMs: 10_000,
					},
				}),
			).rejects.toThrow("status 500");
			expect(deleteCalls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("deletes an HTTP session when initialize validation fails", async () => {
		let deleteCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					deleteCalls += 1;
					return new Response(null, { status: 204 });
				}
				const message = (await request.json()) as { id?: number };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: {} },
					},
					{ headers: { "mcp-session-id": "invalid-initialize-session" } },
				);
			},
		});
		try {
			await expect(
				connectMcpServer({
					transport: {
						type: "streamable-http",
						url: server.url.toString(),
						timeoutMs: 10_000,
					},
				}),
			).rejects.toThrow("invalid result");
			expect(deleteCalls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("deletes an HTTP session when initialize JSON is malformed", async () => {
		let deleteCalls = 0;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (request.method === "DELETE") {
					deleteCalls += 1;
					return new Response(null, { status: 204 });
				}
				return new Response("{", {
					status: 200,
					headers: {
						"content-type": "application/json",
						"mcp-session-id": "malformed-session",
					},
				});
			},
		});
		try {
			await expect(
				connectMcpServer({
					transport: {
						type: "streamable-http",
						url: server.url.toString(),
						timeoutMs: 10_000,
					},
				}),
			).rejects.toBeInstanceOf(Error);
			expect(deleteCalls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("retries HTTP session cleanup after a failed DELETE", async () => {
		let deleteCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					deleteCalls += 1;
					return new Response(null, { status: deleteCalls === 1 ? 500 : 204 });
				}
				const message = (await request.json()) as { id?: number; method: string };
				if (message.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result:
							message.method === "initialize"
								? { protocolVersion: "2025-03-26", capabilities: {} }
								: { tools: [] },
					},
					{ headers: { "mcp-session-id": "retry-close-session" } },
				);
			},
		});
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "streamable-http",
					url: server.url.toString(),
					timeoutMs: 10_000,
				},
			});
			await expect(connection.close()).rejects.toThrow("status 500");
			await expect(connection.close()).resolves.toBeUndefined();
			expect(deleteCalls).toBe(2);
		} finally {
			await server.stop(true);
		}
	});

	test("terminates a stdio process tree after a protocol failure", async () => {
		const script = String.raw`
			const readline = require("node:readline");
			const rl = readline.createInterface({ input: process.stdin });
			const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
			rl.on("line", (line) => {
				const message = JSON.parse(line);
				if (message.method === "initialize") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						protocolVersion: "2025-03-26", capabilities: {}
					}});
				} else if (message.method === "tools/list") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						tools: [{ name: "break", inputSchema: { type: "object", properties: {} } }]
					}});
				} else if (message.method === "tools/call") {
					process.stdout.write("not-json\n");
					setInterval(() => {}, 1000);
				}
			});
		`;
		const connection = await connectMcpServer({
			transport: {
				type: "stdio",
				command: process.execPath,
				args: ["-e", script],
				startupTimeoutMs: 10_000,
			},
		});
		const toolId = connection.tools[0]?.stableToolId;
		if (toolId === undefined || connection.closed === undefined) {
			throw new Error("Expected a close-observable MCP Tool.");
		}
		await expect(connection.callTool(toolId, {})).rejects.toBeInstanceOf(
			McpToolOutcomeUnknownError,
		);
		await expect(
			Promise.race([
				connection.closed,
				Bun.sleep(2_000).then(() => {
					throw new Error("MCP process tree cleanup timed out.");
				}),
			]),
		).resolves.toBeUndefined();
		await connection.close();
	});

	test("cleans descendants even when the stdio root exits first", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-mcp-descendant-"));
		const pidFile = join(directory, "child.pid");
		const script = String.raw`
			const readline = require("node:readline");
			const { spawn } = require("node:child_process");
			const { writeFileSync } = require("node:fs");
			const rl = readline.createInterface({ input: process.stdin });
			const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
			rl.on("line", (line) => {
				const message = JSON.parse(line);
				if (message.method === "initialize") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						protocolVersion: "2025-03-26", capabilities: {}
					}});
				} else if (message.method === "tools/list") {
					send({ jsonrpc: "2.0", id: message.id, result: {
						tools: [{ name: "spawn", inputSchema: { type: "object", properties: {} } }]
					}});
				} else if (message.method === "tools/call") {
					const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
						stdio: "ignore"
					});
					writeFileSync(process.argv[1], String(child.pid));
					process.exit(0);
				}
			});
		`;
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "stdio",
					command: process.execPath,
					args: ["-e", script, pidFile],
					startupTimeoutMs: 10_000,
				},
			});
			const toolId = connection.tools[0]?.stableToolId;
			if (toolId === undefined || connection.closed === undefined) {
				throw new Error("Expected a descendant-spawning MCP Tool.");
			}
			await expect(connection.callTool(toolId, {})).rejects.toBeInstanceOf(
				McpToolOutcomeUnknownError,
			);
			await connection.closed;
			const childPid = Number(readFileSync(pidFile, "utf8"));
			await waitForProcessExit(childPid);
			expect(isProcessAlive(childPid)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("supports the legacy same-origin SSE MCP transport", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") {
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							enqueueSplit(
								controller,
								encoder.encode(`event: endpoint\r\ndata: /messages\r\n\r\n`),
							);
						},
					});
					return new Response(body, {
						headers: { "content-type": "text/event-stream" },
					});
				}
				const message = (await request.json()) as {
					id?: number;
					method: string;
					params?: { arguments?: unknown };
				};
				if (message.id !== undefined) {
					const result =
						message.method === "initialize"
							? { protocolVersion: "2025-03-26", capabilities: {} }
							: message.method === "tools/list"
								? {
										tools: [
											{
												name: "echo",
												inputSchema: { type: "object", properties: {} },
											},
										],
									}
								: { content: [{ type: "text", text: JSON.stringify(message.params?.arguments) }] };
					if (streamController !== undefined) {
						enqueueSplit(
							streamController,
							encoder.encode(
								`event: message\r\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: message.id,
									result,
								})}\r\n\r\n`,
							),
						);
					}
				}
				return new Response(null, { status: 202 });
			},
		});
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "sse",
					url: server.url.toString(),
					timeoutMs: 10_000,
				},
			});
			const toolId = connection.tools[0]?.stableToolId;
			if (toolId === undefined) {
				throw new Error("Expected an SSE MCP Tool.");
			}
			await expect(connection.callTool(toolId, { value: 2 })).resolves.toMatchObject({
				content: [{ type: "text" }],
			});
			await connection.close();
		} finally {
			streamController?.close();
			await server.stop(true);
		}
	});

	test("cancels the legacy SSE stream after a protocol error", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let cancelCalls = 0;
		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							},
							cancel() {
								cancelCalls += 1;
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				const message = (await request.json()) as { id?: number; method: string };
				if (message.method === "tools/call") {
					streamController?.enqueue(encoder.encode("event: message\ndata: not-json\n\n"));
				} else if (message.id !== undefined) {
					streamController?.enqueue(
						encoder.encode(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: message.id,
								result:
									message.method === "initialize"
										? { protocolVersion: "2025-03-26", capabilities: {} }
										: {
												tools: [
													{
														name: "break",
														inputSchema: { type: "object", properties: {} },
													},
												],
											},
							})}\n\n`,
						),
					);
				}
				return new Response(null, { status: 202 });
			},
		});
		try {
			const connection = await connectMcpServer({
				transport: {
					type: "sse",
					url: server.url.toString(),
					timeoutMs: 10_000,
				},
			});
			const toolId = connection.tools[0]?.stableToolId;
			if (toolId === undefined || connection.closed === undefined) {
				throw new Error("Expected a close-observable SSE Tool.");
			}
			await expect(connection.callTool(toolId, {})).rejects.toBeInstanceOf(
				McpToolOutcomeUnknownError,
			);
			await connection.closed;
			await connection.close();
			for (let attempt = 0; attempt < 20 && cancelCalls === 0; attempt += 1) {
				await Bun.sleep(10);
			}
			expect(cancelCalls).toBe(1);
		} finally {
			await server.stop(true);
		}
	});
});

function enqueueSplit(
	controller: ReadableStreamDefaultController<Uint8Array>,
	bytes: Uint8Array,
): void {
	for (const byte of bytes) {
		controller.enqueue(Uint8Array.of(byte));
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) {
			throw new Error(`Process ${pid} did not exit.`);
		}
		await Bun.sleep(10);
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}
