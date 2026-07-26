import { resolve } from "node:path";
import { createElectrobunPackageEnvironment } from "./companion-signing";

const desktopDirectory = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopDirectory, "../..");

await run([process.execPath, "run", "build:companions"], repositoryRoot);
await run([process.execPath, "run", "build:web"], desktopDirectory);
await run(
	[process.execPath, "x", "electrobun", "build", "--env=canary"],
	desktopDirectory,
	createElectrobunPackageEnvironment(process.env, process.platform, desktopDirectory),
);

async function run(
	command: string[],
	cwd: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<void> {
	const child = Bun.spawn({
		cmd: command,
		cwd,
		env: environment,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} exited with code ${exitCode}.`);
	}
}
