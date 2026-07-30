import { randomUUID } from "node:crypto";
import {
	type RemoteAccessAuthAttempt,
	type RemoteAccessStatusOutput,
	remoteAccessAuthAttemptSchema,
	remoteAccessStatusOutputSchema,
} from "@moshu/contracts";
import type { RemoteAccessRepository } from "@moshu/database";

const devTunnelMonthlyLimitBytes = 5 * 1024 * 1024 * 1024;
const devTunnelTrafficFlushBytes = 1024 * 1024;
const devTunnelTrafficFlushMs = 1_000;
const devTunnelAuthenticationRefreshMs = 5_000;

export interface DevTunnelHostProcess {
	readonly ready: Promise<{ publicUrl: string }>;
	readonly exited: Promise<number>;
	stop(force?: boolean): void;
}

export interface DevTunnelAuthenticationProcess {
	readonly completed: Promise<{ exitCode: number; message: string }>;
	onOutput(listener: (message: string) => void): () => void;
	stop(): void;
}

export interface DevTunnelAdapter {
	isAuthenticated(signal: AbortSignal): Promise<boolean>;
	startAuthentication(): DevTunnelAuthenticationProcess;
	ensureTunnel(tunnelId: string, port: number, signal: AbortSignal): Promise<string>;
	deleteTunnel(tunnelId: string, signal: AbortSignal): Promise<void>;
	startHost(tunnelId: string, port: number): DevTunnelHostProcess;
}

export interface DevTunnelServiceOptions {
	repository: RemoteAccessRepository;
	runtimeIngressPort: number;
	adapter?: DevTunnelAdapter;
	reportDiagnostic?: (message: string) => void;
	portConflict?: { expectedPort: number; boundPort: number };
	now?: () => number;
}

interface SharedMutationOperation {
	readonly epoch: number;
	readonly promise: Promise<RemoteAccessStatusOutput>;
	readonly controller: AbortController;
	waiters: number;
	settled: boolean;
}

interface AuthenticationProbe {
	readonly promise: Promise<boolean>;
	readonly controller: AbortController;
}

class DevTunnelAuthenticationRequiredError extends Error {
	constructor(message = "Dev Tunnels authentication is required.") {
		super(message);
		this.name = "DevTunnelAuthenticationRequiredError";
	}
}

