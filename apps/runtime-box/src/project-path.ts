import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import {
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

export async function validateProjectPath(
	inputValue: ValidateRuntimeBoxProjectPathInput,
): Promise<ValidateRuntimeBoxProjectPathOutput> {
	const input = validateRuntimeBoxProjectPathInputSchema.parse(inputValue);
	if (!isAbsolute(input.path)) {
		throw new Error("Project path must be absolute on the Runtime Box.");
	}
	const normalizedPath = await realpath(resolve(input.path));
	const metadata = await stat(normalizedPath);
	if (!metadata.isDirectory()) {
		throw new Error("Project path must refer to a directory.");
	}
	await access(normalizedPath, constants.R_OK | constants.X_OK);
	const git = await findGitMetadata(normalizedPath);
	return validateRuntimeBoxProjectPathOutputSchema.parse({
		normalizedPath,
		displayName: basename(normalizedPath) || normalizedPath,
		...(git === undefined ? {} : git),
	});
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
