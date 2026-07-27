import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
	AgentsServerBootstrapRecord,
	AgentsServerDataPaths,
	ExecutorBootstrapRecord,
	ProcessPeerIdentity,
	RpcCredentialBinding,
} from "@moshu/contracts";

import {
	type AgentsServerReadyRecord,
	type CompanionReadyRecord,
	type CompanionRole,
	type ExecutorReadyRecord,
	readCompanionReadyRecord,
	serializeAgentsServerBootstrap,
	serializeExecutorBootstrap,
} from "./companion-control";

export type { CompanionRole } from "./companion-control";

export type CompanionSignal = "SIGTERM" | "SIGKILL";

export interface CompanionProcessSpawnRequest {
	role: CompanionRole;
	executablePath: string;
	environment: Readonly<Record<string, string>>;
}

export interface SpawnedCompanionProcess {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	writeStdin(bytes: Uint8Array): Promise<void>;
	closeStdin(): Promise<void>;
	kill(signal: CompanionSignal): void;
}

export type CompanionProcessSpawner = (
	request: CompanionProcessSpawnRequest,
) => SpawnedCompanionProcess;

export interface CompanionProcessIdentity {
	role: CompanionRole;
	pid: number;
	generation: number;
	startedAtMs: number;
}

export type CompanionReadySnapshot =
	| Omit<AgentsServerReadyRecord, "nonce">
	| (Omit<ExecutorReadyRecord, "nonce" | "agentsServer"> & {
			agentsServer: Omit<ExecutorReadyRecord["agentsServer"], "nonce">;
	  });

export interface CompanionProcessSnapshot {
	identity: CompanionProcessIdentity;
	ready: CompanionReadySnapshot;
}

export interface CompanionSupervisorSnapshot {
	status:
		| "idle"
		| "starting"
		| "connecting-client"
		| "waiting-executor"
		| "running"
		| "restarting"
		| "stopping"
		| "stopped"
		| "failed";
	restartAttempts: number;
	processes: Partial<Record<CompanionRole, CompanionProcessSnapshot>>;
}

export interface RestartPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface RestartPermit {
	attempt: number;
	delayMs: number;
}

export interface CompanionCrashEvent {
	role: CompanionRole;
	pid: number;
	generation: number;
	exitCode: number;
}

export type CompanionRestartCause = CompanionCrashEvent | { message: string };

export interface CompanionRestartScheduledEvent {
	attempt: number;
	delayMs: number;
	cause: CompanionRestartCause;
}

export interface CompanionSupervisorHooks {
	onCrash?(event: CompanionCrashEvent): void | PromiseLike<void>;
	onRestartScheduled?(event: CompanionRestartScheduledEvent): void;
	onRestarted?(snapshot: CompanionSupervisorSnapshot): void;
	onRestartBudgetExhausted?(event: { attempts: number; cause: CompanionRestartCause }): void;
	onStderr?(event: { role: CompanionRole; pid: number; generation: number; text: string }): void;
	onFatalError?(error: Error): void;
}

interface TimerDependencies {
	setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export interface CompanionSupervisorDependencies extends TimerDependencies {
	spawnProcess: CompanionProcessSpawner;
	now(): number;
	createNonce(): string;
	createInstanceId(): string;
	createCredential(): string;
	sleep(delayMs: number): Promise<void>;
}

export interface DesktopAgentsConnection {
	closed: Promise<void>;
	isClosed(): boolean;
	close(): void | Promise<void>;
}

export interface DesktopAgentsConnectOptions {
	agentsServer: AgentsServerReadyRecord;
	identity: ProcessPeerIdentity;
	credential: string;
}

export interface CompanionProcessSupervisorOptions {
	executables: Record<CompanionRole, string>;
	dataPaths?: AgentsServerDataPaths;
	connectClient?: (options: DesktopAgentsConnectOptions) => Promise<DesktopAgentsConnection>;
	additionalPeerBindings?: readonly RpcCredentialBinding[];
	environment?: Readonly<Record<string, string>>;
	startupTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	restartPolicy?: RestartPolicy;
	hooks?: CompanionSupervisorHooks;
	dependencies?: Partial<CompanionSupervisorDependencies>;
}

interface ManagedCompanionProcess {
	identity: CompanionProcessIdentity & { nonce: string };
	child: SpawnedCompanionProcess;
	ready?: CompanionReadyRecord;
	exitCode?: number;
	expectedExit: boolean;
	watching: boolean;
	stopPromise?: Promise<void>;
}

const DEFAULT_RESTART_POLICY: RestartPolicy = {
	maxAttempts: 3,
	baseDelayMs: 250,
	maxDelayMs: 5_000,
};

export class RestartBudget {
	readonly policy: RestartPolicy;
	private attempts = 0;

