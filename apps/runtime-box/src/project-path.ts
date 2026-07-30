import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import {
	maxProjectRootAgentsBytes,
	type ProjectPathIssueCode,
	type ProjectRootAgentsStatus,
	type ReadRuntimeBoxProjectRootAgentsInput,
	type ReadRuntimeBoxProjectRootAgentsOutput,
	readRuntimeBoxProjectRootAgentsInputSchema,
	readRuntimeBoxProjectRootAgentsOutputSchema,
	type ValidateRuntimeBoxProjectPathInput,
	type ValidateRuntimeBoxProjectPathOutput,
	validateRuntimeBoxProjectPathInputSchema,
	validateRuntimeBoxProjectPathOutputSchema,
} from "@moshu/contracts";
import { type RpcRequestHandler, rpcJsonValueSchema } from "@moshu/process-rpc";

export const validateProjectPathRequestHandler: RpcRequestHandler = async (payload) => {
	return rpcJsonValueSchema.parse(
		await validateProjectPath(validateRuntimeBoxProjectPathInputSchema.parse(payload)),
	);
};

export const readProjectRootAgentsRequestHandler: RpcRequestHandler = async (payload, context) => {
	return rpcJsonValueSchema.parse(
		await readProjectRootAgents(
			readRuntimeBoxProjectRootAgentsInputSchema.parse(payload),
			context.signal,
		),
	);
};

export async function readProjectRootAgents(
	inputValue: ReadRuntimeBoxProjectRootAgentsInput,
	signal?: AbortSignal,
): Promise<ReadRuntimeBoxProjectRootAgentsOutput> {
	const input = readRuntimeBoxProjectRootAgentsInputSchema.parse(inputValue);
	return readBoundedRootAgents(input.projectPath, "body", signal);
}

async function readBoundedRootAgents(
	projectPath: string,
	mode: "body",
	signal?: AbortSignal,
): Promise<ReadRuntimeBoxProjectRootAgentsOutput>;
async function readBoundedRootAgents(
	projectPath: string,
	mode: "metadata",
	signal?: AbortSignal,
): Promise<ProjectRootAgentsStatus>;
async function readBoundedRootAgents(
	projectPath: string,
	mode: "body" | "metadata",
	signal?: AbortSignal,
): Promise<ReadRuntimeBoxProjectRootAgentsOutput | ProjectRootAgentsStatus> {
	signal?.throwIfAborted();
	const agentsPath = resolve(projectPath, "AGENTS.md");
	let metadata: Stats;
	try {
		metadata = await lstat(agentsPath);
	} catch (error) {
		signal?.throwIfAborted();
		return readAgentsFailure(error);
	}
	signal?.throwIfAborted();
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		return { status: "warning", issueCode: "not_regular_file" };
	}
	if (metadata.size > maxProjectRootAgentsBytes) {
		return { status: "warning", issueCode: "too_large" };
	}

	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(agentsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		signal?.throwIfAborted();
		const openedMetadata = await file.stat();
		if (!openedMetadata.isFile()) {
			return { status: "warning", issueCode: "not_regular_file" };
		}
		if (openedMetadata.size > maxProjectRootAgentsBytes) {
			return { status: "warning", issueCode: "too_large" };
		}
		const bytes = Buffer.allocUnsafe(maxProjectRootAgentsBytes + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
		signal?.throwIfAborted();
		if (bytesRead > maxProjectRootAgentsBytes) {
			return { status: "warning", issueCode: "too_large" };
		}
		let body: string;
		try {
			body = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
		} catch {
			return { status: "warning", issueCode: "invalid_utf8" };
		}
		if (mode === "metadata") {
			return {
				status: "available",
				sizeBytes: bytesRead,
				modifiedAt: openedMetadata.mtime.toISOString(),
			};
		}
		return readRuntimeBoxProjectRootAgentsOutputSchema.parse({ status: "loaded", body });
	} catch (error) {
		signal?.throwIfAborted();
		return readAgentsFailure(error);
	} finally {
		await file?.close().catch(() => undefined);
	}
}

function readAgentsFailure(error: unknown): ReadRuntimeBoxProjectRootAgentsOutput {
	if (isMissingPathError(error)) {
		return { status: "missing" };
	}
	if (error instanceof Error && "code" in error && error.code === "ELOOP") {
		return { status: "warning", issueCode: "not_regular_file" };
	}
	return { status: "warning", issueCode: mapAgentsError(error) };
}

