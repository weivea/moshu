import type { ChatSessionInvalidation } from "../../../shared/rpc";

export type ChatSessionInvalidationHandler = (
	invalidation: ChatSessionInvalidation,
) => void | PromiseLike<void>;

interface PendingInvalidation {
	deadlineMs: number;
	dispatchStarted: boolean;
	invalidation: ChatSessionInvalidation;
	promise: Promise<void>;
	reject(error: unknown): void;
	resolve(): void;
	timeout: ReturnType<typeof setTimeout>;
}

export class ChatSessionInvalidationBridge {
	readonly #timeoutMs: number;
	readonly #maxPending: number;
	readonly #listeners = new Map<ChatSessionInvalidationHandler, boolean>();
	readonly #pending = new Map<string, PendingInvalidation>();
	#closed = false;

	constructor({
		timeoutMs,
		maxPending,
	}: {
		timeoutMs: number;
		maxPending: number;
	}) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			throw new TypeError("Invalidation timeout must be a positive safe integer.");
		}
		if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
			throw new TypeError("Invalidation queue size must be a positive safe integer.");
		}
		this.#timeoutMs = timeoutMs;
		this.#maxPending = maxPending;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	subscribe(
		listener: ChatSessionInvalidationHandler,
		{ authoritative = false }: { authoritative?: boolean } = {},
	): () => void {
		if (this.#closed) {
			return () => {};
		}
		this.#listeners.set(listener, authoritative);
		if (authoritative) {
			for (const pending of this.#pending.values()) {
				this.#dispatchPending(pending);
			}
		}
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async handle(invalidation: ChatSessionInvalidation): Promise<boolean> {
		if (this.#closed) {
			return false;
		}
		try {
			const listeners = this.#listenersForAuthoritativeDispatch();
			if (listeners !== undefined) {
				await settleWithin(
					Promise.all(
						listeners.map((listener) => Promise.resolve().then(() => listener(invalidation))),
					),
					this.#timeoutMs,
				);
			} else {
				await this.#enqueue(invalidation);
			}
			return true;
		} catch {
			return false;
		}
	}

	shutdown(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#listeners.clear();
		for (const pending of [...this.#pending.values()]) {
			this.#finishPending(
				pending,
				new Error("Chat Session invalidation handling stopped during WebView unload."),
			);
		}
	}

	#enqueue(invalidation: ChatSessionInvalidation): Promise<void> {
		const existing = this.#pending.get(invalidation.invalidationId);
		if (existing !== undefined) {
			if (
				existing.invalidation.sessionId !== invalidation.sessionId ||
				existing.invalidation.reason !== invalidation.reason
			) {
				this.#finishPending(
					existing,
					new Error("A chat Session invalidation ID was reused with different data."),
				);
				return Promise.reject(
					new Error("A chat Session invalidation ID was reused with different data."),
				);
			}
			return existing.promise;
		}

		while (this.#pending.size >= this.#maxPending) {
			const oldest = this.#pending.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.#finishPending(
				oldest,
				new Error("The pending chat Session invalidation queue reached its limit."),
			);
		}

		let resolvePromise!: () => void;
		let rejectPromise!: (error: unknown) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const pending: PendingInvalidation = {
			deadlineMs: Date.now() + this.#timeoutMs,
			dispatchStarted: false,
			invalidation,
			promise,
			reject: rejectPromise,
			resolve: resolvePromise,
			timeout: setTimeout(() => {
				this.#finishPending(
					pending,
					new Error("Chat Session invalidation handling timed out before coordinator replay."),
				);
			}, this.#timeoutMs),
		};
		this.#pending.set(invalidation.invalidationId, pending);
		return promise;
	}

	#dispatchPending(pending: PendingInvalidation): void {
		if (
			pending.dispatchStarted ||
			this.#pending.get(pending.invalidation.invalidationId) !== pending
		) {
			return;
		}
		const listeners = this.#listenersForAuthoritativeDispatch();
		if (listeners === undefined) {
			return;
		}
		pending.dispatchStarted = true;
		const remainingMs = pending.deadlineMs - Date.now();
		if (remainingMs <= 0) {
			this.#finishPending(
				pending,
				new Error("Chat Session invalidation handling timed out before coordinator replay."),
			);
			return;
		}
		void settleWithin(
			Promise.all(
				listeners.map((listener) => Promise.resolve().then(() => listener(pending.invalidation))),
			),
			remainingMs,
		).then(
			() => this.#finishPending(pending),
			(error: unknown) => this.#finishPending(pending, error),
		);
	}

	#listenersForAuthoritativeDispatch(): ChatSessionInvalidationHandler[] | undefined {
		if (![...this.#listeners.values()].some(Boolean)) {
			return undefined;
		}
		return [...this.#listeners.keys()];
	}

	#finishPending(pending: PendingInvalidation, error?: unknown): void {
		if (this.#pending.get(pending.invalidation.invalidationId) !== pending) {
			return;
		}
		this.#pending.delete(pending.invalidation.invalidationId);
		clearTimeout(pending.timeout);
		if (error === undefined) {
			pending.resolve();
		} else {
			pending.reject(error);
		}
	}
}

async function settleWithin<T>(operation: PromiseLike<T> | T, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(operation),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Chat Session invalidation handling timed out.")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}
