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
	/**
	 * Resolves with the public URL for a single expected ingress `port` once the host publishes it.
	 * A host forwards every expected port from one process, so the service awaits `waitForPort` for
	 * each ingress and only comes online after they all resolve.
	 */
	waitForPort(port: number): Promise<{ publicUrl: string }>;
	readonly exited: Promise<number>;
	stop(force?: boolean): void;
}

export interface DevTunnelAuthenticationProcess {
	readonly completed: Promise<{ exitCode: number; message: string }>;
	onOutput(listener: (message: string) => void): () => void;
	stop(): void;
}

/**
 * A single Moshu-owned tunnel ingress. Today only the Runtime ingress exists; a future Mobile
 * ingress (Layer 3) adds a second descriptor with its own port. Modelling the ingresses as a set of
 * typed descriptors — rather than a single scalar port — is what lets the tunnel reconcile against
 * an expected port set instead of destroying every other forwarded port.
 */
export type DevTunnelIngressKind = "runtime" | "mobile";

export interface DevTunnelIngress {
	readonly kind: DevTunnelIngressKind;
	readonly port: number;
}

/**
 * Live per-ingress readiness for the currently online host. This is an INTERNAL descriptor: Layer 1
 * does not expose the ingress set over the wire (see remoteAccessStatusOutputSchema, which stays at
 * v1). It lets callers inside the server observe per-port readiness/URL — a future Mobile ingress
 * (Layer 3) will surface this through an explicit versioned status method. `publicUrl` is present
 * only while the port is live and has published a URL; it is never a stale/persisted value.
 */
export interface DevTunnelIngressStatus {
	readonly kind: DevTunnelIngressKind;
	readonly port: number;
	readonly ready: boolean;
	readonly publicUrl?: string;
}

export interface DevTunnelAdapter {
	isAuthenticated(signal: AbortSignal): Promise<boolean>;
	startAuthentication(): DevTunnelAuthenticationProcess;
	/**
	 * Reconciles the tunnel so that exactly the expected `ports` are forwarded with anonymous HTTP
	 * access. Ports already present that are not in the expected set are removed; expected ports that
	 * are missing or misconfigured are repaired. Ports belonging to other Moshu ingresses in the same
	 * expected set are preserved — they must never be cross-deleted.
	 */
	ensureTunnel(tunnelId: string, ports: readonly number[], signal: AbortSignal): Promise<string>;
	deleteTunnel(tunnelId: string, signal: AbortSignal): Promise<void>;
	/**
	 * Starts a single host process that forwards every expected ingress `port`. The returned process
	 * exposes per-port readiness via {@link DevTunnelHostProcess.waitForPort}.
	 */
	startHost(tunnelId: string, ports: readonly number[]): DevTunnelHostProcess;
}

export interface DevTunnelServiceOptions {
	repository: RemoteAccessRepository;
	runtimeIngressPort: number;
	/**
	 * Forward-looking second ingress port (a future Mobile ingress, Layer 3). When set, the tunnel
	 * forwards and waits for this port in addition to the Runtime port. No Mobile listener/pairing is
	 * created here; it only exercises the multi-ingress reconcile/readiness path.
	 */
	mobileIngressPort?: number;
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
	readonly #ingresses: readonly DevTunnelIngress[];
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
	// Live per-port readiness/URL for the currently online host, keyed by ingress port. Populated as the
	// host publishes each expected ingress URL and cleared whenever the owning host stops, exits, or its
	// startup fails/cancels/is superseded — always guarded by host identity so a replacement host's
	// readiness is never wiped.
	#ingressReadiness = new Map<number, { publicUrl: string }>();
	// Hosts we have asked to stop but whose process exit is not yet confirmed — e.g. terminateHost()
	// threw synchronously or its forced-shutdown timeout rejected. Tracked separately from #host so a
	// rejected/timed-out termination never drops the only handle to a possibly-still-live public host:
	// disable/shutdown re-terminate every tracked orphan until its `exited` resolves. Kept disjoint from
	// the live #host, so a replacement host's ownership and readiness are never affected by an orphan's
	// lingering cleanup, and a failed termination never blocks a replacement's start guard.
	readonly #terminatingHosts = new Set<DevTunnelHostProcess>();

