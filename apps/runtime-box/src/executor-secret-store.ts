import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	maxRuntimeBoxMcpSecretFileBytes,
	mcpSecretInputSchema,
	runtimeResourceIdSchema,
} from "@moshu/contracts";
import type { z } from "zod";

const secretFileSchema = mcpSecretInputSchema;

export class ExecutorSecretStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = resolve(root);
		ensurePrivateDirectory(this.#root);
	}

	put(resourceIdValue: string, value: z.infer<typeof secretFileSchema>): string {
		const resourceId = runtimeResourceIdSchema.parse(resourceIdValue);
		const secret = secretFileSchema.parse(value);
		const locator = crypto.randomUUID();
		const filename = this.#resolveLocator(locator);
		const payload = JSON.stringify({
			schemaVersion: 1,
			resourceId,
			value: secret,
		});
		if (Buffer.byteLength(payload, "utf8") > maxRuntimeBoxMcpSecretFileBytes) {
			throw new Error("Executor secret file exceeds the size limit.");
		}
		const descriptor = openSync(
			filename,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				(process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
			0o600,
		);
		try {
			writeFileSync(descriptor, payload, { encoding: "utf8" });
			fsyncSync(descriptor);
		} catch (error) {
			try {
				unlinkSync(filename);
			} catch {
				// The original persistence failure is more useful than cleanup failure.
			}
			throw error;
		} finally {
			closeSync(descriptor);
		}
		chmodSync(filename, 0o600);
		fsyncDirectory(this.#root);
		return locator;
	}

	read(resourceIdValue: string, locator: string): z.infer<typeof secretFileSchema> {
		const resourceId = runtimeResourceIdSchema.parse(resourceIdValue);
		const filename = this.#resolveLocator(locator);
		const metadata = requirePrivateRegularFile(filename);
		if (metadata.size > maxRuntimeBoxMcpSecretFileBytes) {
			throw new Error("Executor secret file exceeds the size limit.");
		}
		const descriptor = openSync(
			filename,
			constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
		);
		let raw: string;
		try {
			raw = readFileSync(descriptor, "utf8");
		} finally {
			closeSync(descriptor);
		}
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("schemaVersion" in parsed) ||
			parsed.schemaVersion !== 1 ||
			!("resourceId" in parsed) ||
			parsed.resourceId !== resourceId ||
			!("value" in parsed)
		) {
			throw new Error("Executor secret file does not match its resource.");
		}
		return secretFileSchema.parse(parsed.value);
	}

	delete(locator: string): void {
		const filename = this.#resolveLocator(locator);
		if (!existsSync(filename)) {
			return;
		}
		requirePrivateRegularFile(filename);
		unlinkSync(filename);
		fsyncDirectory(this.#root);
	}

	cleanupOrphans(referencedLocators: ReadonlySet<string>): void {
		for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				continue;
			}
			const locator = entry.name.slice(0, -".json".length);
			if (!referencedLocators.has(locator)) {
				this.delete(locator);
			}
		}
	}

	#resolveLocator(locator: string): string {
		if (!/^[0-9a-f-]{36}$/i.test(locator) || basename(locator) !== locator) {
			throw new Error("Executor secret locator is invalid.");
		}
		return join(this.#root, `${locator}.json`);
	}
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Executor secret store must be a real directory.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	chmodSync(path, 0o700);
}

function requirePrivateRegularFile(path: string): Stats {
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Executor secret must be a regular file.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
		throw new Error("Executor secret permissions are too broad.");
	}
	return metadata;
}

function assertOwnedByCurrentUser(uid: number): void {
	if (
		process.platform !== "win32" &&
		typeof process.getuid === "function" &&
		uid !== process.getuid()
	) {
		throw new Error("Runtime Box private storage is not owned by the current user.");
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
