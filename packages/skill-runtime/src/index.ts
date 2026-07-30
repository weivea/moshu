import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
	installRuntimeBoxSkillInputSchema,
	maxRuntimeBoxSkillFileBytes,
	maxRuntimeBoxSkillMarkdownBytes,
	skillMetadataSchema,
	type SkillMetadata,
	type SkillPackageFile,
} from "@moshu/contracts";
import { parseDocument } from "yaml";

export interface DecodedSkillFile {
	path: string;
	executable: boolean;
	bytes: Buffer;
}

export interface SkillPackagePolicy {
	ownerKind: "agent-server" | "runtime-box";
	allowBundleFiles: boolean;
	allowExecutableFiles: boolean;
}

export interface PreparedSkillPackage {
	files: readonly DecodedSkillFile[];
	metadata: SkillMetadata;
	skillMarkdown: string;
	contentHash: string;
}

export interface StoredSkillVersion {
	locator: string;
	contentHash: string;
	metadata: SkillMetadata;
}

export function prepareSkillPackage(
	filesValue: readonly SkillPackageFile[],
	policy: SkillPackagePolicy,
): PreparedSkillPackage {
	const files = installRuntimeBoxSkillInputSchema.shape.files.parse(filesValue);
	if (!policy.allowBundleFiles && (files.length !== 1 || files[0]?.path !== "SKILL.md")) {
		throw new Error("Agent Server-owned Skills may only contain SKILL.md.");
	}
	if (!policy.allowExecutableFiles && files.some((file) => file.executable)) {
		throw new Error("Agent Server-owned Skills cannot contain executable files.");
	}
	const decodedFiles = files.map((file) => ({
		path: file.path,
		executable: file.executable,
		bytes: decodeSkillFile(file.encoding, file.content),
	}));
	const skillMarkdownFile = decodedFiles.find((file) => file.path === "SKILL.md");
	if (skillMarkdownFile === undefined) {
		throw new Error("Skill package is missing SKILL.md.");
	}
	const skillMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(skillMarkdownFile.bytes);
	return {
		files: decodedFiles,
		metadata: parseSkillMetadata(skillMarkdown),
		skillMarkdown,
		contentHash: hashSkillFiles(decodedFiles),
	};
}

export function decodeSkillFile(encoding: "utf8" | "base64", content: string): Buffer {
	if (encoding === "utf8") {
		return Buffer.from(content, "utf8");
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
		throw new Error("Skill file contains invalid base64.");
	}
	return Buffer.from(content, "base64");
}

export function hashSkillFiles(files: readonly DecodedSkillFile[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
		hash.update(
			`${file.path.length}:${file.path}:${file.executable ? 1 : 0}:${file.bytes.length}:`,
		);
		hash.update(file.bytes);
	}
	return hash.digest("hex");
}

export function skillDirectoryKey(stableResourceId: string): string {
	return createHash("sha256").update(`moshu-skill-directory-v1:${stableResourceId}`).digest("hex");
}

export function parseSkillMetadata(skillMarkdown: string): SkillMetadata {
	const lines = skillMarkdown.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") {
		throw new Error("SKILL.md must start with YAML frontmatter.");
	}
	const closingIndex = lines.indexOf("---", 1);
	if (closingIndex < 0) {
		throw new Error("SKILL.md frontmatter is not terminated.");
	}
	const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
		schema: "core",
		uniqueKeys: true,
	});
	if (document.errors.length > 0) {
		throw new Error("SKILL.md frontmatter is invalid YAML.", {
			cause: new AggregateError(document.errors),
		});
	}
	const raw: unknown = document.toJS({ maxAliasCount: 0 });
	if (!isPlainRecord(raw)) {
		throw new Error("SKILL.md frontmatter must be a mapping.");
	}
	const name = raw.name;
	const description = raw.description;
	if (typeof name !== "string" || typeof description !== "string") {
		throw new Error("SKILL.md frontmatter requires name and description.");
	}
	const metadata: Record<string, string> = {};
	if (raw.metadata !== undefined) {
		if (!isPlainRecord(raw.metadata)) {
			throw new Error("SKILL.md metadata must be a mapping.");
		}
		for (const [key, value] of Object.entries(raw.metadata)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
				throw new Error("SKILL.md metadata values must be scalar.");
			}
			metadata[key] = String(value);
		}
	}
	return skillMetadataSchema.parse({
		name,
		description,
		...(typeof raw.license === "string" ? { license: raw.license } : {}),
		...(typeof raw.compatibility === "string" ? { compatibility: raw.compatibility } : {}),
		allowedTools: parseAllowedTools(raw["allowed-tools"]),
		metadata,
	});
}

