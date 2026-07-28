import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	executorToolBinaryNames,
	type ExecutorToolBinaryName,
	getExecutorToolBinaryFilename,
} from "../packages/contracts/src";

export type ExecutorToolTargetKey =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-arm64"
	| "linux-x64"
	| "win32-arm64"
	| "win32-x64";

export interface ExecutorToolAssetTarget {
	url: string;
	sha256: string;
	archiveType: "tar.gz" | "zip";
	executablePath: string;
}

export interface ExecutorToolManifestEntry {
	version: string;
	repository: string;
	releaseTag: string;
	license: string;
	licenseUrl: string;
	targets: Record<ExecutorToolTargetKey, ExecutorToolAssetTarget>;
}

export interface ExecutorToolAssetManifest {
	schemaVersion: 1;
	tools: Record<ExecutorToolBinaryName, ExecutorToolManifestEntry>;
}

export interface PrepareExecutorToolAssetsOptions {
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
	cacheRoot?: string;
}

const repositoryRoot = resolve(import.meta.dir, "..");
export const executorToolManifestPath = resolve(
	repositoryRoot,
	"tooling",
	"executor-tools-manifest.json",
);
export const defaultExecutorToolCacheRoot = resolve(repositoryRoot, ".cache", "executor-tools");

export function readExecutorToolManifest(): ExecutorToolAssetManifest {
	const parsed = JSON.parse(readFileSync(executorToolManifestPath, "utf8")) as unknown;
	assertExecutorToolManifest(parsed);
	return parsed;
}

export function resolveExecutorToolTargetKey(
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): ExecutorToolTargetKey {
	if (
		(platform === "darwin" || platform === "linux" || platform === "win32") &&
		(arch === "arm64" || arch === "x64")
	) {
		return `${platform}-${arch}`;
	}
	throw new Error(`Unsupported executor tool target: ${platform}-${arch}.`);
}

export async function prepareExecutorToolAssets(
	options: PrepareExecutorToolAssetsOptions = {},
): Promise<Record<ExecutorToolBinaryName, string>> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const targetKey = resolveExecutorToolTargetKey(platform, arch);
	const cacheRoot = resolve(options.cacheRoot ?? defaultExecutorToolCacheRoot);
	const manifest = readExecutorToolManifest();
	const prepared = {} as Record<ExecutorToolBinaryName, string>;

	for (const tool of executorToolBinaryNames) {
		const entry = manifest.tools[tool];
		const target = entry.targets[targetKey];
		const directory = resolve(cacheRoot, tool, entry.version, targetKey);
		const executable = resolve(directory, getExecutorToolBinaryFilename(tool, platform));
		mkdirSync(directory, { recursive: true });
		const archive = resolve(directory, basename(new URL(target.url).pathname));
		await ensureVerifiedArchive(archive, target);
		const extractionDirectory = resolve(
			directory,
			`.extract-${process.pid}-${crypto.randomUUID()}`,
		);
		rmSync(extractionDirectory, { force: true, recursive: true });
		mkdirSync(extractionDirectory, { recursive: true });
		try {
			await extractArchive(archive, extractionDirectory, target);
			const extracted = resolve(extractionDirectory, target.executablePath);
			assertContainedRegularFile(extractionDirectory, extracted);
			const temporary = `${executable}.${process.pid}.writing`;
			copyFileSync(extracted, temporary);
			if (platform !== "win32") {
				chmodSync(temporary, 0o755);
			}
			renameSync(temporary, executable);
			assertExecutable(executable, platform);
		} finally {
			rmSync(extractionDirectory, { force: true, recursive: true });
		}
		prepared[tool] = executable;
	}

	return prepared;
}