export async function validateProjectPath(
	inputValue: ValidateRuntimeBoxProjectPathInput,
): Promise<ValidateRuntimeBoxProjectPathOutput> {
	const input = validateRuntimeBoxProjectPathInputSchema.parse(inputValue);
	if (!isAbsolute(input.path)) {
		return { status: "unavailable", issueCode: "not_absolute" };
	}
	let normalizedPath: string;
	try {
		normalizedPath = await realpath(resolve(input.path));
	} catch (error) {
		return unavailableInspection(mapPathError(error));
	}
	let metadata: Stats;
	try {
		metadata = await stat(normalizedPath);
	} catch (error) {
		return unavailableInspection(mapPathError(error));
	}
	if (!metadata.isDirectory()) {
		return unavailableInspection("not_directory");
	}
	try {
		await access(normalizedPath, constants.R_OK | constants.X_OK);
	} catch (error) {
		return unavailableInspection(mapPathError(error));
	}
	const git = await findGitMetadata(normalizedPath);
	const rootAgents = await inspectRootAgents(normalizedPath);
	const inspection = {
		status: "available" as const,
		normalizedPath,
		displayName: basename(normalizedPath) || normalizedPath,
		...(git === undefined ? {} : git),
		rootAgents,
	};
	return validateRuntimeBoxProjectPathOutputSchema.parse({
		...inspection,
		confirmationToken: createInspectionFingerprint(inspection),
	});
}

async function inspectRootAgents(projectPath: string): Promise<ProjectRootAgentsStatus> {
	return readBoundedRootAgents(projectPath, "metadata");
}

function createInspectionFingerprint(input: {
	normalizedPath: string;
	displayName: string;
	gitRootPath?: string;
	gitBranch?: string;
	rootAgents: ProjectRootAgentsStatus;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				input.normalizedPath,
				input.displayName,
				input.gitRootPath ?? null,
				input.gitBranch ?? null,
				input.rootAgents,
			]),
		)
		.digest("hex");
}

async function findGitMetadata(
	startPath: string,
): Promise<{ gitRootPath: string; gitBranch?: string } | undefined> {
	let currentPath = startPath;
	while (true) {
		const gitPath = resolve(currentPath, ".git");
		const gitDirectory = await resolveGitDirectory(gitPath);
		if (gitDirectory !== undefined) {
			const branch = await readGitBranch(gitDirectory);
			return {
				gitRootPath: currentPath,
				...(branch === undefined ? {} : { gitBranch: branch }),
			};
		}
		const parentPath = dirname(currentPath);
		if (parentPath === currentPath || currentPath === parse(currentPath).root) {
			return undefined;
		}
		currentPath = parentPath;
	}
}

async function resolveGitDirectory(gitPath: string): Promise<string | undefined> {
	try {
		const metadata = await stat(gitPath);
		if (metadata.isDirectory()) {
			return realpath(gitPath);
		}
		if (!metadata.isFile() || metadata.size > 4_096) {
			return undefined;
		}
		const pointer = await readFile(gitPath, "utf8");
		const match = /^gitdir:\s*(.+)\s*$/iu.exec(pointer);
		return match?.[1] === undefined ? undefined : realpath(resolve(dirname(gitPath), match[1]));
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined;
		}
		throw error;
	}
}

async function readGitBranch(gitDirectory: string): Promise<string | undefined> {
	const headPath = resolve(gitDirectory, "HEAD");
	try {
		const metadata = await stat(headPath);
		if (!metadata.isFile() || metadata.size > 4_096) {
			return undefined;
		}
		const head = (await readFile(headPath, "utf8")).trim();
		const prefix = "ref: refs/heads/";
		return head.startsWith(prefix) ? head.slice(prefix.length) : undefined;
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined;
		}
		throw error;
	}
}

function isMissingPathError(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function mapPathError(error: unknown): ProjectPathIssueCode {
	if (!(error instanceof Error) || !("code" in error)) {
		return "unknown";
	}
	if (error.code === "ENOENT") {
		return "not_found";
	}
	if (error.code === "ENOTDIR") {
		return "not_directory";
	}
	if (error.code === "EACCES" || error.code === "EPERM") {
		return "permission_denied";
	}
	return "unknown";
}

function mapAgentsError(error: unknown): "permission_denied" | "unknown" {
	return error instanceof Error &&
		"code" in error &&
		(error.code === "EACCES" || error.code === "EPERM")
		? "permission_denied"
		: "unknown";
}

function unavailableInspection(
	issueCode: ProjectPathIssueCode,
): ValidateRuntimeBoxProjectPathOutput {
	return validateRuntimeBoxProjectPathOutputSchema.parse({ status: "unavailable", issueCode });
}
