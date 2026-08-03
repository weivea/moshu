import { resolve } from "node:path";

import { stagePackageResources } from "./stage-package-resources";

const repositoryRoot = resolve(import.meta.dir, "../../..");
await stagePackageResources(repositoryRoot);

const child = Bun.spawn({
	cmd: [process.execPath, "run", "build:companions"],
	cwd: repositoryRoot,
	env: process.env,
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) {
	throw new Error(`Companion build failed with exit code ${exitCode}.`);
}
