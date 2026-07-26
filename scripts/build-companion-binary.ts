import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
	COMPANION_EXECUTABLE_ROLES,
	type CompanionExecutableRole,
	getCompanionExecutableFilename,
} from "../apps/desktop/src/shared/companion-executable-names";

const role = parseRole(process.argv[2]);
const repositoryRoot = resolve(import.meta.dir, "..");
const appDirectory = resolve(repositoryRoot, "apps", role);
const outputPath = resolve(
	appDirectory,
	"dist",
	getCompanionExecutableFilename(role, process.platform),
);
mkdirSync(dirname(outputPath), { recursive: true });

const child = Bun.spawn({
	cmd: [
		process.execPath,
		"build",
		resolve(appDirectory, "src", "index.ts"),
		"--compile",
		"--outfile",
		outputPath,
	],
	cwd: appDirectory,
	env: process.env,
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) {
	throw new Error(`Failed to build ${role} companion executable (exit code ${exitCode}).`);
}

function parseRole(value: string | undefined): CompanionExecutableRole {
	if (value === "agents-server" || value === "executor") {
		return value;
	}
	throw new Error(`Expected companion role: ${COMPANION_EXECUTABLE_ROLES.join(" or ")}.`);
}
