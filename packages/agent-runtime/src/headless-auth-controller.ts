import type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	AuthType,
	Models,
} from "@earendil-works/pi-ai";
import type {
	ProviderAuthAttemptOutput,
	AuthChallenge,
	AuthNotification,
	RespondProviderAuthInput,
	StartProviderAuthInput,
} from "@moshu/contracts";

interface PendingChallenge {
	challenge: AuthChallenge;
	resolve(value: string): void;
	reject(error: Error): void;
	removeAbortListener(): void;
}

interface AuthAttempt {
	id: string;
	providerId: string;
	authType: AuthType;
	status: ProviderAuthAttemptOutput["attempt"]["status"];
	createdAt: string;
	updatedAt: string;
	challenge: PendingChallenge | undefined;
	notifications: AuthNotification[];
	error: string | undefined;
	controller: AbortController;
	execution?: Promise<void>;
	terminalAt?: number;
	lastChallengeType?: AuthPrompt["type"];
	lastNotificationType?: AuthEvent["type"];
}

export interface ProviderAuthDiagnosticError {
	name: string;
	message: string;
	code?: string;
	status?: number;
	cause?: ProviderAuthDiagnosticError;
}

export interface ProviderAuthDiagnosticEvent {
	event:
		| "attempt_started"
		| "attempt_reused"
		| "challenge_requested"
		| "challenge_submitted"
		| "provider_notification"
		| "attempt_completed"
		| "attempt_failed"
		| "attempt_cancelled"
		| "logout_started"
		| "logout_completed"
		| "logout_failed";
	attemptId?: string;
	providerId: string;
	authType?: AuthType;
	challengeType?: AuthPrompt["type"];
	notificationType?: AuthEvent["type"];
	response?: "empty" | "provided";
	error?: ProviderAuthDiagnosticError;
}

export interface HeadlessAuthControllerOptions {
	maxAttempts?: number;
	maxNotifications?: number;
	terminalTtlMs?: number;
	now?: () => number;
	onCredentialChanged?: (providerId: string) => Promise<void>;
	reportDiagnostic?: (event: ProviderAuthDiagnosticEvent) => void;
}

export class HeadlessAuthController {
	readonly #attempts = new Map<string, AuthAttempt>();
	readonly #maxAttempts: number;
	readonly #maxNotifications: number;
	readonly #terminalTtlMs: number;
	readonly #now: () => number;
	readonly #onCredentialChanged: ((providerId: string) => Promise<void>) | undefined;
	readonly #reportDiagnostic: ((event: ProviderAuthDiagnosticEvent) => void) | undefined;
	#disposed = false;

	constructor(
		private readonly models: Models,
		options: HeadlessAuthControllerOptions = {},
	) {
		this.#maxAttempts = options.maxAttempts ?? 64;
		this.#maxNotifications = options.maxNotifications ?? 128;
		this.#terminalTtlMs = options.terminalTtlMs ?? 5 * 60_000;
		this.#now = options.now ?? Date.now;
		this.#onCredentialChanged = options.onCredentialChanged;
		this.#reportDiagnostic = options.reportDiagnostic;
	}

	start(input: StartProviderAuthInput): ProviderAuthAttemptOutput {
		this.#assertActive();
		this.#prune();
		const existing = [...this.#attempts.values()].find(
			(attempt) =>
				attempt.providerId === input.providerId &&
				attempt.authType === input.authType &&
				!isTerminal(attempt.status),
		);
		if (existing !== undefined) {
			this.#report(existing, { event: "attempt_reused" });
			return projectAttempt(existing);
		}
		if (this.#attempts.size >= this.#maxAttempts) {
			throw new Error("Too many Provider authentication attempts are retained.");
		}
		const now = new Date().toISOString();
		const attempt: AuthAttempt = {
			id: createUuidV7(),
			providerId: input.providerId,
			authType: input.authType,
			status: "created",
			createdAt: now,
			updatedAt: now,
			notifications: [],
			challenge: undefined,
			error: undefined,
			controller: new AbortController(),
		};
		this.#attempts.set(attempt.id, attempt);
		this.#report(attempt, { event: "attempt_started" });
		attempt.execution = this.#authenticate(attempt);
		return projectAttempt(attempt);
	}

