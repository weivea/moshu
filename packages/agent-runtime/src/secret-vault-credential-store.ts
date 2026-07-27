import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
// @ts-expect-error proper-lockfile 4.1.2 does not publish TypeScript declarations.
import properLockfile from "proper-lockfile";

interface LockOptions {
	realpath?: boolean;
	stale?: number;
	update?: number;
	retries?: {
		retries: number;
		factor?: number;
		minTimeout?: number;
		maxTimeout?: number;
	};
}

type Lock = (path: string, options?: LockOptions) => Promise<() => Promise<void>>;
const { lock } = properLockfile as { lock: Lock };

const lockOptions = {
	realpath: false,
	stale: 30_000,
	update: 10_000,
	retries: {
		retries: 300,
		factor: 1.2,
		minTimeout: 10,
		maxTimeout: 250,
	},
} as const;

export class SecretVaultCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #parent: string;
	readonly #lockDirectory: string;
	readonly #commitLockTarget: string;
	readonly #chains = new Map<string, Promise<void>>();

	constructor(path: string) {
		this.#path = resolve(path);
		this.#parent = dirname(this.#path);
		this.#lockDirectory = join(this.#parent, ".provider-locks");
		this.#commitLockTarget = join(this.#lockDirectory, "vault-commit");
		mkdirSync(this.#parent, { recursive: true, mode: 0o700 });
		chmodSync(this.#parent, 0o700);
		mkdirSync(this.#lockDirectory, { recursive: true, mode: 0o700 });
		chmodSync(this.#lockDirectory, 0o700);
		ensureLockTarget(this.#commitLockTarget);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return structuredClone(this.#readAll()[requireProviderId(providerId)]);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#readAll())
			.map(([providerId, credential]) => ({ providerId, type: credential.type }))
			.sort((left, right) => left.providerId.localeCompare(right.providerId));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const id = requireProviderId(providerId);
		return this.#serialize(id, async () => {
			return this.#withProviderLock(id, async () => {
				const current = await this.#withCommitLock(() => structuredClone(this.#readAll()[id]));
				const next = await fn(structuredClone(current));
				if (next === undefined) {
					return structuredClone(current);
				}
				const merged =
					next.type === "api_key" &&
					next.env === undefined &&
					current?.type === "api_key" &&
					current.env !== undefined
						? { ...next, env: structuredClone(current.env) }
						: next;
				return this.#withCommitLock(() => {
					const credentials = this.#readAll();
					credentials[id] = structuredClone(merged);
					this.#writeAll(credentials);
					return structuredClone(credentials[id]);
				});
			});
		});
	}

	async delete(providerId: string): Promise<void> {
		const id = requireProviderId(providerId);
		await this.#serialize(id, async () => {
			await this.#withProviderLock(id, () =>
				this.#withCommitLock(() => {
					const credentials = this.#readAll();
					if (credentials[id] !== undefined) {
						delete credentials[id];
						this.#writeAll(credentials);
					}
				}),
			);
		});
	}

	#readAll(): Record<string, Credential> {
		if (!existsSync(this.#path)) {
			return {};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#path, "utf8"));
		} catch {
			throw new Error("Credential vault contains invalid JSON.");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Credential vault must contain a JSON object.");
		}
		return parsed as Record<string, Credential>;
	}

	#writeAll(credentials: Record<string, Credential>): void {
		const temporaryPath = `${this.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporaryPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify(credentials)}\n`, "utf8");
			chmodSync(temporaryPath, 0o600);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporaryPath, this.#path);
			chmodSync(this.#path, 0o600);
			fsyncFile(this.#path);
			fsyncDirectory(this.#parent);
		} finally {
			if (descriptor !== undefined) {
				closeSync(descriptor);
			}
			rmSync(temporaryPath, { force: true });
		}
	}

	async #withProviderLock<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const digest = createHash("sha256").update(providerId).digest("hex");
		const target = join(this.#lockDirectory, `provider-${digest}`);
		ensureLockTarget(target);
		return withLock(target, operation);
	}

	async #withCommitLock<T>(operation: () => T | Promise<T>): Promise<T> {
		return withLock(this.#commitLockTarget, operation);
	}

	async #serialize<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const settled = previous.catch(() => undefined);
		const result = settled.then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#chains.set(providerId, tail);
		try {
			return await result;
		} finally {
			if (this.#chains.get(providerId) === tail) {
				this.#chains.delete(providerId);
			}
		}
	}
}

async function withLock<T>(target: string, operation: () => T | Promise<T>): Promise<T> {
	const release = await lock(target, lockOptions);
	try {
		return await operation();
	} finally {
		await release();
	}
}

function ensureLockTarget(path: string): void {
	writeFileSync(path, "", { mode: 0o600, flag: "a" });
	chmodSync(path, 0o600);
}

function fsyncFile(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function fsyncDirectory(path: string): void {
	if (process.platform === "win32") {
		return;
	}
	const descriptor = openSync(path, "r");
	try {
		try {
			fsyncSync(descriptor);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EINVAL" && code !== "ENOTSUP") {
				throw error;
			}
		}
	} finally {
		closeSync(descriptor);
	}
}

function requireProviderId(providerId: string): string {
	const normalized = providerId.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new TypeError("A valid provider ID is required.");
	}
	return normalized;
}
