import { maxRetainedSessionRetirements, retiredSessionTombstoneTtlMs } from "@moshu/contracts";

export interface SessionRetirementCacheEntry<T> {
	readonly sessionId: string;
	readonly retiredAtMs: number;
	value: T;
}

export class SessionRetirementCapacityError extends Error {
	constructor(readonly capacity = maxRetainedSessionRetirements) {
		super(`The retained Session retirement limit of ${capacity} was reached.`);
		this.name = "SessionRetirementCapacityError";
	}
}

interface SessionRetirementCacheOptions {
	readonly capacity?: number;
	readonly now?: () => number;
	readonly ttlMs?: number;
}

interface RememberSessionRetirementOptions {
	readonly refreshExisting?: boolean;
	readonly retiredAtMs?: number;
}

export class SessionRetirementCache<T> {
	readonly #entries = new Map<string, SessionRetirementCacheEntry<T>>();
	readonly #capacity: number;
	readonly #now: () => number;
	readonly #ttlMs: number;

	constructor(options: SessionRetirementCacheOptions = {}) {
		this.#capacity = requirePositiveSafeInteger(
			options.capacity ?? maxRetainedSessionRetirements,
			"capacity",
		);
		this.#ttlMs = requirePositiveSafeInteger(
			options.ttlMs ?? retiredSessionTombstoneTtlMs,
			"ttlMs",
		);
		this.#now = options.now ?? Date.now;
	}

	get(sessionId: string): SessionRetirementCacheEntry<T> | undefined {
		this.#purgeExpired(this.#now());
		return this.#entries.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.get(sessionId) !== undefined;
	}

	remember(
		sessionId: string,
		value: T,
		options: RememberSessionRetirementOptions = {},
	): { entry: SessionRetirementCacheEntry<T>; inserted: boolean } {
		const nowMs = options.retiredAtMs ?? this.#now();
		this.#purgeExpired(nowMs);
		const existing = this.#entries.get(sessionId);
		if (existing !== undefined && !options.refreshExisting) {
			return { entry: existing, inserted: false };
		}
		if (existing === undefined && this.#entries.size >= this.#capacity) {
			throw new SessionRetirementCapacityError(this.#capacity);
		}
		const entry = { sessionId, retiredAtMs: nowMs, value };
		if (existing !== undefined) {
			this.#entries.delete(sessionId);
		}
		this.#entries.set(sessionId, entry);
		return { entry, inserted: existing === undefined };
	}

	entries(): SessionRetirementCacheEntry<T>[] {
		this.#purgeExpired(this.#now());
		return [...this.#entries.values()];
	}

	isCurrent(entry: SessionRetirementCacheEntry<T>): boolean {
		return this.get(entry.sessionId) === entry;
	}

	clear(): void {
		this.#entries.clear();
	}

	get size(): number {
		this.#purgeExpired(this.#now());
		return this.#entries.size;
	}

	#purgeExpired(nowMs: number): void {
		const cutoffMs = nowMs - this.#ttlMs;
		for (const [sessionId, entry] of this.#entries) {
			if (entry.retiredAtMs <= cutoffMs) {
				this.#entries.delete(sessionId);
			}
		}
	}
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer.`);
	}
	return value;
}