	get(attemptId: string): ProviderAuthAttemptOutput {
		this.#prune();
		return projectAttempt(this.#require(attemptId));
	}

	respond(input: RespondProviderAuthInput): ProviderAuthAttemptOutput {
		this.#assertActive();
		this.#prune();
		const attempt = this.#require(input.attemptId);
		const pending = attempt.challenge;
		if (pending === undefined || pending.challenge.id !== input.challengeId) {
			throw new Error("Authentication challenge is no longer pending.");
		}
		attempt.challenge = undefined;
		attempt.status = "authenticating";
		attempt.updatedAt = new Date().toISOString();
		this.#report(attempt, {
			event: "challenge_submitted",
			challengeType: pending.challenge.type,
			response: input.value.length === 0 ? "empty" : "provided",
		});
		pending.removeAbortListener();
		pending.resolve(input.value);
		return projectAttempt(attempt);
	}

	cancel(attemptId: string): ProviderAuthAttemptOutput {
		const attempt = this.#require(attemptId);
		if (!isTerminal(attempt.status)) {
			attempt.controller.abort(new Error("Authentication cancelled."));
			attempt.challenge?.reject(new Error("Authentication cancelled."));
			attempt.challenge?.removeAbortListener();
			attempt.challenge = undefined;
			attempt.status = "cancelled";
			attempt.updatedAt = new Date().toISOString();
			attempt.terminalAt = this.#now();
			this.#report(attempt, { event: "attempt_cancelled" });
		}
		return projectAttempt(attempt);
	}

	async logout(providerId: string): Promise<{
		schemaVersion: 2;
		providerId: string;
		configured: false;
	}> {
		this.#assertActive();
		this.#reportProvider({ event: "logout_started", providerId });
		for (const attempt of this.#attempts.values()) {
			if (attempt.providerId === providerId && !isTerminal(attempt.status)) {
				this.cancel(attempt.id);
			}
		}
		try {
			await this.models.logout(providerId);
			await this.#onCredentialChanged?.(providerId);
			this.#reportProvider({ event: "logout_completed", providerId });
			return { schemaVersion: 2, providerId, configured: false };
		} catch (error) {
			this.#reportProvider({
				event: "logout_failed",
				providerId,
				error: toDiagnosticError(error),
			});
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		const executions: Promise<void>[] = [];
		for (const attempt of this.#attempts.values()) {
			if (!isTerminal(attempt.status)) {
				this.cancel(attempt.id);
			}
			if (attempt.execution !== undefined) {
				executions.push(attempt.execution);
			}
		}
		await Promise.allSettled(executions);
	}

	async #authenticate(attempt: AuthAttempt): Promise<void> {
		attempt.status = "authenticating";
		attempt.updatedAt = new Date().toISOString();
		const interaction: AuthInteraction = {
			signal: attempt.controller.signal,
			prompt: (prompt) => this.#prompt(attempt, prompt),
			notify: (event) => {
				attempt.notifications.push(toNotification(event));
				attempt.lastNotificationType = event.type;
				if (attempt.notifications.length > this.#maxNotifications) {
					attempt.notifications.splice(0, attempt.notifications.length - this.#maxNotifications);
				}
				attempt.updatedAt = new Date().toISOString();
				this.#report(attempt, {
					event: "provider_notification",
					notificationType: event.type,
				});
			},
		};
		try {
			await this.models.login(attempt.providerId, attempt.authType, interaction);
			if (!attempt.controller.signal.aborted) {
				await this.#onCredentialChanged?.(attempt.providerId);
				attempt.status = "completed";
				this.#report(attempt, { event: "attempt_completed" });
			}
		} catch (error) {
			if (attempt.controller.signal.aborted) {
				attempt.status = "cancelled";
			} else {
				attempt.status = "failed";
				attempt.error = "Authentication failed.";
				this.#report(attempt, {
					event: "attempt_failed",
					error: toDiagnosticError(error),
				});
			}
		} finally {
			attempt.challenge?.removeAbortListener();
			attempt.challenge = undefined;
			attempt.updatedAt = new Date().toISOString();
			if (isTerminal(attempt.status)) {
				attempt.terminalAt = this.#now();
			}
		}
	}

	#prompt(attempt: AuthAttempt, prompt: AuthPrompt): Promise<string> {
		if (attempt.controller.signal.aborted || prompt.signal?.aborted) {
			return Promise.reject(new Error("Authentication cancelled."));
		}
		return new Promise<string>((resolve, reject) => {
			const onAbort = () => reject(new Error("Authentication cancelled."));
			attempt.controller.signal.addEventListener("abort", onAbort, { once: true });
			prompt.signal?.addEventListener("abort", onAbort, { once: true });
			attempt.challenge = {
				challenge: toChallenge(prompt),
				resolve,
				reject,
				removeAbortListener: () => {
					attempt.controller.signal.removeEventListener("abort", onAbort);
					prompt.signal?.removeEventListener("abort", onAbort);
				},
			};
			attempt.lastChallengeType = prompt.type;
			attempt.status = "waiting_for_interaction";
			attempt.updatedAt = new Date().toISOString();
			this.#report(attempt, {
				event: "challenge_requested",
				challengeType: prompt.type,
			});
		});
	}

	#report(
		attempt: AuthAttempt,
		event: Omit<ProviderAuthDiagnosticEvent, "attemptId" | "providerId" | "authType">,
	): void {
		this.#reportProvider({
			...event,
			attemptId: attempt.id,
			providerId: attempt.providerId,
			authType: attempt.authType,
			...(event.event === "attempt_failed"
				? {
						...(attempt.lastChallengeType === undefined
							? {}
							: { challengeType: attempt.lastChallengeType }),
						...(attempt.lastNotificationType === undefined
							? {}
							: { notificationType: attempt.lastNotificationType }),
					}
				: {}),
		});
	}

	#reportProvider(event: ProviderAuthDiagnosticEvent): void {
		if (this.#reportDiagnostic === undefined) {
			return;
		}
		try {
			this.#reportDiagnostic(event);
		} catch {
			console.error("Failed to write a Provider authentication diagnostic.");
		}
	}

	#require(attemptId: string): AuthAttempt {
		const attempt = this.#attempts.get(attemptId);
		if (attempt === undefined) {
			throw new Error("Authentication attempt was not found.");
		}
		return attempt;
	}

	#prune(): void {
		const cutoff = this.#now() - this.#terminalTtlMs;
		for (const [attemptId, attempt] of this.#attempts) {
			if (attempt.terminalAt !== undefined && attempt.terminalAt <= cutoff) {
				this.#attempts.delete(attemptId);
			}
		}
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new Error("Provider authentication is shutting down.");
		}
	}
}

