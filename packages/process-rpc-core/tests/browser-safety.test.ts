import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function listCoreSourceFiles(): string[] {
	return readdirSync(srcDir)
		.filter((name) => name.endsWith(".ts"))
		.sort();
}

/**
 * The browser-safe core must run inside a WKWebView / Capacitor bridge, so it may not depend on any
 * Node or Bun runtime surface. These patterns are the concrete leaks that would break a browser
 * host: `node:` builtins, the `ws` / `rpc-websocket-client` transports, and the `Bun`, `Buffer`,
 * and `process` globals. The transport-neutral core reaches every host exclusively through
 * `RpcSocketTransport`, `crypto.randomUUID`, `TextEncoder`, and the timer/AbortSignal web globals.
 */
const forbiddenPatterns: readonly { readonly label: string; readonly pattern: RegExp }[] = [
	{ label: "node: builtin import", pattern: /from\s+["']node:[^"']+["']/ },
	{ label: "node: builtin import (bare)", pattern: /import\s+["']node:[^"']+["']/ },
	{ label: "ws import", pattern: /from\s+["']ws["']/ },
	{ label: "rpc-websocket-client import", pattern: /from\s+["']rpc-websocket-client["']/ },
	{ label: "CommonJS require", pattern: /\brequire\s*\(/ },
	{ label: "Bun global", pattern: /\bBun\./ },
	{ label: "Buffer global", pattern: /\bBuffer\b/ },
	{ label: "Node process global", pattern: /\bprocess\.[a-z]/ },
];

describe("@moshu/process-rpc-core browser safety", () => {
	test("exposes the expected transport-neutral source modules", () => {
		expect(listCoreSourceFiles()).toEqual([
			"callback-errors.ts",
			"errors.ts",
			"generation-fence.ts",
			"index.ts",
			"internal.ts",
			"json-structure.ts",
			"limits.ts",
			"peer.ts",
			"protocol.ts",
			"transport.ts",
			"websocket-utils.ts",
		]);
	});

	for (const fileName of listCoreSourceFiles()) {
		test(`${fileName} has no Node or Bun dependency`, () => {
			const contents = readFileSync(`${srcDir}/${fileName}`, "utf8");
			for (const { label, pattern } of forbiddenPatterns) {
				expect(pattern.test(contents), `${fileName} must not contain a ${label}.`).toBe(false);
			}
		});
	}
});
