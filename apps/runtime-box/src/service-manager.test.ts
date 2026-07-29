import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteRuntimeBoxState } from "./remote-state";
import {
	createLaunchAgent,
	createSystemdUnit,
	createWindowsTaskXml,
	RuntimeBoxServiceManager,
	type ServiceCommandRunner,
} from "./service-manager";

class RecordingRunner implements ServiceCommandRunner {
	readonly commands: Array<{
		command: readonly string[];
		allowedExitCodes: readonly number[];
	}> = [];

	run(command: readonly string[], allowedExitCodes: readonly number[] = []): Promise<void> {
		this.commands.push({ command, allowedExitCodes });
		return Promise.resolve();
	}
}

describe("RuntimeBoxServiceManager", () => {
	test("renders escaped user-service definitions", () => {
		expect(createSystemdUnit('/opt/Moshu "Box"', "/home/test/runtime box")).toContain(
			'ExecStart="/opt/Moshu \\"Box\\"" run --data-dir "/home/test/runtime box"',
		);
		expect(createLaunchAgent("/Applications/Moshu & Box", "/Users/test/A < B")).toContain(
			"/Applications/Moshu &amp; Box",
		);
		expect(createLaunchAgent("/Applications/Moshu & Box", "/Users/test/A < B")).toContain(
			"/Users/test/A &lt; B",
		);
		expect(createWindowsTaskXml("C:\\Moshu.exe", "C:\\Data")).toContain(
			"<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		);
		expect(createWindowsTaskXml("C:\\Moshu.exe", "C:\\Data")).toContain(
			"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		);
	});

	test("installs and uninstalls a Linux user service without deleting Runtime data", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-service-manager-"));
		try {
			const runner = new RecordingRunner();
			const state = new RemoteRuntimeBoxState(join(directory, "data"));
			const manager = new RuntimeBoxServiceManager({
				state,
				executablePath: "/opt/moshu-runtime-box",
				platform: "linux",
				environment: { XDG_CONFIG_HOME: join(directory, "config") },
				home: join(directory, "home"),
				runner,
			});
			const serviceFile = await manager.install();
			expect(readFileSync(serviceFile, "utf8")).toContain("/opt/moshu-runtime-box");
			expect(runner.commands.map((entry) => entry.command[0])).toEqual([
				"systemctl",
				"systemctl",
				"loginctl",
			]);
			await manager.uninstall();
			expect(existsSync(serviceFile)).toBe(false);
			expect(existsSync(state.root)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("uses Task Scheduler for the Windows user service", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-windows-service-"));
		try {
			const runner = new RecordingRunner();
			const manager = new RuntimeBoxServiceManager({
				state: new RemoteRuntimeBoxState(join(directory, "data")),
				executablePath: "C:\\Program Files\\Moshu\\moshu-runtime-box.exe",
				platform: "win32",
				environment: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
				home: "C:\\Users\\test",
				runner,
			});
			await manager.install();
			expect(runner.commands[0]?.command).toContain("/XML");
			expect(runner.commands[1]?.command).toContain("/Run");
			await manager.uninstall();
			expect(runner.commands.at(-1)?.command.join(" ")).toContain("Unregister-ScheduledTask");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