function projectAttempt(attempt: AuthAttempt): ProviderAuthAttemptOutput {
	return {
		attempt: {
			schemaVersion: 2,
			id: attempt.id,
			providerId: attempt.providerId,
			authType: attempt.authType,
			status: attempt.status,
			createdAt: attempt.createdAt,
			updatedAt: attempt.updatedAt,
			...(attempt.challenge === undefined ? {} : { challenge: attempt.challenge.challenge }),
			notifications: [...attempt.notifications],
			...(attempt.error === undefined ? {} : { error: attempt.error }),
		},
	};
}

function toChallenge(prompt: AuthPrompt): AuthChallenge {
	return {
		id: createUuidV7(),
		type: prompt.type,
		message: prompt.message,
		...("placeholder" in prompt && prompt.placeholder !== undefined
			? { placeholder: prompt.placeholder }
			: {}),
		...(prompt.type === "select" ? { options: [...prompt.options] } : {}),
	} as AuthChallenge;
}

function toNotification(event: AuthEvent): AuthNotification {
	if (event.type === "info") {
		return {
			type: "info",
			message: event.message,
			...(event.links === undefined ? {} : { links: event.links.map((link) => ({ ...link })) }),
		};
	}
	return { ...event };
}

function isTerminal(status: AuthAttempt["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function createUuidV7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let timestamp = Date.now();
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp & 0xff;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toDiagnosticError(error: unknown, depth = 0): ProviderAuthDiagnosticError {
	const record =
		typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
	const name =
		error instanceof Error
			? error.name
			: typeof record.name === "string"
				? record.name
				: "UnknownError";
	const message =
		error instanceof Error
			? error.message
			: typeof record.message === "string"
				? record.message
				: typeof error === "string"
					? error
					: "Unknown Provider authentication error.";
	const code = typeof record.code === "string" ? record.code : undefined;
	const status =
		typeof record.status === "number"
			? record.status
			: typeof record.statusCode === "number"
				? record.statusCode
				: undefined;
	const cause =
		depth < 3 && record.cause !== undefined
			? toDiagnosticError(record.cause, depth + 1)
			: undefined;
	return {
		name: sanitizeDiagnosticText(name, 100),
		message: sanitizeDiagnosticMessage(message),
		...(code === undefined ? {} : { code: sanitizeDiagnosticText(code, 100) }),
		...(status === undefined ? {} : { status }),
		...(cause === undefined ? {} : { cause }),
	};
}

function sanitizeDiagnosticMessage(value: string): string {
	const withoutUrls = value.replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
		try {
			const url = new URL(rawUrl);
			url.username = "";
			url.password = "";
			url.search = "";
			url.hash = "";
			return url.toString();
		} catch {
			return "[REDACTED_URL]";
		}
	});
	return sanitizeDiagnosticText(withoutUrls, 1_000)
		.replace(/\b(?:Bearer\s+)?(?:gh[opusr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9._-]+)\b/gi, "[REDACTED]")
		.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "[REDACTED_CODE]")
		.replace(
			/((?:"|')?(?:(?:access|refresh|id)[_-]?token|device[_ -]?code|user[_ -]?code|api[_ -]?key|secret|authorization|password)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;\s}]+)/gi,
			"$1[REDACTED]",
		);
}

function sanitizeDiagnosticText(value: string, maxLength: number): string {
	return value.replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}
