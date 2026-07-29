import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { RemoteRuntimeBoxState } from "./remote-state";

export interface ServiceCommandRunner {
	run(command: readonly string[], allowedExitCodes?: readonly number[]): Promise<void>;
}

export class BunServiceCommandRunner implements ServiceCommandRunner {
	async run(command: readonly string[], allowedExitCodes: readonly number[] = []): Promise<void> {
		const child = Bun.spawn({
			cmd: [...command],
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			const output = `${stdout}\n${stderr}`;
			if (allowedExitCodes.includes(exitCode)) {
				return;
			}
			throw new Error(
				`${command[0] ?? "Service command"} exited with code ${exitCode}: ${output.trim().slice(-1_024)}`,
			);
		}
	}
}

export interface RuntimeBoxServiceManagerOptions {
	state: RemoteRuntimeBoxState;
	executablePath?: string;
	platform?: NodeJS.Platform;
	environment?: NodeJS.ProcessEnv;
	home?: string;
	runner?: ServiceCommandRunner;
	uid?: number;
}

export class RuntimeBoxServiceManager {
	readonly #state: RemoteRuntimeBoxState;
	readonly #executablePath: string;
	readonly #platform: NodeJS.Platform;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #home: string;
	readonly #runner: ServiceCommandRunner;
	readonly #uid: number | undefined;

	constructor(options: RuntimeBoxServiceManagerOptions) {
		this.#state = options.state;
		this.#executablePath = resolve(options.executablePath ?? process.execPath);
		this.#platform = options.platform ?? process.platform;
		this.#environment = options.environment ?? process.env;
		this.#home = options.home ?? homedir();
		this.#runner = options.runner ?? new BunServiceCommandRunner();
		this.#uid = options.uid ?? process.getuid?.();
	}

	async install(): Promise<string> {
		this.#state.initializeDirectories();
		if (this.#platform === "linux") {
			const filename = this.#linuxUnitPath();
			writeServiceFile(filename, createSystemdUnit(this.#executablePath, this.#state.root));
			await this.#runner.run(["systemctl", "--user", "daemon-reload"]);
			await this.#runner.run([
				"systemctl",
				"--user",
				"enable",
				"--now",
				"moshu-runtime-box.service",
			]);
			await this.#runner.run(["loginctl", "enable-linger"]);
			return filename;
		}
		if (this.#platform === "darwin") {
			if (this.#uid === undefined) {
				throw new Error("A user ID is required to install the macOS Runtime Box service.");
			}
			const filename = this.#launchAgentPath();
			writeServiceFile(filename, createLaunchAgent(this.#executablePath, this.#state.root));
			await this.#runner.run(
				["launchctl", "bootout", `gui/${this.#uid}/dev.moshu.runtime-box`],
				[3],
			);
			await this.#runner.run(["launchctl", "bootstrap", `gui/${this.#uid}`, filename]);
			return filename;
		}
		if (this.#platform === "win32") {
			const definition = this.#windowsTaskPath();
			writeServiceFile(definition, createWindowsTaskXml(this.#executablePath, this.#state.root));
			await this.#runner.run([
				"schtasks",
				"/Create",
				"/TN",
				"Moshu Runtime Box",
				"/XML",
				definition,
				"/F",
			]);
			await this.#runner.run(["schtasks", "/Run", "/TN", "Moshu Runtime Box"]);
			return "Task Scheduler: Moshu Runtime Box";
		}
		throw new Error(`Unsupported Runtime Box service platform: ${this.#platform}.`);
	}

	async uninstall(): Promise<void> {
		if (this.#platform === "linux") {
			const filename = this.#linuxUnitPath();
			await this.#runner.run(
				["systemctl", "--user", "disable", "--now", "moshu-runtime-box.service"],
				[5],
			);
			removeServiceFile(filename);
			await this.#runner.run(["systemctl", "--user", "daemon-reload"]);
			return;
		}
		if (this.#platform === "darwin") {
			if (this.#uid === undefined) {
				throw new Error("A user ID is required to uninstall the macOS Runtime Box service.");
			}
			const filename = this.#launchAgentPath();
			await this.#runner.run(
				["launchctl", "bootout", `gui/${this.#uid}/dev.moshu.runtime-box`],
				[3],
			);
			removeServiceFile(filename);
			return;
		}
		if (this.#platform === "win32") {
			const definition = this.#windowsTaskPath();
			await this.#runner.run(windowsRemoveTaskCommand());
			removeServiceFile(definition);
			return;
		}
		throw new Error(`Unsupported Runtime Box service platform: ${this.#platform}.`);
	}

	async stop(): Promise<void> {
		if (this.#platform === "linux") {
			await this.#runner.run(["systemctl", "--user", "stop", "moshu-runtime-box.service"], [5]);
			return;
		}
		if (this.#platform === "darwin") {
			if (this.#uid === undefined) {
				throw new Error("A user ID is required to stop the macOS Runtime Box service.");
			}
			await this.#runner.run(
				["launchctl", "kill", "SIGTERM", `gui/${this.#uid}/dev.moshu.runtime-box`],
				[3],
			);
			return;
		}
		if (this.#platform === "win32") {
			await this.#runner.run(windowsStopTaskCommand());
			return;
		}
		throw new Error(`Unsupported Runtime Box service platform: ${this.#platform}.`);
	}

	#linuxUnitPath(): string {
		const configRoot = this.#environment.XDG_CONFIG_HOME?.trim() || join(this.#home, ".config");
		return join(configRoot, "systemd", "user", "moshu-runtime-box.service");
	}

	#launchAgentPath(): string {
		return join(this.#home, "Library", "LaunchAgents", "dev.moshu.runtime-box.plist");
	}

	#windowsTaskPath(): string {
		return join(this.#state.root, "moshu-runtime-box-task.xml");
	}
}

export function createSystemdUnit(executablePath: string, dataRoot: string): string {
	return `[Unit]
Description=Moshu Runtime Box
After=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(executablePath)} run --data-dir ${quoteSystemd(dataRoot)}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function createLaunchAgent(executablePath: string, dataRoot: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.moshu.runtime-box</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
    <string>run</string>
    <string>--data-dir</string>
    <string>${escapeXml(dataRoot)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function createWindowsTaskXml(executablePath: string, dataRoot: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure><Interval>PT30S</Interval><Count>3</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(executablePath)}</Command>
      <Arguments>run --data-dir &quot;${escapeXml(dataRoot)}&quot;</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function writeServiceFile(filename: string, content: string): void {
	mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
	writeFileSync(filename, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(filename, 0o600);
}

function removeServiceFile(filename: string): void {
	if (!existsSync(filename)) {
		return;
	}
	const metadata = lstatSync(filename);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Runtime Box service definition must be a regular file.");
	}
	unlinkSync(filename);
}

function quoteSystemd(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function windowsStopTaskCommand(): string[] {
	return [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$task = Get-ScheduledTask -TaskName 'Moshu Runtime Box' -ErrorAction SilentlyContinue; if ($null -ne $task) { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue }",
	];
}

function windowsRemoveTaskCommand(): string[] {
	return [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$task = Get-ScheduledTask -TaskName 'Moshu Runtime Box' -ErrorAction SilentlyContinue; if ($null -ne $task) { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop }",
	];
}