	constructor(options: DevTunnelServiceOptions) {
		this.#repository = options.repository;
		this.#runtimeIngressPort = options.runtimeIngressPort;
		this.#ingresses = [
			{ kind: "runtime", port: options.runtimeIngressPort },
			...(options.mobileIngressPort === undefined
				? []
				: [{ kind: "mobile" as const, port: options.mobileIngressPort }]),
		];
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

	/**
	 * Internal (non-wire) per-ingress readiness snapshot. Each expected ingress reports whether it is
	 * currently live and, if so, its published public URL. Pending ports report `ready: false` with no
	 * `publicUrl` — never a stale/persisted URL. Overall Remote Access only reaches "online" once every
	 * required ingress is ready (see getStatus().state), but this getter reflects incremental per-port
	 * progress while some ports are still pending.
	 */
	getIngressReadiness(): readonly DevTunnelIngressStatus[] {
		return this.#ingresses.map((ingress) => {
			const readiness = this.#ingressReadiness.get(ingress.port);
			return {
				kind: ingress.kind,
				port: ingress.port,
				ready: readiness !== undefined,
				...(readiness?.publicUrl === undefined ? {} : { publicUrl: readiness.publicUrl }),
			};
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
		this.#ingressReadiness = new Map();
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
				this.#adapter.ensureTunnel(
					tunnelId,
					this.#ingresses.map((ingress) => ingress.port),
					startAbortController.signal,
				),
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
			ownedHost = this.#adapter.startHost(
				qualifiedTunnelId,
				this.#ingresses.map((ingress) => ingress.port),
			);
			this.#host = ownedHost;
			const host = ownedHost;
			const ingresses = this.#ingresses;
			// Every required ingress must publish its public URL before Remote Access is online. A single
			// laggard or never-ready port keeps the whole service out of the "online" state.
			const portPromises = ingresses.map((ingress) => host.waitForPort(ingress.port));
			// Publish each ingress URL incrementally the moment its port resolves, so getIngressReadiness
			// reflects partial progress (one ready, one still pending) rather than flipping every port at
			// once. Guarded by host identity + generation so a superseded start never mutates live state.
			// This runs off separate promise chains and does not feed the awaited path below, preserving
			// the readiness/cancellation microtask ordering.
			ingresses.forEach((ingress, index) => {
				void portPromises[index]?.then(
					(result) => {
						if (this.#host === ownedHost && this.#isCurrent(generation)) {
							this.#ingressReadiness.set(ingress.port, { publicUrl: result.publicUrl });
						}
					},
					() => undefined,
				);
			});
			const ingressUrls = await withAbortTimeout(
				withAbortSignal(Promise.all(portPromises), startAbortController.signal),
				15_000,
				"Dev Tunnel host readiness",
				startAbortController,
			);
			throwIfAborted(startAbortController.signal);
			if (this.#host !== ownedHost || !this.#isCurrent(generation)) {
				if (this.#host === ownedHost) {
					// Clear readiness and release the live handle SYNCHRONOUSLY, before awaiting terminate:
					// a rejected or timed-out stop must not leave a dead ingress reporting ready, nor block a
					// replacement's start guard. The handle is retained in #terminatingHosts so a later
					// disable/shutdown can re-terminate this exact orphan if its stop rejects. Guarded by host
					// identity (this.#host === ownedHost) so a replacement host — which resets readiness on
					// its own start — is never wiped.
					this.#host = undefined;
					this.#ingressReadiness = new Map();
					await this.#terminateTrackedHost(ownedHost);
				}
				return;
			}
			const readiness = ingresses.map((ingress, index) => ({
				ingress,
				publicUrl: ingressUrls[index]?.publicUrl,
			}));
			const runtimeReadiness = readiness.find((entry) => entry.ingress.kind === "runtime");
			if (runtimeReadiness?.publicUrl === undefined) {
				throw new Error("Dev Tunnel runtime ingress did not report a public URL.");
			}
			this.#ingressReadiness = new Map(
				readiness.flatMap((entry) =>
					entry.publicUrl === undefined
						? []
						: [[entry.ingress.port, { publicUrl: entry.publicUrl }] as const],
				),
			);
			// Persist the Runtime public URL for backward compatibility (top-level status.publicUrl and
			// the persisted Remote Runtime Box URL). Additional ingress URLs are surfaced per-port via
			// the internal getIngressReadiness() getter, not over the v1 status wire contract.
			this.#repository.setPublicUrl(runtimeReadiness.publicUrl);
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
				// Clear readiness and release the live handle SYNCHRONOUSLY, before awaiting terminate: a
				// partial-startup failure or cancellation whose stop then rejects/times out must not leave an
				// already-resolved ingress reporting ready, nor block a replacement's start guard. The handle
				// is retained in #terminatingHosts so a later disable/shutdown can re-terminate this exact
				// orphan. Guarded by host identity so a replacement's freshly-reset readiness is untouched.
				this.#host = undefined;
				this.#ingressReadiness = new Map();
				try {
					await this.#terminateTrackedHost(ownedHost);
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
		this.#ingressReadiness = new Map();
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
		this.#ingressReadiness = new Map();
		const current = this.#host;
		// Release the live handle up front so a rejected termination never blocks a replacement's start
		// guard; the handle is retained in #terminatingHosts (via #terminateTrackedHost) until its exit
		// is confirmed.
		this.#host = undefined;
		const targets = new Set<DevTunnelHostProcess>(this.#terminatingHosts);
		if (current !== undefined) {
			targets.add(current);
		}
		if (targets.size === 0) {
			return;
		}
		// Re-terminate the live host plus any orphan whose earlier termination rejected or timed out, so a
		// failed stop never strands a still-live public host beyond the reach of disable/shutdown.
		const outcomes = await Promise.allSettled(
			[...targets].map((host) => this.#terminateTrackedHost(host)),
		);
		const rejected = outcomes.find(
			(outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
		);
		if (rejected !== undefined) {
			throw rejected.reason;
		}
	}

	/**
	 * Terminates a host and tracks it in #terminatingHosts until its process exit is confirmed.
	 *
	 * The host is added to the orphan set before the (potentially rejecting) terminate is awaited and is
	 * removed the moment its `exited` promise settles — however terminateHost() itself settles. So if the
	 * stop throws or its forced-shutdown times out, the exact handle stays tracked and a later
	 * disable/shutdown can drive it to a real exit, rather than the only reference being dropped while the
	 * public host is still live. Callers must have already released ownership (cleared #host/readiness
	 * under a host-identity guard) so this never touches a replacement host.
	 */
	async #terminateTrackedHost(host: DevTunnelHostProcess): Promise<void> {
		this.#terminatingHosts.add(host);
		void host.exited.then(
			() => {
				this.#terminatingHosts.delete(host);
			},
			() => {
				this.#terminatingHosts.delete(host);
			},
		);
		await terminateHost(host);
		// terminateHost only resolves after `exited` resolves, so the process is confirmed gone.
		this.#terminatingHosts.delete(host);
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

	async ensureTunnel(
		tunnelId: string,
		ports: readonly number[],
		signal: AbortSignal,
	): Promise<string> {
		const expectedPorts = [...new Set(ports)];
		if (expectedPorts.length === 0) {
			throw new Error("Dev Tunnel setup requires at least one expected ingress port.");
		}
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
		const expected = new Set(expectedPorts);
		const existingPorts = parseTunnelPorts(
			(
				await this.commandRunner(
					this.executable,
					["port", "list", qualifiedTunnelId, "--json"],
					false,
					signal,
				)
			).stdout,
		);
		// Reconcile against the expected set: drop only ports that no Moshu ingress claims. Ports for a
		// second Moshu ingress (e.g. a future Mobile listener) stay in `expected` and are never deleted.
		for (const existingPort of existingPorts) {
			if (!expected.has(existingPort)) {
				await this.commandRunner(
					this.executable,
					["port", "delete", qualifiedTunnelId, "-p", String(existingPort)],
					false,
					signal,
				);
			}
		}
		for (const expectedPort of expectedPorts) {
			const targetPort = await this.commandRunner(
				this.executable,
				["port", "show", qualifiedTunnelId, "-p", String(expectedPort), "--json"],
				true,
				signal,
			);
			const targetProtocol =
				targetPort.exitCode === 0 ? parseTunnelPortProtocol(targetPort.stdout) : undefined;
			if (targetProtocol !== undefined && targetProtocol !== "http") {
				await this.commandRunner(
					this.executable,
					["port", "delete", qualifiedTunnelId, "-p", String(expectedPort)],
					false,
					signal,
				);
			}
			if (targetPort.exitCode !== 0 || targetProtocol !== "http") {
				await this.commandRunner(
					this.executable,
					["port", "create", qualifiedTunnelId, "-p", String(expectedPort), "--protocol", "http"],
					false,
					signal,
				);
			}
		}
		await this.commandRunner(
			this.executable,
			["access", "reset", qualifiedTunnelId],
			false,
			signal,
		);
		for (const expectedPort of expectedPorts) {
			await this.commandRunner(
				this.executable,
				["access", "reset", qualifiedTunnelId, "--port-number", String(expectedPort)],
				false,
				signal,
			);
			await this.commandRunner(
				this.executable,
				[
					"access",
					"create",
					qualifiedTunnelId,
					"--port-number",
					String(expectedPort),
					"--anonymous",
				],
				false,
				signal,
			);
		}
		return qualifiedTunnelId;
	}

	async deleteTunnel(tunnelId: string, signal: AbortSignal): Promise<void> {
		await this.commandRunner(this.executable, ["delete", tunnelId, "--force"], false, signal);
	}

	startHost(tunnelId: string, ports: readonly number[]): DevTunnelHostProcess {
		const child = spawnWatchdogCommand(this.executable, ["host", tunnelId]);
		let stopRequested = false;
		void drainStream(child.stderr);
		const monitor = monitorHostPorts(child.stdout, ports);
		return {
			waitForPort: (port) => monitor.waitForPort(port),
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

/**
 * Watches a single host stdout stream that forwards one or more expected ingress ports and resolves a
 * per-port public URL. A devtunnel URL embeds its forwarded port as a `-${port}.` segment, so each
 * expected port is matched to its own URL; when exactly one port is expected we fall back to the first
 * URL seen (older CLI output does not always tag single-port hosts). Pending ports are rejected if the
 * stream ends or errors before their URL is published.
 */
export function monitorHostPorts(
	stream: ReadableStream<Uint8Array>,
	ports: readonly number[],
): { waitForPort(port: number): Promise<{ publicUrl: string }> } {
	const resolvers = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<{ publicUrl: string }>>
	>();
	for (const port of ports) {
		resolvers.set(port, Promise.withResolvers<{ publicUrl: string }>());
	}
	const singlePort = ports.length === 1 ? ports[0] : undefined;
	void (async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		const pending = new Set(ports);
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) {
					if (pending.size > 0) {
						const error = new Error("Dev Tunnel host exited before publishing its public URL.");
						for (const port of pending) {
							resolvers.get(port)?.reject(error);
						}
					}
					return;
				}
				buffered = `${buffered}${decoder.decode(next.value, { stream: true })}`.slice(-16_384);
				if (pending.size === 0) {
					continue;
				}
				const urls = buffered.match(/https:\/\/[A-Za-z0-9.-]+\.devtunnels\.ms(?::\d+)?\/?/g);
				if (urls === null) {
					continue;
				}
				for (const port of [...pending]) {
					let match = urls.find((url) => url.includes(`-${port}.`));
					if (match === undefined && singlePort === port) {
						match = urls[0];
					}
					if (match !== undefined) {
						pending.delete(port);
						resolvers.get(port)?.resolve({ publicUrl: match.replace(/\/$/, "") });
					}
				}
			}
		} catch (error) {
			for (const port of pending) {
				resolvers.get(port)?.reject(error);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		waitForPort(port) {
			const entry = resolvers.get(port);
			if (entry === undefined) {
				return Promise.reject(new Error(`Dev Tunnel host is not forwarding port ${port}.`));
			}
			return entry.promise;
		},
	};
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
