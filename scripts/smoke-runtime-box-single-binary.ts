import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getCompanionExecutableFilename } from "../apps/desktop/src/shared/companion-executable-names";

const repositoryRoot = resolve(import.meta.dir, "..");
const source = resolve(
	repositoryRoot,
	"apps",
	"runtime-box",
	"dist",
	getCompanionExecutableFilename("runtime-box"),
);
const directory = mkdtempSync(join(tmpdir(), "moshu-runtime-box-single-"));
try {
	const executable = join(directory, getCompanionExecutableFilename("runtime-box"));
	cpSync(source, executable);
	chmodSync(executable, 0o700);
	const cache = join(directory, "cache");
	const child = Bun.spawn({
		cmd: [executable, "run", "--data-dir", join(directory, "data")],
		env: {
			...process.env,
			MOSHU_RUNTIME_BOX_CACHE: cache,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 1 || !stderr.includes("not paired")) {
		throw new Error(`Single-binary Runtime Box smoke failed with exit ${exitCode}: ${stderr}`);
	}
	const extractedFiles = listFiles(cache);
	if (
		!extractedFiles.some((filename) => filename.endsWith("/rg")) ||
		!extractedFiles.some((filename) => filename.endsWith("/fd")) ||
		!extractedFiles.some((filename) => filename.endsWith("/photon_rs_bg.wasm"))
	) {
		throw new Error(`Embedded Runtime Box assets were not extracted: ${extractedFiles.join(", ")}`);
	}
	console.info(JSON.stringify({ status: "SINGLE_BINARY_READY", extractedFiles }));
} finally {
	rmSync(directory, { recursive: true, force: true });
}

function listFiles(directory: string, prefix = ""): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? listFiles(join(directory, entry.name), relative) : [relative];
	});
}