export class DevTunnelService {
	readonly #repository: RemoteAccessRepository;
	readonly #runtimeIngressPort: number;
	readonly #adapter: DevTunnelAdapter;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #now: () => number;
	#portConflict: { expectedPort: number; boundPort: number } | undefined;
	readonly #authAttempts = new Map<string, RemoteAccessAuthAttempt>();
	readonly #authProcesses = new Set<DevTunnelAuthenticationProcess>();
	#authenticated = false;
	#authenticationCheckedAt: number | undefined;
	#authenticationProbe: AuthenticationProbe | undefined;
	#state: RemoteAccessStatusOutput["state"] = "disabled";
	#lastError: string | undefined;
	#host: DevTunnelHostProcess | undefined;
	#stopping = false;
	#operationGeneration = 0;
	#mutationEpoch = 0;
	#restartAttempt = 0;
	#restartTimer: ReturnType<typeof setTimeout> | undefined;
	#stableTimer: ReturnType<typeof setTimeout> | undefined;
	#mutationTail: Promise<void> = Promise.resolve();
	#startPromise: Promise<void> | undefined;
	#startAbortController: AbortController | undefined;
	#enableOperation: SharedMutationOperation | undefined;
	#recreateOperation: SharedMutationOperation | undefined;
	readonly #pendingTraffic = new Map<string, { receivedBytes: number; sentBytes: number }>();
	#trafficFlushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: DevTunnelServiceOptions) {
		this.#repository = options.repository;
		this.#runtimeIngressPort = options.runtimeIngressPort;
		this.#adapter =
			options.adapter ??
			new DevTunnelCliAdapter(process.env.MOSHU_DEVTUNNEL_PATH?.trim() || "devtunnel");
		this.#reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
		this.#now = options.now ?? Date.now;
		this.#portConflict = options.portConflict;
		if (this.#portConflict !== undefined) {
			this.#state = "repair_required";
			this.#lastError =
				`Runtime ingress port ${this.#portConflict.expectedPort} is unavailable; ` +
				`repair can move Remote Access to ${this.#portConflict.boundPort}.`;
		}
	}

	async start(): Promise<void> {
		if (this.#stopping || !this.#repository.get().enabled) {
			return;
		}
		const generation = ++this.#mutationEpoch;
		this.#operationGeneration = generation;
		if (this.#portConflict !== undefined) {
			this.#state = "repair_required";
			return;
		}
		await this.#enqueueMutation(generation, async () => {
			await this.#startHost(generation);
			return this.getStatus();
		});
	}

	getStatus(): RemoteAccessStatusOutput {
		const settings = this.#repository.get();
		const month = currentUtcMonth(this.#now());
		const pending = this.#pendingTraffic.get(month);
		const receivedBytes =
			(settings.trafficMonth === month ? settings.trafficReceivedBytes : 0) +
			(pending?.receivedBytes ?? 0);
		const sentBytes =
			(settings.trafficMonth === month ? settings.trafficSentBytes : 0) + (pending?.sentBytes ?? 0);
		const totalBytes = receivedBytes + sentBytes;
		const state =
			settings.enabled || this.#state === "stopping" || this.#host !== undefined
				? this.#state
				: "disabled";
		return remoteAccessStatusOutputSchema.parse({
			enabled: settings.enabled,
			authenticated: this.#authenticated,
			state,
			runtimeIngressPort: this.#runtimeIngressPort,
			...(settings.tunnelId === undefined ? {} : { tunnelId: settings.tunnelId }),
			...(settings.publicUrl === undefined ? {} : { publicUrl: settings.publicUrl }),
			...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
			trafficEstimate: {
				month,
				receivedBytes,
				sentBytes,
				totalBytes,
				monthlyLimitBytes: devTunnelMonthlyLimitBytes,
				warningLevel: trafficWarningLevel(totalBytes),
				source: "runtime-rpc-application-payload-estimate",
			},
			serviceLimits: {
				maxTunnelsPerUser: 10,
				maxPortsPerTunnel: 10,
				maxBytesPerSecond: 20 * 1024 * 1024,
			},
		});
	}

	async refreshAuthentication(signal?: AbortSignal): Promise<RemoteAccessStatusOutput> {
		this.#assertRunning();
		throwIfAborted(signal);
		if (
			this.#authenticationCheckedAt !== undefined &&
			this.#now() - this.#authenticationCheckedAt < devTunnelAuthenticationRefreshMs
		) {
			return this.getStatus();
		}
		let probe = this.#authenticationProbe;
		if (probe === undefined) {
			const controller = new AbortController();
			const promise = withAbortTimeout(
				this.#adapter.isAuthenticated(controller.signal),
				10_000,
				"Dev Tunnels authentication check",
				controller,
			).then((authenticated) => {
				this.#setAuthenticated(authenticated);
				return authenticated;
			});
			const createdProbe = { promise, controller };
			probe = createdProbe;
			this.#authenticationProbe = createdProbe;
			void promise.then(
				() => this.#settleAuthenticationProbe(createdProbe),
				() => this.#settleAuthenticationProbe(createdProbe),
			);
		}
		await (signal === undefined ? probe.promise : withAbortSignal(probe.promise, signal));
		return this.getStatus();
	}

	recordTraffic(direction: "inbound" | "outbound", bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new TypeError("Runtime ingress traffic bytes must be a nonnegative safe integer.");
		}
		if (bytes === 0) {
			return;
		}
		const month = currentUtcMonth(this.#now());
		const pending = this.#pendingTraffic.get(month) ?? { receivedBytes: 0, sentBytes: 0 };
		const receivedBytes = pending.receivedBytes + (direction === "inbound" ? bytes : 0);
		const sentBytes = pending.sentBytes + (direction === "outbound" ? bytes : 0);
		if (!Number.isSafeInteger(receivedBytes) || !Number.isSafeInteger(sentBytes)) {
			throw new Error("Runtime ingress traffic estimate overflow.");
		}
		this.#pendingTraffic.set(month, { receivedBytes, sentBytes });
		if (receivedBytes + sentBytes >= devTunnelTrafficFlushBytes) {
			this.#flushTraffic();
			return;
		}
		if (this.#trafficFlushTimer === undefined) {
			this.#trafficFlushTimer = setTimeout(() => {
				this.#trafficFlushTimer = undefined;
				this.#flushTraffic();
			}, devTunnelTrafficFlushMs);
		}
	}

	startAuthentication(): RemoteAccessAuthAttempt {
		this.#assertRunning();
		const attemptId = randomUUID();
		const attempt = remoteAccessAuthAttemptSchema.parse({
			attemptId,
			status: "running",
			message: "Starting Microsoft device-code login.",
		});
		this.#authAttempts.set(attemptId, attempt);
		let process: DevTunnelAuthenticationProcess;
		try {
			process = this.#adapter.startAuthentication();
			this.#authProcesses.add(process);
		} catch (error) {
			const failed = remoteAccessAuthAttemptSchema.parse({
				attemptId,
				status: "failed",
				message: safeMessage(error, "Failed to start Dev Tunnels authentication."),
			});
			this.#authAttempts.set(attemptId, failed);
			return failed;
		}
		const unsubscribe = process.onOutput((message) => {
			const current = this.#authAttempts.get(attemptId);
			if (current?.status !== "running") {
				return;
			}
			this.#authAttempts.set(
				attemptId,
				remoteAccessAuthAttemptSchema.parse({
					...current,
					message: `${current.message}\n${message}`.trim().slice(-4_096),
				}),
			);
		});
		void (async () => {
			try {
				const { exitCode, message } = await process.completed;
				unsubscribe();
				const completed = remoteAccessAuthAttemptSchema.parse({
					attemptId,
					status: exitCode === 0 ? "succeeded" : "failed",
					message: message.slice(-4_096),
				});
				this.#authAttempts.set(attemptId, completed);
				if (exitCode === 0) {
					this.#setAuthenticated(true);
				}
				if (exitCode === 0 && this.#repository.get().enabled && !this.#stopping) {
					const generation = this.#operationGeneration;
					await this.#enqueueMutation(generation, async () => {
						await this.#startHost(generation);
						return this.getStatus();
					});
				}
			} catch (error) {
				unsubscribe();
				const current = this.#authAttempts.get(attemptId);
				if (current?.status === "running") {
					this.#authAttempts.set(
						attemptId,
						remoteAccessAuthAttemptSchema.parse({
							attemptId,
							status: "failed",
							message: safeMessage(error, "Dev Tunnels authentication failed."),
						}),
					);
				} else {
					this.#reportDiagnostic(safeMessage(error, "Remote Access failed after authentication."));
				}
			} finally {
				this.#authProcesses.delete(process);
			}
		})();
		return attempt;
	}

	getAuthentication(attemptId: string): RemoteAccessAuthAttempt {
		const attempt = this.#authAttempts.get(attemptId);
		if (attempt === undefined) {
			throw new Error("Dev Tunnels authentication attempt was not found.");
		}
		return attempt;
	}

	async enable(signal?: AbortSignal): Promise<RemoteAccessStatusOutput> {
		this.#assertRunning();
		throwIfAborted(signal);
		let operation = this.#enableOperation;
		if (
			operation !== undefined &&
			operation.epoch === this.#mutationEpoch &&
			!operation.controller.signal.aborted
		) {
			return this.#waitForSharedMutation(
				operation,
				signal,
				"All Dev Tunnel enable callers cancelled.",
			);
		}
		if (
			this.#repository.get().enabled &&
			(this.#host !== undefined || this.#startPromise !== undefined) &&
			operation?.controller.signal.aborted !== true &&
			this.#recreateOperation === undefined
		) {
			if (this.#startPromise !== undefined) {
				await (signal === undefined
					? this.#startPromise
					: withAbortSignal(this.#startPromise, signal));
			}
			return this.getStatus();
		}
		const controller = new AbortController();
		const promise = this.#performEnable(controller.signal);
		const createdOperation: SharedMutationOperation = {
			epoch: this.#mutationEpoch,
			promise,
			controller,
			waiters: 0,
			settled: false,
		};
		operation = createdOperation;
		this.#enableOperation = createdOperation;
		const settle = () => {
			createdOperation.settled = true;
			if (this.#enableOperation === createdOperation) {
				this.#enableOperation = undefined;
			}
		};
		void promise.then(settle, settle);
		return this.#waitForSharedMutation(
			operation,
			signal,
			"All Dev Tunnel enable callers cancelled.",
		);
	}

	async #performEnable(signal: AbortSignal): Promise<RemoteAccessStatusOutput> {
		this.#clearRestartTimers(true);
		const epoch = ++this.#mutationEpoch;
		this.#operationGeneration = epoch;
		return this.#enqueueMutation(epoch, async () => {
			this.#repository.setEnabled(true);
			if (this.#portConflict !== undefined) {
				this.#state = "repair_required";
				return this.getStatus();
			}
			if (this.#host !== undefined) {
				await this.#stopHost();
			}
			await this.#startHost(epoch, signal);
			throwIfAborted(signal);
			return this.getStatus();
		});
	}

	async disable(): Promise<RemoteAccessStatusOutput> {
		this.#assertRunning();
		const epoch = ++this.#mutationEpoch;
		this.#operationGeneration = epoch;
		this.#state = "stopping";
		this.#lastError = undefined;
		this.#repository.setEnabled(false);
		this.#cancelStart("Remote Access was disabled.");
		return this.#enqueueMutation(epoch, async () => {
			try {
				await this.#stopHost();
				this.#state = "disabled";
				return this.getStatus();
			} catch (error) {
				this.#recordError(error);
				throw error;
			}
		});
	}

	async recreate(signal?: AbortSignal): Promise<RemoteAccessStatusOutput> {
		this.#assertRunning();
		throwIfAborted(signal);
		let operation = this.#recreateOperation;
		if (
			operation === undefined ||
			operation.epoch !== this.#mutationEpoch ||
			operation.controller.signal.aborted
		) {
			const controller = new AbortController();
			const promise = this.#performRecreate(controller.signal);
			const createdOperation: SharedMutationOperation = {
				epoch: this.#mutationEpoch,
				promise,
				controller,
				waiters: 0,
				settled: false,
			};
			operation = createdOperation;
			this.#recreateOperation = createdOperation;
			const settle = () => {
				createdOperation.settled = true;
				if (this.#recreateOperation === createdOperation) {
					this.#recreateOperation = undefined;
				}
			};
			void promise.then(settle, settle);
		}
		return this.#waitForSharedMutation(
			operation,
			signal,
			"All Dev Tunnel recreate callers cancelled.",
		);
	}

	async #performRecreate(signal?: AbortSignal): Promise<RemoteAccessStatusOutput> {
		this.#clearRestartTimers(true);
		const epoch = ++this.#mutationEpoch;
		this.#operationGeneration = epoch;
		this.#cancelStart("The Dev Tunnel is being recreated.");
		return this.#enqueueMutation(epoch, async () => {
			const generation = epoch;
			this.#state = "starting";
			this.#lastError = undefined;
			await this.#stopHost();
			const repairedPort = this.#portConflict?.boundPort;
			const existing = this.#repository.get().tunnelId;
			try {
				if (existing !== undefined) {
					await withCallerAbortTimeout(
						(deleteSignal) => this.#adapter.deleteTunnel(existing, deleteSignal),
						signal,
						20_000,
						"Dev Tunnel deletion",
					);
					if (this.#repository.get().tunnelId === existing) {
						this.#repository.clearTunnel();
					}
				}
				if (!this.#isCurrent(generation)) {
					return this.getStatus();
				}
				if (repairedPort !== undefined) {
					this.#repository.replaceRuntimeIngressPort(repairedPort);
					this.#portConflict = undefined;
				}
				this.#repository.setEnabled(true);
				await this.#startHost(generation, signal);
			} catch (error) {
				if (this.#isCurrent(generation)) {
					if (signal?.aborted) {
						this.#repository.setEnabled(false);
						this.#state = "disabled";
						this.#lastError = undefined;
						return this.getStatus();
					}
					if (error instanceof DevTunnelAuthenticationRequiredError) {
						this.#setAuthenticated(false);
						this.#state = "auth_required";
						this.#lastError = undefined;
					} else {
						this.#recordError(error);
					}
				}
			}
			return this.getStatus();
		});
	}

	async shutdown(): Promise<void> {
		this.#stopping = true;
		const epoch = ++this.#mutationEpoch;
		this.#operationGeneration = epoch;
		this.#cancelStart("The Agent Server is shutting down.");
		const authenticationProbe = this.#authenticationProbe;
		authenticationProbe?.controller.abort(new Error("The Agent Server is shutting down."));
		if (this.#trafficFlushTimer !== undefined) {
			clearTimeout(this.#trafficFlushTimer);
			this.#trafficFlushTimer = undefined;
		}
		this.#flushTraffic();
		const hostShutdown = this.#stopHost();
		await Promise.allSettled([
			this.#mutationTail,
			this.#startPromise ?? Promise.resolve(),
			authenticationProbe?.promise ?? Promise.resolve(),
		]);
		await hostShutdown.catch((error: unknown) =>
			this.#reportDiagnostic(safeMessage(error, "Dev Tunnel host shutdown failed.")),
		);
		const authentications = [...this.#authProcesses];
		for (const process of authentications) process.stop();
		await withTimeout(
			Promise.allSettled(authentications.map((process) => process.completed)),
			2_000,
			"Dev Tunnel authentication shutdown",
		).catch((error: unknown) =>
			this.#reportDiagnostic(safeMessage(error, "Auth shutdown failed.")),
		);
	}

	#flushTraffic(): void {
		for (const [month, pending] of this.#pendingTraffic) {
			this.#pendingTraffic.delete(month);
			try {
				this.#repository.recordTraffic(month, pending.receivedBytes, pending.sentBytes);
			} catch (error) {
				const retained = this.#pendingTraffic.get(month) ?? {
					receivedBytes: 0,
					sentBytes: 0,
				};
				this.#pendingTraffic.set(month, {
					receivedBytes: retained.receivedBytes + pending.receivedBytes,
					sentBytes: retained.sentBytes + pending.sentBytes,
				});
				this.#reportDiagnostic(
					safeMessage(error, "Runtime ingress traffic estimate persistence failed."),
				);
			}
		}
	}

	async #startHost(generation: number, callerSignal?: AbortSignal): Promise<void> {
		if (this.#portConflict !== undefined) {
			if (this.#isCurrent(generation)) {
				this.#state = "repair_required";
			}
			return;
		}
		if (this.#startPromise !== undefined) {
			await (callerSignal === undefined
				? this.#startPromise
				: withAbortSignal(this.#startPromise, callerSignal));
			if (this.#isCurrent(generation) && this.#host === undefined) {
				await this.#startHost(generation, callerSignal);
			}
			return;
		}
		const start = this.#performStartHost(generation, callerSignal);
		this.#startPromise = start;
		try {
			await start;
		} finally {
			if (this.#startPromise === start) {
				this.#startPromise = undefined;
			}
		}
	}

	async #performStartHost(generation: number, callerSignal?: AbortSignal): Promise<void> {
		if (
			!this.#isCurrent(generation) ||
			!this.#repository.get().enabled ||
			this.#host !== undefined
		) {
			return;
		}
		this.#state = "starting";
		this.#lastError = undefined;
		const startAbortController = new AbortController();
		let callerCancelled = false;
		const cancelFromCaller = () => {
			callerCancelled = true;
			startAbortController.abort(
				callerSignal === undefined
					? new Error("Dev Tunnel operation was cancelled.")
					: abortSignalError(callerSignal),
			);
		};
		if (callerSignal?.aborted) {
			cancelFromCaller();
		} else {
			callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
		}
		this.#startAbortController = startAbortController;
		let ownedHost: DevTunnelHostProcess | undefined;
		try {
			const authenticated = await withAbortTimeout(
				this.#adapter.isAuthenticated(startAbortController.signal),
				10_000,
				"Dev Tunnels authentication check",
				startAbortController,
			);
			this.#setAuthenticated(authenticated);
			throwIfAborted(startAbortController.signal);
			if (!this.#isCurrent(generation)) {
				return;
			}
			if (!authenticated) {
				this.#state = "auth_required";
				return;
			}
			const settings = this.#repository.get();
			const tunnelId =
				settings.tunnelId ?? `moshu-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
			if (settings.tunnelId === undefined) {
				this.#repository.setTunnel(tunnelId);
			}
			const qualifiedTunnelId = await withAbortTimeout(
				this.#adapter.ensureTunnel(tunnelId, this.#runtimeIngressPort, startAbortController.signal),
				30_000,
				"Dev Tunnel setup",
				startAbortController,
			);
			throwIfAborted(startAbortController.signal);
			if (!this.#isCurrent(generation)) {
				return;
			}
			if (qualifiedTunnelId !== tunnelId) {
				this.#repository.setTunnel(qualifiedTunnelId);
			}
			ownedHost = this.#adapter.startHost(qualifiedTunnelId, this.#runtimeIngressPort);
			this.#host = ownedHost;
			const ready = await withAbortTimeout(
				withAbortSignal(ownedHost.ready, startAbortController.signal),
				15_000,
				"Dev Tunnel host readiness",
				startAbortController,
			);
			throwIfAborted(startAbortController.signal);
			if (this.#host !== ownedHost || !this.#isCurrent(generation)) {
				if (this.#host === ownedHost) {
					await terminateHost(ownedHost);
					if (this.#host === ownedHost) {
						this.#host = undefined;
					}
				}
				return;
			}
			this.#repository.setPublicUrl(ready.publicUrl);
			this.#state = "online";
			this.#stableTimer = setTimeout(() => {
				if (this.#host === ownedHost && this.#isCurrent(generation)) {
					this.#restartAttempt = 0;
				}
			}, 30_000);
			const activeHost = ownedHost;
			void activeHost.exited.then((exitCode) =>
				this.#handleHostExit(activeHost, exitCode, generation),
			);
		} catch (error) {
			let failure = error;
			if (ownedHost !== undefined && this.#host === ownedHost) {
				try {
					await terminateHost(ownedHost);
					if (this.#host === ownedHost) {
						this.#host = undefined;
					}
				} catch (stopError) {
					failure = stopError;
				}
			}
			if (this.#isCurrent(generation)) {
				if (callerCancelled) {
					this.#repository.setEnabled(false);
					this.#clearRestartTimers(true);
					this.#state = "disabled";
					this.#lastError = undefined;
					return;
				}
				if (failure instanceof DevTunnelAuthenticationRequiredError) {
					this.#setAuthenticated(false);
					this.#state = "auth_required";
					this.#lastError = undefined;
					return;
				}
				this.#recordError(failure);
				this.#scheduleRestart(generation);
			}
		} finally {
			callerSignal?.removeEventListener("abort", cancelFromCaller);
			if (this.#startAbortController === startAbortController) {
				this.#startAbortController = undefined;
			}
		}
	}

	#handleHostExit(host: DevTunnelHostProcess, exitCode: number, generation: number): void {
		if (this.#host !== host) {
			return;
		}
		this.#host = undefined;
		if (!this.#isCurrent(generation) || !this.#repository.get().enabled) {
			return;
		}
		this.#recordError(new Error(`Dev Tunnel host exited with code ${exitCode}.`));
		this.#scheduleRestart(generation);
	}

	#scheduleRestart(generation: number): void {
		if (
			!this.#isCurrent(generation) ||
			!this.#repository.get().enabled ||
			this.#restartTimer !== undefined
		) {
			return;
		}
		const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#restartAttempt, 5));
		this.#restartAttempt += 1;
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			void this.#enqueueMutation(generation, async () => {
				await this.#startHost(generation);
				return this.getStatus();
			});
		}, delay);
	}

	#cancelStart(reason: string): void {
		this.#startAbortController?.abort(new Error(reason));
	}

	#clearRestartTimers(resetAttempt = false): void {
		if (this.#restartTimer !== undefined) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
		if (this.#stableTimer !== undefined) {
			clearTimeout(this.#stableTimer);
			this.#stableTimer = undefined;
		}
		if (resetAttempt) {
			this.#restartAttempt = 0;
		}
	}

	async #stopHost(): Promise<void> {
		this.#clearRestartTimers(true);
		const host = this.#host;
		if (host !== undefined) {
			await terminateHost(host);
			if (this.#host === host) {
				this.#host = undefined;
			}
		}
	}

	#assertRunning(): void {
		if (this.#stopping) {
			throw new Error("Dev Tunnel service is shutting down.");
		}
	}

	#setAuthenticated(authenticated: boolean): void {
		this.#authenticated = authenticated;
		this.#authenticationCheckedAt = this.#now();
	}

	#settleAuthenticationProbe(probe: AuthenticationProbe): void {
		if (this.#authenticationProbe === probe) {
			this.#authenticationProbe = undefined;
		}
	}

	async #waitForSharedMutation(
		operation: SharedMutationOperation,
		signal: AbortSignal | undefined,
		cancelMessage: string,
	): Promise<RemoteAccessStatusOutput> {
		operation.waiters += 1;
		try {
			return await (signal === undefined
				? operation.promise
				: withAbortSignal(operation.promise, signal));
		} finally {
			operation.waiters -= 1;
			if (operation.waiters === 0 && !operation.settled && !operation.controller.signal.aborted) {
				operation.controller.abort(new Error(cancelMessage));
			}
		}
	}

	#recordError(error: unknown): void {
		this.#state = "error";
		this.#lastError = safeMessage(error, "Dev Tunnel operation failed.");
		this.#reportDiagnostic(this.#lastError);
	}

	#isCurrent(generation: number): boolean {
		return !this.#stopping && this.#operationGeneration === generation;
	}

	async #enqueueMutation(
		epoch: number,
		operation: () => Promise<RemoteAccessStatusOutput>,
	): Promise<RemoteAccessStatusOutput> {
		const previous = this.#mutationTail;
		const completion = Promise.withResolvers<void>();
		this.#mutationTail = previous.then(() => completion.promise);
		await previous;
		try {
			if (epoch !== this.#mutationEpoch) {
				return this.getStatus();
			}
			return await operation();
		} finally {
			completion.resolve();
		}
	}
}

export class DevTunnelCliAdapter implements DevTunnelAdapter {
	constructor(
		private readonly executable: string,
		private readonly commandRunner: DevTunnelCommandRunner = runCommand,
	) {}

	async isAuthenticated(signal: AbortSignal): Promise<boolean> {
		const result = await this.commandRunner(
			this.executable,
			["user", "show", "--json"],
			true,
			signal,
		);
		return result.exitCode === 0 && parseDevTunnelLoginStatus(result.stdout);
	}

	startAuthentication(): DevTunnelAuthenticationProcess {
		const child = spawnCommand(this.executable, ["user", "login", "-d"]);
		return createStreamingAuthenticationProcess(child);
	}

	async ensureTunnel(tunnelId: string, port: number, signal: AbortSignal): Promise<string> {
		const tunnelList = await this.commandRunner(this.executable, ["list", "--json"], false, signal);
		let qualifiedTunnelId = findListedTunnelId(tunnelList.stdout, tunnelId);
		if (qualifiedTunnelId === undefined) {
			const tunnelResult = await this.commandRunner(
				this.executable,
				["create", tunnelId.split(".", 1)[0] ?? tunnelId, "--json"],
				false,
				signal,
			);
			qualifiedTunnelId = parseQualifiedTunnelId(tunnelResult.stdout, tunnelId);
		}
		const ports = parseTunnelPorts(
			(
				await this.commandRunner(
					this.executable,
					["port", "list", qualifiedTunnelId, "--json"],
					false,
					signal,
				)
			).stdout,
		);
		for (const existingPort of ports) {
			if (existingPort !== port) {
				await this.commandRunner(
					this.executable,
					["port", "delete", qualifiedTunnelId, "-p", String(existingPort)],
					false,
					signal,
				);
			}
		}
		const targetPort = await this.commandRunner(
			this.executable,
			["port", "show", qualifiedTunnelId, "-p", String(port), "--json"],
			true,
			signal,
		);
		const targetProtocol =
			targetPort.exitCode === 0 ? parseTunnelPortProtocol(targetPort.stdout) : undefined;
		if (targetProtocol !== undefined && targetProtocol !== "http") {
			await this.commandRunner(
				this.executable,
				["port", "delete", qualifiedTunnelId, "-p", String(port)],
				false,
				signal,
			);
		}
		if (targetPort.exitCode !== 0 || targetProtocol !== "http") {
			await this.commandRunner(
				this.executable,
				["port", "create", qualifiedTunnelId, "-p", String(port), "--protocol", "http"],
				false,
				signal,
			);
		}
		await this.commandRunner(
			this.executable,
			["access", "reset", qualifiedTunnelId],
			false,
			signal,
		);
		await this.commandRunner(
			this.executable,
			["access", "reset", qualifiedTunnelId, "--port-number", String(port)],
			false,
			signal,
		);
		await this.commandRunner(
			this.executable,
			["access", "create", qualifiedTunnelId, "--port-number", String(port), "--anonymous"],
			false,
			signal,
		);
		return qualifiedTunnelId;
	}

	async deleteTunnel(tunnelId: string, signal: AbortSignal): Promise<void> {
		await this.commandRunner(this.executable, ["delete", tunnelId, "--force"], false, signal);
	}

	startHost(tunnelId: string, port: number): DevTunnelHostProcess {
		const child = spawnWatchdogCommand(this.executable, ["host", tunnelId]);
		let stopRequested = false;
		void drainStream(child.stderr);
		return {
			ready: monitorHostOutput(child.stdout, port),
			exited: child.exited,
			stop(force = false) {
				if (!stopRequested) {
					stopRequested = true;
					child.kill(force ? "SIGKILL" : "SIGTERM");
				} else if (force) {
					child.kill("SIGKILL");
				}
			},
		};
	}
}

interface CommandChild {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}

function spawnCommand(executable: string, args: readonly string[]): CommandChild {
	return Bun.spawn({
		cmd: [executable, ...args],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function spawnWatchdogCommand(executable: string, args: readonly string[]): CommandChild {
	const sourceEntrypoint = process.argv[1];
	const launcher =
		sourceEntrypoint !== undefined && /\.[cm]?[jt]sx?$/.test(sourceEntrypoint)
			? [process.execPath, sourceEntrypoint]
			: [process.execPath];
	return Bun.spawn({
		cmd: [...launcher, "--dev-tunnel-watchdog", "--", executable, ...args],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function runCommand(
	executable: string,
	args: readonly string[],
	allowFailure = false,
	signal?: AbortSignal,
): Promise<CommandResult> {
	if (signal?.aborted) {
		throw abortSignalError(signal);
	}
	const child = spawnCommand(executable, args);
	const collected = collectChild(child);
	const aborted = Promise.withResolvers<never>();
	const abort = () => {
		child.kill("SIGTERM");
		if (signal !== undefined) {
			aborted.reject(abortSignalError(signal));
		}
	};
	signal?.addEventListener("abort", abort, { once: true });
	let result: CommandResult;
	try {
		result = await withTimeout(
			signal === undefined ? collected : Promise.race([collected, aborted.promise]),
			20_000,
			`${executable} ${args[0] ?? "command"}`,
			() => child.kill("SIGTERM"),
		);
	} catch (error) {
		child.kill("SIGKILL");
		await withTimeout(collected, 2_000, "Dev Tunnel command termination").catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
	if (result.exitCode !== 0 && !allowFailure) {
		if (isDevTunnelAuthenticationFailure(result.message)) {
			throw new DevTunnelAuthenticationRequiredError();
		}
		throw new Error(result.message || `${executable} exited with code ${result.exitCode}.`);
	}
	return result;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	message: string;
}

type DevTunnelCommandRunner = (
	executable: string,
	args: readonly string[],
	allowFailure?: boolean,
	signal?: AbortSignal,
) => Promise<CommandResult>;

async function collectChild(child: CommandChild): Promise<CommandResult> {
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		readBoundedText(child.stdout, 1024 * 1024),
		readBoundedText(child.stderr, 1024 * 1024),
	]);
	return {
		exitCode,
		stdout,
		stderr,
		message: `${stdout}\n${stderr}`.trim().slice(-4_096),
	};
}

function createStreamingAuthenticationProcess(child: CommandChild): DevTunnelAuthenticationProcess {
	const listeners = new Set<(message: string) => void>();
	const output: string[] = [];
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) {
					const remainder = decoder.decode();
					if (remainder) {
						output.push(remainder);
						for (const listener of listeners) listener(remainder);
					}
					return;
				}
				const text = decoder.decode(next.value, { stream: true });
				output.push(text);
				while (output.join("").length > 8_192) output.shift();
				for (const listener of listeners) listener(text);
			}
		} finally {
			reader.releaseLock();
		}
	};
	const completed = Promise.all([child.exited, pump(child.stdout), pump(child.stderr)]).then(
		([exitCode]) => ({
			exitCode,
			message: output.join("").trim().slice(-4_096),
		}),
	);
	return {
		completed,
		onOutput(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop() {
			child.kill("SIGTERM");
		},
	};
}

function monitorHostOutput(
	stream: ReadableStream<Uint8Array>,
	port: number,
): Promise<{ publicUrl: string }> {
	const completion = Promise.withResolvers<{ publicUrl: string }>();
	void (async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		let resolved = false;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) {
					if (!resolved) {
						completion.reject(
							new Error("Dev Tunnel host exited before publishing its public URL."),
						);
					}
					return;
				}
				buffered = `${buffered}${decoder.decode(next.value, { stream: true })}`.slice(-16_384);
				if (!resolved) {
					const urls = buffered.match(/https:\/\/[A-Za-z0-9.-]+\.devtunnels\.ms(?::\d+)?\/?/g);
					const preferred = urls?.find((url) => url.includes(`-${port}.`)) ?? urls?.[0];
					if (preferred !== undefined) {
						resolved = true;
						completion.resolve({ publicUrl: preferred.replace(/\/$/, "") });
					}
				}
			}
		} catch (error) {
			if (!resolved) {
				completion.reject(error);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return completion.promise;
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (!(await reader.read()).done) {
			// Drain host diagnostics to prevent pipe backpressure.
		}
	} finally {
		reader.releaseLock();
	}
}

async function readBoundedText(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let total = 0;
	let text = "";
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				return `${text}${decoder.decode()}`;
			}
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("Dev Tunnel command output exceeded its byte limit.");
				throw new Error("Dev Tunnel command output exceeded its byte limit.");
			}
			text += decoder.decode(next.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

async function terminateHost(host: DevTunnelHostProcess): Promise<void> {
	host.stop();
	try {
		await withTimeout(host.exited, 2_000, "Dev Tunnel host shutdown", () => host.stop(true));
	} catch {
		await withTimeout(host.exited, 2_000, "Dev Tunnel host forced shutdown");
	}
}

function currentUtcMonth(nowMs = Date.now()): string {
	return new Date(nowMs).toISOString().slice(0, 7);
}

function trafficWarningLevel(totalBytes: number): "none" | "50" | "80" | "100" {
	const ratio = totalBytes / devTunnelMonthlyLimitBytes;
	if (ratio >= 1) {
		return "100";
	}
	if (ratio >= 0.8) {
		return "80";
	}
	if (ratio >= 0.5) {
		return "50";
	}
	return "none";
}

function safeMessage(error: unknown, fallback: string): string {
	return (error instanceof Error ? error.message : fallback).trim().slice(0, 1_024) || fallback;
}

function abortSignalError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Dev Tunnel command was cancelled.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortSignalError(signal);
	}
}

function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortSignalError(signal));
	}
	const aborted = Promise.withResolvers<never>();
	const abort = () => aborted.reject(abortSignalError(signal));
	signal.addEventListener("abort", abort, { once: true });
	return Promise.race([operation, aborted.promise]).finally(() =>
		signal.removeEventListener("abort", abort),
	);
}

async function withCallerAbortTimeout<T>(
	start: (signal: AbortSignal) => Promise<T>,
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const controller = new AbortController();
	const abortFromCaller = () => {
		if (callerSignal !== undefined) {
			controller.abort(abortSignalError(callerSignal));
		}
	};
	if (callerSignal?.aborted) {
		abortFromCaller();
	} else {
		callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	}
	try {
		return await withAbortTimeout(start(controller.signal), timeoutMs, label, controller);
	} finally {
		callerSignal?.removeEventListener("abort", abortFromCaller);
	}
}

export function parseDevTunnelLoginStatus(message: string): boolean {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		return false;
	}
	const statuses: string[] = [];
	collectNamedStrings(value, "status", statuses);
	return statuses.some((status) =>
		["loggedin", "authenticated", "connected"].includes(
			status.replace(/[^a-z]/gi, "").toLowerCase(),
		),
	);
}

export function findListedTunnelId(message: string, requestedTunnelId: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch (error) {
		throw new Error("Dev Tunnel inventory JSON is invalid.", { cause: error });
	}
	const requested = splitTunnelId(requestedTunnelId);
	const tunnels: Array<{ tunnelId: string; clusterId?: string }> = [];
	collectTunnelEntries(value, tunnels);
	for (const tunnel of tunnels) {
		const listed = splitTunnelId(tunnel.tunnelId, tunnel.clusterId);
		if (listed.tunnelId.toLowerCase() !== requested.tunnelId.toLowerCase()) {
			continue;
		}
		if (
			requested.clusterId !== undefined &&
			listed.clusterId !== undefined &&
			listed.clusterId.toLowerCase() !== requested.clusterId.toLowerCase()
		) {
			continue;
		}
		if (listed.clusterId !== undefined) {
			return `${listed.tunnelId}.${listed.clusterId}`;
		}
		return requestedTunnelId;
	}
	return undefined;
}

export function parseQualifiedTunnelId(message: string, fallback: string): string {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch (error) {
		throw new Error("Dev Tunnel metadata JSON is invalid.", { cause: error });
	}
	const tunnelIds: string[] = [];
	const clusterIds: string[] = [];
	collectNamedStrings(value, "tunnelid", tunnelIds);
	collectNamedStrings(value, "clusterid", clusterIds);
	const tunnelId = tunnelIds[0];
	const clusterId = clusterIds[0];
	if (tunnelId?.includes(".")) {
		return tunnelId;
	}
	if (tunnelId && clusterId) {
		return `${tunnelId}.${clusterId}`;
	}
	if (fallback.includes(".")) {
		return fallback;
	}
	throw new Error("Dev Tunnel metadata omitted its tunnel or cluster ID.");
}

function splitTunnelId(
	tunnelId: string,
	fallbackClusterId?: string,
): { tunnelId: string; clusterId?: string } {
	const separator = tunnelId.indexOf(".");
	if (separator === -1) {
		return {
			tunnelId,
			...(fallbackClusterId === undefined ? {} : { clusterId: fallbackClusterId }),
		};
	}
	return {
		tunnelId: tunnelId.slice(0, separator),
		clusterId: tunnelId.slice(separator + 1),
	};
}

export function parseTunnelPorts(message: string): number[] {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch (error) {
		throw new Error("Dev Tunnel port inventory JSON is invalid.", { cause: error });
	}

	const ports: number[] = [];
	collectNamedNumbers(value, "portnumber", ports);
	return [...new Set(ports)];
}

export function parseTunnelPortProtocol(message: string): string {
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch (error) {
		throw new Error("Dev Tunnel port metadata JSON is invalid.", { cause: error });
	}
	const protocols: string[] = [];
	collectNamedStrings(value, "protocol", protocols);
	const protocol = protocols[0]?.toLowerCase();
	if (!protocol) {
		throw new Error("Dev Tunnel port metadata omitted its protocol.");
	}
	return protocol;
}

function collectTunnelEntries(
	value: unknown,
	output: Array<{ tunnelId: string; clusterId?: string }>,
): void {
	if (Array.isArray(value)) {
		for (const item of value) collectTunnelEntries(item, output);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const entries = Object.entries(value);
	const tunnelId = entries.find(
		([key, item]) => key.toLowerCase() === "tunnelid" && typeof item === "string",
	)?.[1];
	const clusterId = entries.find(
		([key, item]) => key.toLowerCase() === "clusterid" && typeof item === "string",
	)?.[1];
	if (typeof tunnelId === "string") {
		output.push({
			tunnelId,
			...(typeof clusterId === "string" ? { clusterId } : {}),
		});
	}
	for (const [, item] of entries) collectTunnelEntries(item, output);
}

function collectNamedStrings(value: unknown, name: string, output: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectNamedStrings(item, name, output);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (key.toLowerCase() === name && typeof item === "string") output.push(item);
		collectNamedStrings(item, name, output);
	}
}

function collectNamedNumbers(value: unknown, name: string, output: number[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectNamedNumbers(item, name, output);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (key.toLowerCase() === name && Number.isSafeInteger(item)) output.push(item as number);
		collectNamedNumbers(item, name, output);
	}
}

function isDevTunnelAuthenticationFailure(message: string): boolean {
	return /not logged in|authentication required|unauthorized|token.*expired|login required/i.test(
		message,
	);
}

function withTimeout<T>(
	operation: PromiseLike<T>,
	timeoutMs: number,
	label: string,
	onTimeout?: () => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout?.();
			reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
		Promise.resolve(operation).then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function withAbortTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	label: string,
	controller: AbortController,
): Promise<T> {
	let timedOut = false;
	try {
		return await withTimeout(operation, timeoutMs, label, () => {
			timedOut = true;
			controller.abort(new Error(`${label} timed out after ${timeoutMs}ms.`));
		});
	} catch (error) {
		if (timedOut) {
			await operation.catch(() => undefined);
		}
		throw error;
	}
}
