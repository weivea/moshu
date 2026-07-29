import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
	COMPANION_EXECUTABLE_ROLES,
	type CompanionExecutableRole,
	getCompanionExecutableFilename,
} from "../apps/desktop/src/shared/companion-executable-names";
import {
	executorImageProcessorWasmFilename,
	getExecutorToolBinaryFilename,
} from "../packages/contracts/src/executor-tool-assets";
import { copyPreparedExecutorTools, prepareExecutorToolAssets } from "./executor-tool-assets";

const role = parseRole(process.argv[2]);
const smoke = process.argv[3] === "smoke";
if (smoke && role !== "agents-server") {
	throw new Error("Only agents-server has a smoke binary.");
}
const repositoryRoot = resolve(import.meta.dir, "..");
const appDirectory = resolve(repositoryRoot, "apps", role);
const outputPath = resolve(
	appDirectory,
	"dist",
	smoke
		? createSmokeFilename(getCompanionExecutableFilename(role, process.platform))
		: getCompanionExecutableFilename(role, process.platform),
);
mkdirSync(dirname(outputPath), { recursive: true });
let compileEntry = resolve(appDirectory, "src", smoke ? "smoke-index.ts" : "index.ts");
let generatedEntry: string | undefined;
if (role === "runtime-box") {
	const prepared = await prepareExecutorToolAssets();
	copyPreparedExecutorTools(prepared, dirname(outputPath));
	copyFileSync(
		resolve(
			appDirectory,
			"node_modules",
			"@silvia-odwyer",
			"photon-node",
			executorImageProcessorWasmFilename,
		),
		resolve(dirname(outputPath), executorImageProcessorWasmFilename),
	);
	generatedEntry = resolve(dirname(outputPath), "runtime-box-compiled-entry.ts");
	writeFileSync(generatedEntry, createRuntimeBoxCompiledEntry(dirname(outputPath)), "utf8");
	compileEntry = generatedEntry;
}

try {
	const child = Bun.spawn({
		cmd: [process.execPath, "build", compileEntry, "--compile", "--outfile", outputPath],
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
} finally {
	if (generatedEntry !== undefined) {
		unlinkSync(generatedEntry);
	}
}

function parseRole(value: string | undefined): CompanionExecutableRole {
	if (value === "agents-server" || value === "runtime-box") {
		return value;
	}

	throw new Error(`Expected companion role: ${COMPANION_EXECUTABLE_ROLES.join(" or ")}.`);
}

function createSmokeFilename(filename: string): string {
	return filename.endsWith(".exe")
		? `${filename.slice(0, -".exe".length)}-smoke.exe`
		: `${filename}-smoke`;
}

function createRuntimeBoxCompiledEntry(assetDirectory: string): string {
	const rgFilename = getExecutorToolBinaryFilename("rg");
	const fdFilename = getExecutorToolBinaryFilename("fd");
	const asset = (filename: string, executable: boolean) => {
		const path = resolve(assetDirectory, filename);
		return {
			filename,
			executable,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		};
	};
	const rg = asset(rgFilename, true);
	const fd = asset(fdFilename, true);
	const photonWasm = asset(executorImageProcessorWasmFilename, false);
	return `import rgPath from "./${rgFilename}" with { type: "file" };
import fdPath from "./${fdFilename}" with { type: "file" };
import photonWasmPath from "./${executorImageProcessorWasmFilename}" with { type: "file" };
import { runRuntimeBoxMain } from "../src/index.ts";

const exitCode = await runRuntimeBoxMain(process.argv.slice(2), {
  rg: ${JSON.stringify({ ...rg, sourcePath: "__RG__" })},
  fd: ${JSON.stringify({ ...fd, sourcePath: "__FD__" })},
  photonWasm: ${JSON.stringify({ ...photonWasm, sourcePath: "__PHOTON__" })},
});
process.exit(exitCode);
`
		.replace('"__RG__"', "rgPath")
		.replace('"__FD__"', "fdPath")
		.replace('"__PHOTON__"', "photonWasmPath");
}
