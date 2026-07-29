import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	normalizeRuntimeBaseUrl,
	RemoteRuntimeBoxState,
	resolveRemoteRuntimeBoxRoot,
} from "./remote-state";

describe("RemoteRuntimeBoxState", () => {
	test("persists private config and monotonic connection generations", () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-state-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			state.write({
				schemaVersion: 1,
				runtimeBaseUrl: "https://runtime.example",
				runtimeBoxId: "remote-box",
				deviceKeyId: "device-key",
				publicKey: Buffer.alloc(32, 1).toString("base64url"),
				privateKey: Buffer.alloc(48, 2).toString("base64url"),
				agentServerId: "550e8400-e29b-41d4-a716-446655440000",
				agentServerPublicKey: Buffer.alloc(32, 3).toString("base64url"),
				generation: 0,
				displayName: "Remote Box",
			});
			expect(state.nextConnectionIdentity().generation).toBe(1);
			expect(state.nextConnectionIdentity().generation).toBe(2);
			expect(state.read().generation).toBe(2);
			if (process.platform !== "win32") {
				expect(statSync(state.configPath).mode & 0o777).toBe(0o600);
			}
			state.unpair();
			expect(state.isPaired()).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("resolves platform data roots and accepts only secure remote URLs", () => {
		expect(resolveRemoteRuntimeBoxRoot({ XDG_DATA_HOME: "/data" }, "linux", "/home/test")).toBe(
			"/data/moshu/runtime-box",
		);
		expect(
			resolveRemoteRuntimeBoxRoot(
				{ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
				"win32",
				"C:\\Users\\test",
			).replaceAll("\\", "/"),
		).toContain("AppData/Local/Moshu/runtime-box");
		expect(normalizeRuntimeBaseUrl("https://runtime.example/")).toBe("https://runtime.example");
		expect(normalizeRuntimeBaseUrl("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000");
		expect(() => normalizeRuntimeBaseUrl("http://runtime.example")).toThrow("requires HTTPS");
		expect(() => normalizeRuntimeBaseUrl("https://user@runtime.example")).toThrow(
			"cannot contain credentials",
		);
	});
});
