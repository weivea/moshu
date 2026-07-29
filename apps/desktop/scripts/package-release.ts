import { resolve } from "node:path";
import { createElectrobunPackageEnvironment } from "./companion-signing";
import { assertStableReleaseEnvironment } from "./release-gates";

assertStableReleaseEnvironment(process.env, process.platform);
const desktopDirectory = resolve(import.meta.dir, "..");
const environment = createElectrobunPackageEnvironment(
	{ ...process.env, MOSHU_STABLE_RELEASE: "1" },
	process.platform,
	desktopDirectory,
);

await run([process.execPath, "run", "build:web"], desktopDirectory, environment);
await run(
	[process.execPath, "x", "electrobun", "build", "--env=stable"],
	desktopDirectory,
	environment,
);

async function run(
	command: string[],
	cwd: string,
	environment: Record<string, string | undefined>,
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