export class FileSkillContentStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = resolve(root);
		ensurePrivateDirectory(this.#root);
	}

	writeVersion(
		stableResourceId: string,
		version: string,
		files: readonly DecodedSkillFile[],
	): string {
		const locator = `${skillDirectoryKey(stableResourceId)}/${version}`;
		const targetDirectory = this.resolveLocator(locator);
		const stagingDirectory = join(this.#root, `.staging-${crypto.randomUUID()}`);
		ensurePrivateDirectory(stagingDirectory);
		fsyncDirectory(this.#root);
		const createdDirectories = new Set<string>([stagingDirectory]);
		try {
			for (const file of files) {
				const filename = join(stagingDirectory, ...file.path.split("/"));
				ensurePrivateDirectory(dirname(filename));
				let directory = dirname(filename);
				while (directory !== stagingDirectory) {
					createdDirectories.add(directory);
					const parent = dirname(directory);
					if (parent === directory) {
						throw new Error("Skill package path escaped the staging directory.");
					}
					directory = parent;
				}
				const descriptor = openSync(
					filename,
					constants.O_CREAT |
						constants.O_EXCL |
						constants.O_WRONLY |
						(process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
					file.executable ? 0o700 : 0o600,
				);
				try {
					writeFileSync(descriptor, file.bytes);
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				chmodSync(filename, file.executable ? 0o700 : 0o600);
			}
			for (const directory of [...createdDirectories].sort(
				(left, right) => right.split("/").length - left.split("/").length,
			)) {
				fsyncDirectory(directory);
			}
			const targetParent = dirname(targetDirectory);
			ensurePrivateDirectory(targetParent);
			renameSync(stagingDirectory, targetDirectory);
			fsyncDirectory(targetParent);
			fsyncDirectory(this.#root);
			return locator;
		} catch (error) {
			rmSync(stagingDirectory, { recursive: true, force: true });
			throw error;
		}
	}

	readSkillMarkdown(locator: string): string {
		return readPrivateFile(
			join(this.resolveLocator(locator), "SKILL.md"),
			maxRuntimeBoxSkillMarkdownBytes,
		).toString("utf8");
	}

	hashVersion(locator: string): string {
		const root = this.resolveLocator(locator);
		return hashSkillFiles(
			listStoredSkillFiles(root).map((path) => {
				const filename = join(root, ...path.split("/"));
				const metadata = requirePrivateRegularFile(filename);
				return {
					path,
					executable: (metadata.mode & 0o100) !== 0,
					bytes: readPrivateFile(filename, maxRuntimeBoxSkillFileBytes),
				};
			}),
		);
	}

	verifyVersion(locator: string, expectedHash: string): void {
		if (this.hashVersion(locator) !== expectedHash) {
			throw new Error("Skill content no longer matches its immutable version.");
		}
	}

	deleteVersion(locator: string): void {
		rmSync(this.resolveLocator(locator), { recursive: true, force: true });
		fsyncDirectory(this.#root);
	}

	cleanupOrphans(referencedLocators: ReadonlySet<string>): void {
		for (const skillEntry of readdirSync(this.#root, { withFileTypes: true })) {
			const skillPath = join(this.#root, skillEntry.name);
			if (skillEntry.name.startsWith(".staging-")) {
				rmSync(skillPath, { recursive: true, force: true });
				continue;
			}
			if (!skillEntry.isDirectory() || skillEntry.isSymbolicLink()) {
				throw new Error("Skill store contains an invalid entry.");
			}
			for (const versionEntry of readdirSync(skillPath, { withFileTypes: true })) {
				const locator = `${skillEntry.name}/${versionEntry.name}`;
				if (!referencedLocators.has(locator)) {
					rmSync(join(skillPath, versionEntry.name), { recursive: true, force: true });
				}
			}
			if (readdirSync(skillPath).length === 0) {
				rmSync(skillPath, { recursive: false, force: true });
			}
		}
		fsyncDirectory(this.#root);
	}

	resolveLocator(locator: string): string {
		const segments = locator.split("/");
		if (
			segments.length !== 2 ||
			segments.some((segment) => !/^[a-f0-9-]+$/.test(segment) || segment.length === 0)
		) {
			throw new Error("Skill content locator is invalid.");
		}
		const resolved = resolve(this.#root, ...segments);
		const relativePath = relative(this.#root, resolved);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error("Skill content locator escaped its private root.");
		}
		return resolved;
	}
}

function parseAllowedTools(value: unknown): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value === "string") {
		return value.split(/[\s,]+/).filter((entry) => entry.length > 0);
	}
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
		return value;
	}
	throw new Error("SKILL.md allowed-tools must be a string or string array.");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listStoredSkillFiles(root: string, relativeRoot = ""): string[] {
	const directory = relativeRoot.length === 0 ? root : join(root, ...relativeRoot.split("/"));
	const metadata = lstatSync(directory, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Skill version contains an invalid directory.");
	}
	const output: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
		if (entry.isSymbolicLink()) {
			throw new Error("Skill version cannot contain symbolic links.");
		}
		if (entry.isDirectory()) {
			output.push(...listStoredSkillFiles(root, relativePath));
		} else if (entry.isFile()) {
			output.push(relativePath);
		} else {
			throw new Error("Skill version contains an unsupported filesystem entry.");
		}
	}
	return output.sort();
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Skill private path must be a real directory.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	chmodSync(path, 0o700);
}

function requirePrivateRegularFile(path: string): Stats {
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Skill private file must be a regular file.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
		throw new Error("Skill private file permissions are too broad.");
	}
	return metadata;
}

function readPrivateFile(path: string, maxBytes: number): Buffer {
	const beforeOpen = requirePrivateRegularFile(path);
	const descriptor = openSync(
		path,
		constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
	);
	try {
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) {
			throw new Error("Skill private file must be a regular file.");
		}
		assertOwnedByCurrentUser(metadata.uid);
		if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
			throw new Error("Skill private file permissions are too broad.");
		}
		if (metadata.dev !== beforeOpen.dev || metadata.ino !== beforeOpen.ino) {
			throw new Error("Skill private file changed while it was opened.");
		}
		if (metadata.size > maxBytes) {
			throw new Error("Skill private file exceeds its size limit.");
		}
		return readFileSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function assertOwnedByCurrentUser(uid: number): void {
	if (
		process.platform !== "win32" &&
		typeof process.getuid === "function" &&
		uid !== process.getuid()
	) {
		throw new Error("Skill private storage is not owned by the current user.");
	}
}

function fsyncDirectory(path: string): void {
	if (process.platform === "win32") {
		return;
	}
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
