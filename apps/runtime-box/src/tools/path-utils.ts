import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const narrowNoBreakSpace = "\u202F";

function normalizePathInput(input: string): string {
	let normalized = input.replace(unicodeSpaces, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (normalized === "~") {
		return homedir();
	}
	if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}
	return normalized;
}

export function resolveToCwd(input: string, cwd: string): string {
	const normalized = normalizePathInput(input);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveReadPath(input: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(input, cwd);
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${narrowNoBreakSpace}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];
	for (const variant of variants) {
		if (await pathExists(variant)) {
			return variant;
		}
	}
	return resolved;
}

export { pathExists };