	constructor(policy: RestartPolicy) {
		assertRestartPolicy(policy);
		this.policy = policy;
	}

	get attemptsUsed(): number {
		return this.attempts;
	}

	take(): RestartPermit | undefined {
		if (this.attempts >= this.policy.maxAttempts) {
			return undefined;
		}
		this.attempts += 1;
		return {
			attempt: this.attempts,
			delayMs: calculateRestartDelayMs(this.attempts, this.policy),
		};
	}
}

export function calculateRestartDelayMs(attempt: number, policy: RestartPolicy): number {
	assertRestartPolicy(policy);
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new Error("Restart attempt must be a positive integer.");
	}
	return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

export function createMinimalCompanionEnvironment(
	source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of ["HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
		const value = source[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	return environment;
}

export function spawnBunCompanionProcess(
	request: CompanionProcessSpawnRequest,
): SpawnedCompanionProcess {
	if (!isAbsolute(request.executablePath)) {
		throw new Error(`${request.role} executable path must be absolute.`);
	}

	const child = Bun.spawn({
		cmd: [request.executablePath],
		cwd: dirname(request.executablePath),
		env: { ...request.environment },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	return {
		pid: child.pid,
		stdout: child.stdout,
		stderr: child.stderr,
		exited: child.exited,
		async writeStdin(bytes) {
			child.stdin.write(bytes);
			await child.stdin.flush();
		},
		async closeStdin() {
			child.stdin.end();
		},
		kill(signal) {
			child.kill(signal);
		},
	};
}

export class CompanionProcessSupervisor {
	private readonly executables: Record<CompanionRole, string>;
	private readonly environment: Readonly<Record<string, string>>;
	private readonly startupTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;
	private readonly hooks: CompanionSupervisorHooks;
	private readonly dependencies: CompanionSupervisorDependencies;
	private readonly dataPaths: AgentsServerDataPaths;
	private readonly connectClient: NonNullable<CompanionProcessSupervisorOptions["connectClient"]>;
	private readonly additionalPeerBindings: readonly RpcCredentialBinding[];
	private readonly restartBudget: RestartBudget;
	private readonly generations: Record<CompanionRole | "client", number> = {
		"agents-server": 0,
		executor: 0,
		client: 0,
	};
	private readonly processes: Partial<Record<CompanionRole, ManagedCompanionProcess>> = {};
	private readonly shutdownSignal = createDeferredSignal();
	private status: CompanionSupervisorSnapshot["status"] = "idle";
	private lifecycleEpoch = 0;
	private shutdownRequested = false;
	private startPromise: Promise<CompanionSupervisorSnapshot> | undefined;
	private restartPromise: Promise<void> | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private queuedRestartCause: CompanionRestartCause | undefined;
	private clientConnection: DesktopAgentsConnection | undefined;
	private clientIdentity: ProcessPeerIdentity | undefined;

	constructor(options: CompanionProcessSupervisorOptions) {
		assertAbsoluteExecutablePath("agents-server", options.executables["agents-server"]);
		assertAbsoluteExecutablePath("executor", options.executables.executor);
		this.executables = options.executables;
		this.dataPaths = options.dataPaths ?? createDefaultDataPaths();
		this.connectClient = options.connectClient ?? createNoopDesktopConnection;
		this.additionalPeerBindings = options.additionalPeerBindings ?? [];
		this.environment = options.environment ?? createMinimalCompanionEnvironment();
		this.startupTimeoutMs = assertPositiveTimeout(
			options.startupTimeoutMs ?? 10_000,
			"Startup timeout",
		);
		this.shutdownTimeoutMs = assertPositiveTimeout(
			options.shutdownTimeoutMs ?? 3_000,
			"Shutdown timeout",
		);
		this.hooks = options.hooks ?? {};
		this.restartBudget = new RestartBudget(options.restartPolicy ?? DEFAULT_RESTART_POLICY);
		this.dependencies = {
			spawnProcess: options.dependencies?.spawnProcess ?? spawnBunCompanionProcess,
			now: options.dependencies?.now ?? Date.now,
			createNonce: options.dependencies?.createNonce ?? randomUUID,
			createInstanceId: options.dependencies?.createInstanceId ?? randomUUID,
			createCredential:
				options.dependencies?.createCredential ?? (() => randomBytes(32).toString("base64url")),
			sleep:
				options.dependencies?.sleep ??
				((delayMs) =>
					new Promise((resolve) => {
						setTimeout(resolve, delayMs);
					})),
			setTimer:
				options.dependencies?.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
			clearTimer: options.dependencies?.clearTimer ?? ((handle) => clearTimeout(handle)),
		};
	}

	getSnapshot(): CompanionSupervisorSnapshot {
		const processSnapshots: Partial<Record<CompanionRole, CompanionProcessSnapshot>> = {};
		for (const role of ["agents-server", "executor"] as const) {
			const process = this.processes[role];
			if (process?.ready !== undefined) {
				processSnapshots[role] = {
					identity: {
						role: process.identity.role,
						pid: process.identity.pid,
						generation: process.identity.generation,
						startedAtMs: process.identity.startedAtMs,
					},
					ready: createReadySnapshot(process.ready),
				};
			}
		}

		return {
			status: this.status,
			restartAttempts: this.restartBudget.attemptsUsed,
			processes: processSnapshots,
		};
	}

	start(): Promise<CompanionSupervisorSnapshot> {
		if (this.status !== "idle") {
			throw new Error(`Cannot start companion processes while status is ${this.status}.`);
		}

		this.status = "starting";
		const lifecycleEpoch = this.lifecycleEpoch;
		const startPromise = this.performStart(lifecycleEpoch);
		this.startPromise = startPromise;
		void startPromise.then(
			() => {
				if (this.startPromise === startPromise) {
					this.startPromise = undefined;
				}
			},
			() => {
				if (this.startPromise === startPromise) {
					this.startPromise = undefined;
				}
			},
		);
		return startPromise;
	}

	private async performStart(lifecycleEpoch: number): Promise<CompanionSupervisorSnapshot> {
		try {
			await this.startPair(lifecycleEpoch);
			this.assertLifecycleActive(lifecycleEpoch);
			this.status = "running";
			if (this.clientConnection?.isClosed()) {
				throw new Error("Desktop agents connection closed while entering runtime readiness.");
			}
			this.activateCrashDetection();
			await this.waitForStableStartup(lifecycleEpoch);
			return this.getSnapshot();
		} catch (error) {
			if (!this.shutdownRequested && this.status !== "failed") {
				await this.startRestartOwner(
					{ message: toError(error, "Companion startup failed.").message },
					lifecycleEpoch,
				);
				if (this.status === "running") {
					return this.getSnapshot();
				}
				this.status = "failed";
			}
			throw error;
		}
	}

	private async waitForStableStartup(lifecycleEpoch: number): Promise<void> {
		while (this.isLifecycleActive(lifecycleEpoch)) {
			await Promise.resolve();
			const owner = this.restartPromise;
			if (owner !== undefined) {
				await owner;
				continue;
			}
			if (this.status === "failed") {
				throw new Error("Companion startup recovery was exhausted.");
			}
			if (this.clientConnection?.isClosed() || !this.hasRunningPair()) {
				await this.startRestartOwner(
					{ message: "Companion pair became unavailable during startup." },
					lifecycleEpoch,
				);
				continue;
			}
			return;
		}
		this.assertLifecycleActive(lifecycleEpoch);
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise !== undefined) {
			return this.shutdownPromise;
		}
		if (this.status === "stopped") {
			return Promise.resolve();
		}

		this.shutdownRequested = true;
		this.lifecycleEpoch += 1;
		this.shutdownSignal.resolve();
		this.queuedRestartCause = undefined;
		this.status = "stopping";
		const operations: Promise<unknown>[] = [];
		if (this.startPromise !== undefined) {
			operations.push(this.startPromise);
		}
		if (this.restartPromise !== undefined) {
			operations.push(this.restartPromise);
		}
		this.shutdownPromise = (async () => {
			try {
				await this.stopPair();
				await Promise.allSettled(operations);
				await this.stopPair();
				this.status = "stopped";
			} catch (error) {
				this.status = "failed";
				throw error;
			}
		})();
		return this.shutdownPromise;
	}

	private async startPair(lifecycleEpoch: number): Promise<void> {
		this.assertLifecycleActive(lifecycleEpoch);
		for (const role of ["executor", "agents-server"] as const) {
			if (this.processes[role] !== undefined) {
				throw new TerminationUnconfirmedError(
					`Cannot start ${role} while its previous process is still tracked.`,
				);
			}
		}
		const serverIdentity = this.createPeerIdentity("agents-server");
		const clientIdentity = this.createPeerIdentity("client");
		const executorIdentity = this.createPeerIdentity("executor");
		const clientCredential = this.dependencies.createCredential();
		const executorCredential = this.dependencies.createCredential();
		const agentsBootstrap: AgentsServerBootstrapRecord = {
			channel: "moshu-companion-bootstrap",
			controlVersion: 2,
			type: "START",
			role: "agents-server",
			nonce: this.dependencies.createNonce(),
			serverIdentity,
			peerBindings: [
				{ credential: clientCredential, identity: clientIdentity },
				{ credential: executorCredential, identity: executorIdentity },
				...this.additionalPeerBindings,
			],
			paths: this.dataPaths,
		};
		const agentsServer = await this.launchCompanion(
			"agents-server",
			agentsBootstrap,
			lifecycleEpoch,
		);
		if (agentsServer.ready?.role !== "agents-server") {
			throw new Error("agents-server did not produce its expected READY record.");
		}
		this.assertLifecycleActive(lifecycleEpoch);
		this.status = "connecting-client";
		const connectionPromise = this.connectClient({
			agentsServer: agentsServer.ready,
			identity: clientIdentity,
			credential: clientCredential,
		});
		let connection: DesktopAgentsConnection;
		try {
			connection = await this.waitForLifecycle(connectionPromise, lifecycleEpoch);
		} catch (error) {
			void connectionPromise
				.then((lateConnection) => lateConnection.close())
				.catch((connectionError: unknown) => {
					if (!this.shutdownRequested) {
						this.reportFatalError(
							toError(connectionError, "Desktop agents connection failed after cancellation."),
						);
					}
				});
			throw error;
		}
		this.assertLifecycleActive(lifecycleEpoch);
		this.clientConnection = connection;
		this.observeClientConnection(connection);
		this.status = "waiting-executor";
		const executorBootstrap: ExecutorBootstrapRecord = {
			channel: "moshu-companion-bootstrap",
			controlVersion: 2,
			type: "START",
			role: "executor",
			nonce: this.dependencies.createNonce(),
			identity: executorIdentity,
			credential: executorCredential,
			agentsServer: {
				identity: agentsServer.ready.serverIdentity,
				endpoint: agentsServer.ready.endpoint,
			},
		};
		await Promise.race([
			this.launchCompanion("executor", executorBootstrap, lifecycleEpoch),
			connection.closed.then(() => {
				throw new Error("Desktop agents connection closed before executor readiness.");
			}),
		]);
		if (connection.isClosed()) {
			throw new Error("Desktop agents connection closed before runtime readiness.");
		}
	}

	private async launchCompanion(
		role: CompanionRole,
		bootstrapRecord: AgentsServerBootstrapRecord | ExecutorBootstrapRecord,
		lifecycleEpoch: number,
	): Promise<ManagedCompanionProcess> {
		this.assertLifecycleActive(lifecycleEpoch);
		this.assertLifecycleActive(lifecycleEpoch);
		const child = this.dependencies.spawnProcess({
			role,
			executablePath: this.executables[role],
			environment: this.environment,
		});
		const managed: ManagedCompanionProcess = {
			identity: {
				role,
				pid: child.pid,
				generation: this.generations[role],
				nonce: bootstrapRecord.nonce,
				startedAtMs: this.dependencies.now(),
			},
			child,
			expectedExit: false,
			watching: false,
		};
		this.processes[role] = managed;
		this.observeExit(managed);
		this.drainStderr(managed);

		const bootstrap =
			role === "agents-server"
				? serializeAgentsServerBootstrap(bootstrapRecord as AgentsServerBootstrapRecord)
				: serializeExecutorBootstrap(bootstrapRecord as ExecutorBootstrapRecord);

		try {
			await this.waitForLifecycle(child.writeStdin(bootstrap), lifecycleEpoch);
			const expectation =
				role === "agents-server"
					? {
							role,
							pid: child.pid,
							nonce: bootstrapRecord.nonce,
							serverIdentity: (bootstrapRecord as AgentsServerBootstrapRecord).serverIdentity,
						}
					: {
							role,
							pid: child.pid,
							nonce: bootstrapRecord.nonce,
							identity: (bootstrapRecord as ExecutorBootstrapRecord).identity,
							agentsServer:
								this.processes["agents-server"]?.ready?.role === "agents-server"
									? this.processes["agents-server"].ready
									: fail("executor requires an agents-server READY record."),
						};
			managed.ready = await this.waitForLifecycle(
				withTimeout(
					readCompanionReadyRecord(child.stdout, expectation),
					this.startupTimeoutMs,
					this.dependencies,
					() => new Error(`${role} did not emit READY within ${this.startupTimeoutMs}ms.`),
				),
				lifecycleEpoch,
			);
			this.assertLifecycleActive(lifecycleEpoch);
			return managed;
		} catch (error) {
			await this.stopProcess(role);
			throw error;
		}
	}

	private createPeerIdentity(role: CompanionRole | "client"): ProcessPeerIdentity {
		if (role === "client" && this.clientIdentity !== undefined) {
			return this.clientIdentity;
		}
		this.generations[role] += 1;
		const identity: ProcessPeerIdentity = {
			role: role === "agents-server" ? "agents" : role,
			peerId:
				role === "agents-server"
					? "moshu-local-agents"
					: role === "client"
						? "moshu-desktop-client"
						: "moshu-local-executor",
			instanceId: this.dependencies.createInstanceId(),
			generation: this.generations[role],
		};
		if (role === "client") {
			this.clientIdentity = identity;
		}
		return identity;
	}

	private observeClientConnection(connection: DesktopAgentsConnection): void {
		void connection.closed.then(
			() => {
				if (
					this.clientConnection === connection &&
					this.status === "running" &&
					!this.shutdownRequested
				) {
					const cause = { message: "Desktop agents connection closed." };
					if (this.restartPromise === undefined) {
						this.beginRestart(cause);
					} else {
						this.queuedRestartCause = cause;
					}
				}
			},
			(error: unknown) => this.reportFatalError(toError(error, "Desktop RPC connection failed.")),
		);
	}

	private observeExit(managed: ManagedCompanionProcess): void {
		void managed.child.exited.then(
			(exitCode) => {
				managed.exitCode = exitCode;
				if (managed.expectedExit && this.processes[managed.identity.role] === managed) {
					this.processes[managed.identity.role] = undefined;
				}
				if (
					managed.watching &&
					!managed.expectedExit &&
					this.processes[managed.identity.role] === managed
				) {
					this.handleUnexpectedExit(managed, exitCode);
				}
			},
			(error: unknown) => {
				this.reportFatalError(toError(error, "Companion exit observation failed."));
			},
		);
	}

	private activateCrashDetection(): void {
		for (const role of ["agents-server", "executor"] as const) {
			const process = this.processes[role];
			if (process === undefined) {
				continue;
			}
			process.watching = true;
			if (process.exitCode !== undefined && !process.expectedExit) {
				this.handleUnexpectedExit(process, process.exitCode);
			}
		}
	}

	private handleUnexpectedExit(managed: ManagedCompanionProcess, exitCode: number): void {
		if (
			this.status === "stopping" ||
			this.status === "stopped" ||
			this.processes[managed.identity.role] !== managed
		) {
			return;
		}

		this.processes[managed.identity.role] = undefined;
		const crash: CompanionCrashEvent = {
			role: managed.identity.role,
			pid: managed.identity.pid,
			generation: managed.identity.generation,
			exitCode,
		};
		if (this.restartPromise !== undefined) {
			this.queuedRestartCause = crash;
		} else {
			this.beginRestart(crash);
		}
		this.invokeCrashObserver(crash);
	}

	private invokeCrashObserver(crash: CompanionCrashEvent): void {
		try {
			const result = this.hooks.onCrash?.(crash);
			if (result !== undefined) {
				void Promise.resolve(result).catch((error: unknown) => {
					this.reportFatalError(toError(error, "Companion crash observer failed."));
				});
			}
		} catch (error) {
			this.reportFatalError(toError(error, "Companion crash observer failed."));
		}
	}

	private beginRestart(cause: CompanionRestartCause): void {
		if (this.shutdownRequested) {
			return;
		}
		const lifecycleEpoch = this.lifecycleEpoch;
		const restartPromise = this.startRestartOwner(cause, lifecycleEpoch);
		void restartPromise
			.catch((error: unknown) => {
				if (error instanceof LifecycleCancelledError && this.shutdownRequested) {
					return;
				}
				this.status = "failed";
				this.reportFatalError(toError(error, "Companion restart failed."));
			})
			.catch(() => undefined);
	}

	private startRestartOwner(cause: CompanionRestartCause, lifecycleEpoch: number): Promise<void> {
		if (this.restartPromise !== undefined) {
			this.queuedRestartCause = cause;
			return this.restartPromise;
		}

		let resolveOwner: (() => void) | undefined;
		let rejectOwner: ((error: unknown) => void) | undefined;
		const owner = new Promise<void>((resolve, reject) => {
			resolveOwner = resolve;
			rejectOwner = reject;
		});
		this.restartPromise = owner;
		const clearOwner = (): void => {
			if (this.restartPromise === owner) {
				this.restartPromise = undefined;
			}
		};
		const rejectRestartOwner = (error: unknown): void => {
			clearOwner();
			rejectOwner?.(error);
		};
		const settleRestartOwner = (): void => {
			const queuedCause = this.takeQueuedRestartCause();
			if (queuedCause !== undefined) {
				void this.driveRestartOwner(queuedCause, lifecycleEpoch).then(
					settleRestartOwner,
					rejectRestartOwner,
				);
				return;
			}
			clearOwner();
			resolveOwner?.();
			if (this.status === "running" && this.hasRunningPair()) {
				try {
					this.hooks.onRestarted?.(this.getSnapshot());
				} catch (error) {
					this.reportFatalError(toError(error, "Companion restart observer failed."));
				}
			}
		};
		void this.driveRestartOwner(cause, lifecycleEpoch).then(settleRestartOwner, rejectRestartOwner);
		return owner;
	}

	private async driveRestartOwner(
		initialCause: CompanionRestartCause,
		lifecycleEpoch: number,
	): Promise<void> {
		let cause = initialCause;
		while (this.isLifecycleActive(lifecycleEpoch)) {
			await this.restartAfterCrash(cause, lifecycleEpoch);
			await Promise.resolve();
			const queuedCause = this.takeQueuedRestartCause();
			if (queuedCause === undefined) {
				return;
			}
			cause = queuedCause;
		}
		this.assertLifecycleActive(lifecycleEpoch);
	}

	private takeQueuedRestartCause(): CompanionRestartCause | undefined {
		if (this.clientConnection?.isClosed()) {
			this.queuedRestartCause = undefined;
			return { message: "Desktop agents connection closed during restart." };
		}
		const queuedCause = this.queuedRestartCause;
		this.queuedRestartCause = undefined;
		if (
			queuedCause !== undefined &&
			(!("role" in queuedCause) ||
				(this.generations[queuedCause.role] === queuedCause.generation &&
					this.processes[queuedCause.role] === undefined))
		) {
			return queuedCause;
		}
		return undefined;
	}

	private async restartAfterCrash(
		initialCause: CompanionRestartCause,
		lifecycleEpoch: number,
	): Promise<void> {
		let cause: CompanionRestartCause = initialCause;
		while (this.isLifecycleActive(lifecycleEpoch)) {
			this.status = "restarting";
			await this.stopPair();
			this.assertLifecycleActive(lifecycleEpoch);

			const permit = this.restartBudget.take();
			if (permit === undefined) {
				this.status = "failed";
				this.hooks.onRestartBudgetExhausted?.({
					attempts: this.restartBudget.attemptsUsed,
					cause,
				});
				if (this.hooks.onRestartBudgetExhausted === undefined) {
					console.error("Companion restart budget exhausted.", cause);
				}
				return;
			}
			this.hooks.onRestartScheduled?.({ ...permit, cause });
			await this.waitForLifecycle(this.dependencies.sleep(permit.delayMs), lifecycleEpoch);
			this.assertLifecycleActive(lifecycleEpoch);

			try {
				await this.startPair(lifecycleEpoch);
				this.assertLifecycleActive(lifecycleEpoch);
				this.status = "running";
				this.activateCrashDetection();
				return;
			} catch (error) {
				await this.stopPair();
				if (error instanceof LifecycleCancelledError) {
					throw error;
				}
				cause = {
					message: toError(error, "Companion restart startup failed.").message,
				};
			}
		}
	}

	private hasRunningPair(): boolean {
		const agentsServer = this.processes["agents-server"];
		const executor = this.processes.executor;
		return (
			agentsServer?.ready?.role === "agents-server" &&
			agentsServer.exitCode === undefined &&
			executor?.ready?.role === "executor" &&
			executor.exitCode === undefined
		);
	}

	private isLifecycleActive(lifecycleEpoch: number): boolean {
		return (
			!this.shutdownRequested &&
			this.lifecycleEpoch === lifecycleEpoch &&
			this.status !== "stopping" &&
			this.status !== "stopped"
		);
	}

	private assertLifecycleActive(lifecycleEpoch: number): void {
		if (!this.isLifecycleActive(lifecycleEpoch)) {
			throw new LifecycleCancelledError();
		}
	}

	private async waitForLifecycle<T>(operation: Promise<T>, lifecycleEpoch: number): Promise<T> {
		this.assertLifecycleActive(lifecycleEpoch);
		return Promise.race([
			operation,
			this.shutdownSignal.promise.then(() => {
				throw new LifecycleCancelledError();
			}),
		]);
	}

	private async stopPair(): Promise<void> {
		const connection = this.clientConnection;
		this.clientConnection = undefined;
		if (connection !== undefined) {
			try {
				await connection.close();
			} catch (error) {
				this.reportFatalError(toError(error, "Failed to close the desktop agents connection."));
			}
		}
		let stopError: unknown;
		try {
			await this.stopProcess("executor");
		} catch (error) {
			stopError = error;
		}
		try {
			await this.stopProcess("agents-server");
		} catch (error) {
			stopError ??= error;
		}
		if (stopError !== undefined) {
			throw stopError;
		}
	}

	private stopProcess(role: CompanionRole): Promise<void> {
		const managed = this.processes[role];
		if (managed === undefined) {
			return Promise.resolve();
		}
		if (managed.stopPromise !== undefined) {
			return managed.stopPromise;
		}

		const stopPromise = this.stopManagedProcess(role, managed);
		managed.stopPromise = stopPromise;
		return stopPromise;
	}

	private async stopManagedProcess(
		role: CompanionRole,
		managed: ManagedCompanionProcess,
	): Promise<void> {
		managed.expectedExit = true;

		if (managed.exitCode === undefined) {
			let controlChannelClosed = false;
			try {
				await managed.child.closeStdin();
				controlChannelClosed = true;
			} catch (error) {
				this.reportFatalError(
					toError(error, `Failed to close the ${role} parent control channel.`),
				);
			}
			const exitedAfterEof =
				controlChannelClosed &&
				(await settlesWithin(managed.child.exited, this.shutdownTimeoutMs, this.dependencies));
			if (!exitedAfterEof) {
				managed.child.kill("SIGTERM");
				const exitedGracefully = await settlesWithin(
					managed.child.exited,
					this.shutdownTimeoutMs,
					this.dependencies,
				);
				if (!exitedGracefully) {
					managed.child.kill("SIGKILL");
					const exitedAfterKill = await settlesWithin(
						managed.child.exited,
						this.shutdownTimeoutMs,
						this.dependencies,
					);
					if (!exitedAfterKill) {
						const error = new TerminationUnconfirmedError(
							`${role} did not exit after SIGKILL within ${this.shutdownTimeoutMs}ms.`,
						);
						this.reportFatalError(error);
						throw error;
					}
				}
			}
		}

		if (this.processes[role] === managed) {
			this.processes[role] = undefined;
		}
	}

	private drainStderr(managed: ManagedCompanionProcess): void {
		void drainTextStream(managed.child.stderr, (text) => {
			if (text.length === 0) {
				return;
			}
			if (this.hooks.onStderr !== undefined) {
				this.hooks.onStderr({
					role: managed.identity.role,
					pid: managed.identity.pid,
					generation: managed.identity.generation,
					text,
				});
			} else {
				console.error(`[${managed.identity.role}#${managed.identity.generation}] ${text}`);
			}
		}).catch((error: unknown) => {
			this.reportFatalError(toError(error, "Failed to drain companion stderr."));
		});
	}

	private reportFatalError(error: Error): void {
		if (this.hooks.onFatalError !== undefined) {
			try {
				this.hooks.onFatalError(error);
			} catch (callbackError) {
				console.error("Companion fatal-error observer failed.", callbackError);
			}
		} else {
			console.error(error);
		}
	}
}

function createReadySnapshot(ready: CompanionReadyRecord): CompanionReadySnapshot {
	const common = {
		channel: ready.channel,
		controlVersion: ready.controlVersion,
		type: ready.type,
		pid: ready.pid,
		processVersion: ready.processVersion,
	};
	if (ready.role === "agents-server") {
		return {
			...common,
			role: ready.role,
			serverIdentity: { ...ready.serverIdentity },
			endpoint: { ...ready.endpoint },
		};
	}
	return {
		...common,
		role: ready.role,
		identity: { ...ready.identity },
		agentsServer: {
			identity: { ...ready.agentsServer.identity },
			endpoint: { ...ready.agentsServer.endpoint },
		},
	};
}

function createDefaultDataPaths(): AgentsServerDataPaths {
	const directory = join(tmpdir(), `moshu-companion-${process.pid}`);
	return {
		productDatabase: join(directory, "moshu.db"),
		agentDataDirectory: join(directory, "agent-data"),
	};
}

async function createNoopDesktopConnection(): Promise<DesktopAgentsConnection> {
	return {
		closed: new Promise<void>(() => undefined),
		isClosed: () => false,
		close() {},
	};
}

async function drainTextStream(
	stream: ReadableStream<Uint8Array>,
	onText: (text: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				const remainder = decoder.decode();
				if (remainder.length > 0) {
					onText(remainder);
				}
				return;
			}
			onText(decoder.decode(result.value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}
}

async function settlesWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
	timers: TimerDependencies,
): Promise<boolean> {
	try {
		await withTimeout(promise, timeoutMs, timers, () => new TimeoutMarkerError());
		return true;
	} catch (error) {
		if (error instanceof TimeoutMarkerError) {
			return false;
		}
		throw error;
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timers: TimerDependencies,
	createTimeoutError: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = timers.setTimer(() => {
			reject(createTimeoutError());
		}, timeoutMs);
		void promise.then(
			(value) => {
				timers.clearTimer(timer);
				resolve(value);
			},
			(error: unknown) => {
				timers.clearTimer(timer);
				reject(error);
			},
		);
	});
}

function assertAbsoluteExecutablePath(role: CompanionRole, executablePath: string): void {
	if (!isAbsolute(executablePath)) {
		throw new Error(`${role} executable path must be absolute.`);
	}
}

function assertPositiveTimeout(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be greater than zero.`);
	}
	return value;
}

function assertRestartPolicy(policy: RestartPolicy): void {
	if (
		!Number.isInteger(policy.maxAttempts) ||
		policy.maxAttempts < 0 ||
		!Number.isFinite(policy.baseDelayMs) ||
		policy.baseDelayMs < 0 ||
		!Number.isFinite(policy.maxDelayMs) ||
		policy.maxDelayMs < 0
	) {
		throw new Error("Restart policy values must be finite non-negative numbers.");
	}
}

function fail(message: string): never {
	throw new Error(message);
}

function toError(error: unknown, fallbackMessage: string): Error {
	return error instanceof Error ? error : new Error(fallbackMessage, { cause: error });
}

class TimeoutMarkerError extends Error {}

class LifecycleCancelledError extends Error {}

class TerminationUnconfirmedError extends Error {}

function createDeferredSignal(): {
	promise: Promise<void>;
	resolve(): void;
} {
	let resolveSignal: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveSignal = resolve;
	});
	return {
		promise,
		resolve() {
			resolveSignal?.();
		},
	};
}
