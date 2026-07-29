import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getCanonicalMutationPath(
	filePath: string,
	visitedLinks = new Set<string>(),
): Promise<string> {
	const resolvedPath = resolve(filePath);
	const metadata = await lstat(resolvedPath).catch((error: unknown) => {
		if (isMissingPathError(error)) {
			return undefined;
		}
		throw error;
	});
	if (metadata?.isSymbolicLink()) {
		if (visitedLinks.has(resolvedPath)) {
			throw new Error(`Symbolic-link cycle while resolving ${resolvedPath}`);
		}
		visitedLinks.add(resolvedPath);
		const target = await readlink(resolvedPath);
		return getCanonicalMutationPath(
			isAbsolute(target) ? target : resolve(dirname(resolvedPath), target),
			visitedLinks,
		);
	}
	const missingSegments: string[] = [];
	for (let candidate = resolvedPath; ; candidate = dirname(candidate)) {
		try {
			return join(await realpath(candidate), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
			const parent = dirname(candidate);
			if (parent === candidate) {
				throw error;
			}
			missingSegments.unshift(basename(candidate));
		}
	}
}

export async function withFileMutationQueue<T>(
	filePath: string,
	operation: (canonicalPath: string) => Promise<T>,
): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const canonicalPath = await getCanonicalMutationPath(filePath);
		const key = `path:${canonicalPath}`;
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext: (() => void) | undefined;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return {
			canonicalPath,
			key,
			currentQueue,
			chainedQueue,
			releaseNext: releaseNext ?? (() => undefined),
		};
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { canonicalPath, key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await operation(canonicalPath);
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