async function ensureVerifiedArchive(
	archive: string,
	target: ExecutorToolAssetTarget,
): Promise<void> {
	if (existsSync(archive) && calculateExecutorToolAssetSha256(archive) === target.sha256) {
		return;
	}
	rmSync(archive, { force: true });
	const temporary = `${archive}.${process.pid}.${crypto.randomUUID()}.download`;
	try {
		const response = await fetch(target.url, {
			headers: { "user-agent": "moshu-executor-tool-preparer" },
			redirect: "follow",
		});
		if (!response.ok || response.body === null) {
			throw new Error(`Failed to download ${target.url}: HTTP ${response.status}.`);
		}
		await pipeline(response.body, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
		assertExecutorToolAssetSha256(temporary, target.sha256, target.url);
		renameSync(temporary, archive);
	} finally {
		rmSync(temporary, { force: true });
	}
}

async function extractArchive(
	archive: string,
	destination: string,
	target: ExecutorToolAssetTarget,
): Promise<void> {
	const command =
		target.archiveType === "tar.gz"
			? ["tar", "-xzf", archive, "-C", destination, "--", target.executablePath]
			: process.platform === "win32"
				? [
						"powershell.exe",
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						"Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($args[0]); try { $entry=$zip.GetEntry($args[2]); if ($null -eq $entry) { throw 'archive entry missing' }; $target=Join-Path $args[1] $args[2]; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true) } finally { $zip.Dispose() }",
						archive,
						destination,
						target.executablePath,
					]
				: ["unzip", "-q", archive, target.executablePath, "-d", destination];
	const result = Bun.spawn({ cmd: command, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([result.exited, new Response(result.stderr).text()]);
	if (exitCode !== 0) {
		throw new Error(`Failed to extract ${archive}: ${stderr.trim() || `exit code ${exitCode}`}.`);
	}
}

export function calculateExecutorToolAssetSha256(filename: string): string {
	return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

export function assertExecutorToolAssetSha256(
	filename: string,
	expectedSha256: string,
	label = filename,
): void {
	const actual = calculateExecutorToolAssetSha256(filename);
	if (actual !== expectedSha256) {
		throw new Error(
			`SHA-256 mismatch for ${label}: expected ${expectedSha256}, received ${actual}.`,
		);
	}
}

function assertExecutable(filename: string, platform: NodeJS.Platform): void {
	const stats = lstatSync(filename);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Executor tool asset is not a regular file: ${filename}.`);
	}
	if (platform !== "win32" && (stats.mode & 0o111) === 0) {
		throw new Error(`Executor tool asset is not executable: ${filename}.`);
	}
}

function assertContainedRegularFile(root: string, filename: string): void {
	const relation = relative(root, filename);
	if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
		throw new Error(`Archive executable path escapes its extraction root: ${filename}.`);
	}
	const stats = lstatSync(filename);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Archive executable is not a regular file: ${filename}.`);
	}
}

export function assertExecutorToolManifest(
	value: unknown,
): asserts value is ExecutorToolAssetManifest {
	if (
		typeof value !== "object" ||
		value === null ||
		Reflect.get(value, "schemaVersion") !== 1 ||
		typeof Reflect.get(value, "tools") !== "object" ||
		Reflect.get(value, "tools") === null
	) {
		throw new Error("Executor tool manifest must be a schema version 1 object.");
	}
	const tools = Reflect.get(value, "tools") as Record<string, unknown>;
	if (
		Object.keys(tools).length !== executorToolBinaryNames.length ||
		executorToolBinaryNames.some((tool) => !(tool in tools))
	) {
		throw new Error("Executor tool manifest must contain exactly rg and fd.");
	}
	for (const tool of executorToolBinaryNames) {
		const entry = tools[tool];
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`Executor tool manifest is missing ${tool}.`);
		}
		const version = Reflect.get(entry, "version");
		const targets = Reflect.get(entry, "targets");
		const expectedTargetKeys = [
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-arm64",
			"win32-x64",
		] as const;
		if (
			typeof version !== "string" ||
			!/^\d+\.\d+\.\d+$/.test(version) ||
			typeof targets !== "object" ||
			targets === null ||
			Object.keys(targets).length !== expectedTargetKeys.length ||
			expectedTargetKeys.some((targetKey) => !(targetKey in targets))
		) {
			throw new Error(`Executor tool manifest entry ${tool} is invalid.`);
		}
		for (const targetKey of expectedTargetKeys) {
			const target = Reflect.get(targets, targetKey);
			if (typeof target !== "object" || target === null) {
				throw new Error(`Executor tool manifest ${tool} is missing target ${targetKey}.`);
			}
			const url = Reflect.get(target, "url");
			const sha256 = Reflect.get(target, "sha256");
			const archiveType = Reflect.get(target, "archiveType");
			const executablePath = Reflect.get(target, "executablePath");
			if (
				typeof url !== "string" ||
				!url.startsWith("https://github.com/") ||
				typeof sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(sha256) ||
				(archiveType !== "tar.gz" && archiveType !== "zip") ||
				typeof executablePath !== "string" ||
				executablePath.length === 0 ||
				isAbsolute(executablePath) ||
				executablePath.split(/[\\/]/).includes("..")
			) {
				throw new Error(`Executor tool manifest target ${tool}/${targetKey} is invalid.`);
			}
		}
	}
}

export function copyPreparedExecutorTools(
	prepared: Record<ExecutorToolBinaryName, string>,
	destination: string,
	platform: NodeJS.Platform = process.platform,
): void {
	mkdirSync(destination, { recursive: true });
	for (const tool of executorToolBinaryNames) {
		const output = join(destination, getExecutorToolBinaryFilename(tool, platform));
		copyFileSync(prepared[tool], output);
		if (platform !== "win32") {
			chmodSync(output, 0o755);
		}
	}
}

if (import.meta.main) {
	const prepared = await prepareExecutorToolAssets();
	for (const tool of executorToolBinaryNames) {
		console.info(`${tool} ${prepared[tool]}`);
	}
}
