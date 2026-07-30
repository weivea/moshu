import { describe, expect, test } from "vitest";

import { getImportedMcpServerKey, parseMcpConfigJson } from "./mcp-config-json";

describe("MCP JSON configuration import", () => {
	test("parses common mcpServers stdio and remote configurations", () => {
		expect(
			parseMcpConfigJson(
				JSON.stringify({
					mcpServers: {
						filesystem: {
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
							cwd: "/workspace",
							env: { FILE_TOKEN: "write-only" },
						},
						remote: {
							type: "sse",
							disabled: true,
							url: "https://mcp.example.test/events",
							headers: { Authorization: "Bearer write-only" },
							timeoutMs: 45_000,
						},
					},
				}),
			),
		).toEqual([
			{
				displayName: "filesystem",
				enabled: true,
				transport: {
					type: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
					cwd: "/workspace",
					startupTimeoutMs: 30_000,
				},
				secret: { environment: { FILE_TOKEN: "write-only" } },
			},
			{
				displayName: "remote",
				enabled: false,
				transport: {
					type: "sse",
					url: "https://mcp.example.test/events",
					timeoutMs: 45_000,
				},
				secret: { headers: { Authorization: "Bearer write-only" } },
			},
		]);
	});

	test("parses a direct Moshu-style transport object", () => {
		expect(
			parseMcpConfigJson(
				JSON.stringify({
					displayName: "Direct HTTP",
					enabled: false,
					transport: {
						type: "streamable-http",
						url: "https://mcp.example.test/rpc",
						timeoutMs: 20_000,
					},
					secret: { headers: { "X-API-Key": "write-only" } },
				}),
			),
		).toEqual([
			{
				displayName: "Direct HTTP",
				enabled: false,
				transport: {
					type: "streamable-http",
					url: "https://mcp.example.test/rpc",
					timeoutMs: 20_000,
				},
				secret: { headers: { "X-API-Key": "write-only" } },
			},
		]);
	});

	test("rejects malformed roots and non-string secret values without echoing them", () => {
		expect(() => parseMcpConfigJson('{"unknown":true}')).toThrowError(
			expect.objectContaining({ code: "invalid-root" }),
		);
		expect(() =>
			parseMcpConfigJson(
				JSON.stringify({
					mcpServers: {
						broken: {
							command: "node",
							env: { TOKEN: 42 },
						},
					},
				}),
			),
		).toThrowError(expect.objectContaining({ code: "invalid-server" }));
		expect(() =>
			parseMcpConfigJson(
				JSON.stringify({
					name: "Unsupported",
					type: "websocket",
					url: "https://mcp.example.test/socket",
				}),
			),
		).toThrowError(expect.objectContaining({ code: "invalid-server" }));
		expect(() =>
			parseMcpConfigJson(
				JSON.stringify({
					name: "Ambiguous",
					command: "node",
					disabled: "true",
				}),
			),
		).toThrowError(expect.objectContaining({ code: "invalid-server" }));
		for (const transport of [
			{ type: null, url: "https://mcp.example.test/rpc" },
			{ type: "stdio", command: "node", args: null },
			{
				type: "streamable-http",
				url: "https://mcp.example.test/rpc",
				timeoutMs: null,
			},
		]) {
			expect(() =>
				parseMcpConfigJson(JSON.stringify({ name: "Explicit null", transport })),
			).toThrowError(expect.objectContaining({ code: "invalid-server" }));
		}
	});

	test("creates stable semantic keys regardless of JSON object key order", () => {
		const [first] = parseMcpConfigJson(
			'{"name":"Remote","url":"https://mcp.example.test/rpc","headers":{"B":"2","A":"1"}}',
		);
		const [second] = parseMcpConfigJson(
			'{"headers":{"A":"1","B":"2"},"url":"https://mcp.example.test/rpc","name":"Remote"}',
		);
		if (first === undefined || second === undefined) {
			throw new Error("Expected both MCP JSON configurations to parse.");
		}
		expect(getImportedMcpServerKey(first)).toBe(getImportedMcpServerKey(second));
	});
});
