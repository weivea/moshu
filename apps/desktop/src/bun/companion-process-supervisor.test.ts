import { describe, expect, test } from "bun:test";

import {
	COMPANION_BOOTSTRAP_CHANNEL,
	COMPANION_CONTROL_VERSION,
	parseCompanionReadyRecord,
} from "./companion-control";
import {
	type CompanionProcessSpawnRequest,
	CompanionProcessSupervisor,
	type CompanionRole,
	type CompanionSignal,
	createCompanionEnvironment,
	type DesktopAgentsConnection,
	RestartBudget,
	type RestartPolicy,
	type SpawnedCompanionProcess,
} from "./companion-process-supervisor";

const EXECUTABLES = {
	"agents-server": "/opt/moshu/companions/moshu-agents-server",
	executor: "/opt/moshu/companions/moshu-executor",
} as const;
const TEST_SERVER_IDENTITY = {
	role: "agents",
	peerId: "moshu-local-agents",
	instanceId: "agents-test-1",
	generation: 1,
} as const;

describe("companion READY control parsing", () => {
	test("parses a bounded agents-server READY record", () => {
		expect(
			parseCompanionReadyRecord(
				`${JSON.stringify({
					channel: COMPANION_BOOTSTRAP_CHANNEL,
					controlVersion: COMPANION_CONTROL_VERSION,
					type: "READY",
					role: "agents-server",
					pid: 701,
					processVersion: "0.0.1",
					nonce: "server-generation-1",
					serverIdentity: TEST_SERVER_IDENTITY,
					endpoint: { host: "127.0.0.1", port: 41_701, path: "/rpc" },
				})}\n`,
				{
					role: "agents-server",
					pid: 701,
					nonce: "server-generation-1",
					serverIdentity: TEST_SERVER_IDENTITY,
				},
			),
		).toMatchObject({
			role: "agents-server",
			pid: 701,
			endpoint: { host: "127.0.0.1", port: 41_701, path: "/rpc" },
		});
	});

	test.each([
		["malformed JSON", "not-json\n"],
		[
			"wrong nonce",
			JSON.stringify({
				channel: COMPANION_BOOTSTRAP_CHANNEL,
				controlVersion: COMPANION_CONTROL_VERSION,
				type: "READY",
				role: "agents-server",
				pid: 701,
				processVersion: "0.0.1",
				nonce: "different-nonce",
				serverIdentity: TEST_SERVER_IDENTITY,
				endpoint: { host: "127.0.0.1", port: 41_701, path: "/rpc" },
			}),
		],
		[
			"non-loopback endpoint",
			JSON.stringify({
				channel: COMPANION_BOOTSTRAP_CHANNEL,
				controlVersion: COMPANION_CONTROL_VERSION,
				type: "READY",
				role: "agents-server",
				pid: 701,
				processVersion: "0.0.1",
				nonce: "server-generation-1",
				serverIdentity: TEST_SERVER_IDENTITY,
				endpoint: { host: "0.0.0.0", port: 41_701, path: "/rpc" },
			}),
		],
	])("rejects %s", (_name, input) => {
		expect(() =>
			parseCompanionReadyRecord(input, {
				role: "agents-server",
				pid: 701,
				nonce: "server-generation-1",
				serverIdentity: TEST_SERVER_IDENTITY,
			}),
		).toThrow();
	});
});

describe("CompanionProcessSupervisor", () => {
	test("times out startup and terminates the silent child", async () => {
		const spawner = new FakeSpawner([{ ready: "silent" }]);
		const supervisor = createSupervisor(spawner, {
			startupTimeoutMs: 5,
			shutdownTimeoutMs: 20,
			restartPolicy: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
		});

		await expect(supervisor.start()).rejects.toThrow("agents-server did not emit READY within 5ms");
		expect(spawner.processes[0]?.stdinCloseCount).toBe(1);
		expect(spawner.processes[0]?.signals).toEqual([]);
		expect(spawner.requests[0]).toMatchObject({
			role: "agents-server",
			executablePath: EXECUTABLES["agents-server"],
			environment: { HOME: "/Users/test", TMPDIR: "/tmp/test" },
		});
	});

	test("rejects malformed READY output and terminates the child", async () => {
		const spawner = new FakeSpawner([{ ready: "malformed" }]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
		});

		await expect(supervisor.start()).rejects.toThrow("READY control record is not valid JSON");
		expect(spawner.processes[0]?.stdinCloseCount).toBe(1);
		await Bun.sleep(0);
		expect(supervisor.getSnapshot().status).toBe("failed");
		expect(spawner.requests).toHaveLength(1);
	});

	test("recovers from an initial startup failure within the restart budget", async () => {
		const spawner = new FakeSpawner([
			{ ready: "malformed" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			dependencies: { sleep: async () => {} },
		});

		await expect(supervisor.start()).resolves.toMatchObject({ status: "running" });
		expect(spawner.requests.map((request) => request.role)).toEqual([
			"agents-server",
			"agents-server",
			"executor",
		]);
		await supervisor.shutdown();
	});

	test("keeps initial recovery owned through an immediate replacement crash", async () => {
		const spawner = new FakeSpawner([
			{ ready: "malformed" },
			{ ready: "valid" },
			{ ready: "valid", exitAfterReady: 19 },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			dependencies: { sleep: async () => {} },
		});

		await expect(supervisor.start()).resolves.toMatchObject({
			status: "running",
			restartAttempts: 2,
			processes: {
				"agents-server": { identity: { generation: 3 } },
				executor: { identity: { generation: 3 } },
			},
		});
		await Bun.sleep(0);
		expect(supervisor.getSnapshot().status).toBe("running");
		expect(spawner.requests.map((request) => request.role)).toEqual([
			"agents-server",
			"agents-server",
			"executor",
			"agents-server",
			"executor",
		]);
		await supervisor.shutdown();
	});

	test("fails startup when the desktop RPC connection closes before executor readiness", async () => {
		const spawner = new FakeSpawner([{ ready: "valid" }, { ready: "valid" }]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
			connectClient: async () => ({
				closed: Promise.resolve(),
				isClosed: () => true,
				close() {},
			}),
		});

		await expect(supervisor.start()).rejects.toThrow("closed before executor readiness");
		expect(supervisor.getSnapshot().status).toBe("failed");
	});

	test("closes a desktop connection that resolves after shutdown cancels startup", async () => {
		const spawner = new FakeSpawner([{ ready: "valid" }]);
		const connectStarted = createDeferred();
		let resolveConnection: ((connection: DesktopAgentsConnection) => void) | undefined;
		const pendingConnection = new Promise<DesktopAgentsConnection>((resolve) => {
			resolveConnection = resolve;
		});
		let lateConnectionClosed = false;
		const supervisor = createSupervisor(spawner, {
			connectClient: async () => {
				connectStarted.resolve();
				return pendingConnection;
			},
		});

		const startup = supervisor.start();
		await connectStarted.promise;
		const shutdown = supervisor.shutdown();
		resolveConnection?.({
			closed: new Promise<void>(() => undefined),
			isClosed: () => lateConnectionClosed,
			close() {
				lateConnectionClosed = true;
			},
		});
		await shutdown;
		await Promise.allSettled([startup]);
		await Bun.sleep(0);

		expect(lateConnectionClosed).toBe(true);
		expect(supervisor.getSnapshot().status).toBe("stopped");
	});

	test("shuts down executor before agents-server", async () => {
		const stopOrder: string[] = [];
		const spawner = new FakeSpawner([{ ready: "valid" }, { ready: "valid" }], stopOrder);
		const supervisor = createSupervisor(spawner);
		await supervisor.start();

		await supervisor.shutdown();

		expect(stopOrder).toEqual(["executor:stdin", "agents-server:stdin"]);
		expect(supervisor.getSnapshot()).toMatchObject({
			status: "stopped",
			processes: {},
		});
	});

	test("detects a crash and restarts the dependency pair with new generations", async () => {
		const delays: number[] = [];
		const clientIdentities: unknown[] = [];
		let restartLog = "";
		let resolveRestarted: (() => void) | undefined;
		const restarted = new Promise<void>((resolve) => {
			resolveRestarted = resolve;
		});
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			connectClient: async ({ identity }) => {
				clientIdentities.push(identity);
				return {
					closed: new Promise<void>(() => undefined),
					isClosed: () => false,
					close() {},
				};
			},
			restartPolicy: {
				maxAttempts: 2,
				baseDelayMs: 25,
				maxDelayMs: 100,
			},
			dependencies: {
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
			hooks: {
				onRestarted(snapshot) {
					restartLog = JSON.stringify(snapshot);
					resolveRestarted?.();
				},
			},
		});
		await supervisor.start();

		spawner.processes[1]?.crash(17);
		await restarted;

		expect(delays).toEqual([25]);
		expect(supervisor.getSnapshot()).toMatchObject({
			status: "running",
			restartAttempts: 1,
			processes: {
				"agents-server": { identity: { generation: 2 } },
				executor: { identity: { generation: 2 } },
			},
		});
		expect(restartLog).not.toContain("test-generation");
		expect(restartLog).not.toContain("nonce");
		expect(JSON.stringify(supervisor.getSnapshot())).not.toContain("test-generation");
		expect(clientIdentities).toHaveLength(2);
		expect(clientIdentities[1]).toEqual(clientIdentities[0]);
		await supervisor.shutdown();
	});

	test("keeps replacement connection loss inside the active restart owner", async () => {
		const restarted = createDeferred();
		let connectionGeneration = 0;
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			dependencies: { sleep: async () => {} },
			connectClient: async () => {
				connectionGeneration += 1;
				if (connectionGeneration !== 2) {
					return {
						closed: new Promise<void>(() => undefined),
						isClosed: () => false,
						close() {},
					};
				}
				let closed = false;
				let resolveClosed: (() => void) | undefined;
				const closedPromise = new Promise<void>((resolve) => {
					resolveClosed = resolve;
				});
				let checks = 0;
				return {
					closed: closedPromise,
					isClosed() {
						checks += 1;
						if (checks === 1) {
							queueMicrotask(() => {
								closed = true;
								resolveClosed?.();
							});
						}
						return closed;
					},
					close() {
						closed = true;
						resolveClosed?.();
					},
				};
			},
			hooks: {
				onRestarted(snapshot) {
					if (snapshot.processes["agents-server"]?.identity.generation === 3) {
						restarted.resolve();
					}
				},
			},
		});
		await supervisor.start();

		spawner.processes[1]?.crash(17);
		await restarted.promise;
		expect(supervisor.getSnapshot()).toMatchObject({
			status: "running",
			restartAttempts: 2,
			processes: {
				"agents-server": { identity: { generation: 3 } },
				executor: { identity: { generation: 3 } },
			},
		});
		expect(spawner.requests).toHaveLength(6);
		await supervisor.shutdown();
	});

	test.each([
		[
			"synchronous throw",
			() => {
				throw new Error("sync observer failure");
			},
		],
		["asynchronous rejection", () => Promise.reject(new Error("async observer failure"))],
	])("contains an onCrash %s without bypassing fencing", async (_name, onCrash) => {
		const stopOrder: string[] = [];
		const restartDelayStarted = createDeferred();
		const restartDelay = createDeferred();
		const restarted = createDeferred();
		const reportedErrors: string[] = [];
		let oldClientReachable = true;
		let connectionCount = 0;
		const spawner = new FakeSpawner(
			[{ ready: "valid" }, { ready: "valid" }, { ready: "valid" }, { ready: "valid" }],
			stopOrder,
		);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: { maxAttempts: 1, baseDelayMs: 25, maxDelayMs: 25 },
			dependencies: {
				sleep: async () => {
					restartDelayStarted.resolve();
					await restartDelay.promise;
				},
			},
			connectClient: async () => {
				connectionCount += 1;
				const firstConnection = connectionCount === 1;
				return {
					closed: new Promise<void>(() => undefined),
					isClosed: () => firstConnection && !oldClientReachable,
					close() {
						if (firstConnection) {
							oldClientReachable = false;
						}
					},
				};
			},
			hooks: {
				onCrash,
				onFatalError(error) {
					reportedErrors.push(error.message);
				},
				onRestarted() {
					restarted.resolve();
				},
			},
		});
		await supervisor.start();

		spawner.processes[1]?.crash(17);
		await restartDelayStarted.promise;
		await Bun.sleep(0);
		expect(oldClientReachable).toBe(false);
		expect(stopOrder).toContain("agents-server:stdin");
		expect(spawner.requests).toHaveLength(2);
		expect(reportedErrors.some((message) => message.includes("observer failure"))).toBe(true);

		restartDelay.resolve();
		await restarted.promise;
		expect(spawner.requests).toHaveLength(4);
		expect(supervisor.getSnapshot().status).toBe("running");
		await supervisor.shutdown();
	});

	test("cancels a delayed restart before shutdown returns", async () => {
		const restartDelayStarted = createDeferred();
		const restartDelay = createDeferred();
		let oldClientReachable = true;
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: {
				maxAttempts: 2,
				baseDelayMs: 25,
				maxDelayMs: 100,
			},
			dependencies: {
				sleep: async () => {
					restartDelayStarted.resolve();
					await restartDelay.promise;
				},
			},
			connectClient: async () => ({
				closed: new Promise<void>(() => undefined),
				isClosed: () => !oldClientReachable,
				close() {
					oldClientReachable = false;
				},
			}),
		});
		await supervisor.start();
		spawner.processes[1]?.crash(17);
		await restartDelayStarted.promise;

		expect(oldClientReachable).toBe(false);
		expect(spawner.processes[0]?.stdinCloseCount).toBe(1);
		expect(spawner.requests).toHaveLength(2);

		await supervisor.shutdown();

		expect(supervisor.getSnapshot()).toMatchObject({
			status: "stopped",
			processes: {},
		});
		expect(spawner.requests).toHaveLength(2);
		expect(spawner.processes[0]?.stdinCloseCount).toBe(1);

		restartDelay.resolve();
		await Bun.sleep(0);
		expect(spawner.requests).toHaveLength(2);
	});

	test("cleans up the surviving process when the restart budget is exhausted", async () => {
		let resolveFirstRestart: (() => void) | undefined;
		const firstRestart = new Promise<void>((resolve) => {
			resolveFirstRestart = resolve;
		});
		let resolveExhausted: (() => void) | undefined;
		let exhaustionLog = "";
		const exhausted = new Promise<void>((resolve) => {
			resolveExhausted = resolve;
		});
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: {
				maxAttempts: 1,
				baseDelayMs: 1,
				maxDelayMs: 1,
			},
			dependencies: {
				sleep: async () => undefined,
			},
			hooks: {
				onRestarted() {
					resolveFirstRestart?.();
				},
				onRestartBudgetExhausted(event) {
					exhaustionLog = JSON.stringify(event);
					resolveExhausted?.();
				},
			},
		});
		await supervisor.start();
		spawner.processes[1]?.crash(17);
		await firstRestart;

		spawner.processes[3]?.crash(18);
		await exhausted;

		expect(supervisor.getSnapshot()).toMatchObject({
			status: "failed",
			restartAttempts: 1,
			processes: {},
		});
		expect(spawner.processes[2]?.stdinCloseCount).toBe(1);
		expect(exhaustionLog).not.toContain("test-generation");
		expect(exhaustionLog).not.toContain("identity");
	});

	test("queues an immediate post-READY crash for another restart cycle", async () => {
		const delays: number[] = [];
		let resolveRestarted: (() => void) | undefined;
		const restarted = new Promise<void>((resolve) => {
			resolveRestarted = resolve;
		});
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid", exitAfterReady: 19 },
			{ ready: "valid" },
			{ ready: "valid" },
			{ ready: "valid" },
		]);
		const supervisor = createSupervisor(spawner, {
			restartPolicy: {
				maxAttempts: 2,
				baseDelayMs: 5,
				maxDelayMs: 20,
			},
			dependencies: {
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
			hooks: {
				onRestarted(snapshot) {
					if (snapshot.processes["agents-server"]?.identity.generation === 3) {
						resolveRestarted?.();
					}
				},
			},
		});
		await supervisor.start();

		spawner.processes[1]?.crash(17);
		await restarted;

		expect(delays).toEqual([5, 10]);
		expect(supervisor.getSnapshot()).toMatchObject({
			status: "running",
			restartAttempts: 2,
			processes: {
				"agents-server": { identity: { generation: 3 } },
				executor: { identity: { generation: 3 } },
			},
		});
		await supervisor.shutdown();
	});

	test("retains an unconfirmed child and refuses to report stopped", async () => {
		const stopOrder: string[] = [];
		const spawner = new FakeSpawner(
			[{ ready: "valid" }, { ready: "valid", exitOnStdinClose: false, ignoreSignals: true }],
			stopOrder,
		);
		const supervisor = createSupervisor(spawner, {
			shutdownTimeoutMs: 1,
		});
		await supervisor.start();

		await expect(supervisor.shutdown()).rejects.toThrow("did not exit after SIGKILL");
		expect(supervisor.getSnapshot()).toMatchObject({
			status: "failed",
			processes: { executor: { identity: { pid: spawner.processes[1]?.pid } } },
		});
		expect(stopOrder).toEqual([
			"executor:stdin",
			"executor:SIGTERM",
			"executor:SIGKILL",
			"agents-server:stdin",
		]);
		expect(spawner.requests).toHaveLength(2);

		spawner.processes[1]?.crash(0);
		await Bun.sleep(0);
		expect(supervisor.getSnapshot().processes).toEqual({});
		expect(supervisor.getSnapshot().status).toBe("failed");
	});

	test("blocks replacement when a surviving child ignores SIGKILL", async () => {
		const fatal = createDeferred();
		const spawner = new FakeSpawner([
			{ ready: "valid" },
			{ ready: "valid", exitOnStdinClose: false, ignoreSignals: true },
		]);
		const supervisor = createSupervisor(spawner, {
			shutdownTimeoutMs: 1,
			restartPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
			dependencies: { sleep: async () => {} },
			hooks: {
				onFatalError() {
					fatal.resolve();
				},
			},
		});
		await supervisor.start();

		spawner.processes[0]?.crash(17);
		await fatal.promise;
		await Bun.sleep(5);
		expect(supervisor.getSnapshot().status).toBe("failed");
		expect(supervisor.getSnapshot().processes.executor).toBeDefined();
		expect(spawner.requests).toHaveLength(2);
		spawner.processes[1]?.crash(0);
	});

	test("requires absolute executable paths", () => {
		expect(
			() =>
				new CompanionProcessSupervisor({
					executables: {
						"agents-server": "relative/agents-server",
						executor: EXECUTABLES.executor,
					},
				}),
		).toThrow("agents-server executable path must be absolute");
	});
});

describe("RestartBudget", () => {
	test("caps exponential backoff and exhausts the configured budget", () => {
		const policy: RestartPolicy = {
			maxAttempts: 4,
			baseDelayMs: 100,
			maxDelayMs: 250,
		};
		const budget = new RestartBudget(policy);

		expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([
			{ attempt: 1, delayMs: 100 },
			{ attempt: 2, delayMs: 200 },
			{ attempt: 3, delayMs: 250 },
			{ attempt: 4, delayMs: 250 },
		]);
		expect(budget.take()).toBeUndefined();
		expect(budget.attemptsUsed).toBe(4);
	});
});

describe("createCompanionEnvironment", () => {
	test("inherits the complete desktop environment and drops undefined values", () => {
		expect(
			createCompanionEnvironment({
				HOME: "/Users/test",
				TMPDIR: "/tmp/test",
				PATH: "/usr/local/bin",
				SECRET_TOKEN: "copy-by-design",
				UNDEFINED_VALUE: undefined,
			}),
		).toEqual({
			HOME: "/Users/test",
			TMPDIR: "/tmp/test",
			PATH: "/usr/local/bin",
			SECRET_TOKEN: "copy-by-design",
		});
	});
});

type ReadyBehavior = "valid" | "malformed" | "silent";

interface FakeProcessPlan {
	ready: ReadyBehavior;
	exitAfterReady?: number;
	exitOnStdinClose?: boolean;
	ignoreSignals?: boolean;
}

class FakeSpawner {
	readonly requests: CompanionProcessSpawnRequest[] = [];
	readonly processes: FakeProcess[] = [];
	private nextPid = 700;
	private readonly plans: FakeProcessPlan[];
	private readonly stopOrder?: string[];

	constructor(plans: FakeProcessPlan[], stopOrder?: string[]) {
		this.plans = [...plans];
		this.stopOrder = stopOrder;
	}

	spawn = (request: CompanionProcessSpawnRequest): SpawnedCompanionProcess => {
		const plan = this.plans.shift();
		if (plan === undefined) {
			throw new Error(`No fake process plan for ${request.role}.`);
		}
		this.nextPid += 1;
		const process = new FakeProcess(request.role, this.nextPid, plan, this.stopOrder);
		this.requests.push(request);
		this.processes.push(process);
		return process;
	};
}

class FakeProcess implements SpawnedCompanionProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly signals: CompanionSignal[] = [];
	stdinCloseCount = 0;
	private readonly stdoutController: ReadableStreamDefaultController<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private readonly input: Uint8Array[] = [];
	private readonly plan: FakeProcessPlan;
	private readonly role: CompanionRole;
	private readonly stopOrder?: string[];
	private resolveExited: ((exitCode: number) => void) | undefined;
	private settled = false;

	constructor(
		role: CompanionRole,
		readonly pid: number,
		plan: FakeProcessPlan,
		stopOrder?: string[],
	) {
		this.role = role;
		this.plan = plan;
		this.stopOrder = stopOrder;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		this.stdout = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		if (controller === undefined) {
			throw new Error("Fake stdout controller was not initialized.");
		}
		this.stdoutController = controller;
		this.stderr = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.close();
			},
		});
		this.exited = new Promise((resolve) => {
			this.resolveExited = resolve;
		});
	}

	async writeStdin(bytes: Uint8Array): Promise<void> {
		this.input.push(bytes);
		if (this.plan.ready === "silent") {
			return;
		}
		if (this.plan.ready === "malformed") {
			this.stdoutController.enqueue(new TextEncoder().encode("not-json\n"));
			return;
		}

		const parsed: unknown = JSON.parse(
			this.input.map((chunk) => this.decoder.decode(chunk)).join(""),
		);
		if (!isObject(parsed) || typeof parsed.nonce !== "string") {
			throw new Error("Fake process received no nonce.");
		}
		const nonce = parsed.nonce;
		const agentsServer =
			this.role === "executor" ? parseFakeAgentsServerBinding(parsed.agentsServer) : undefined;
		const ready =
			this.role === "agents-server"
				? {
						channel: COMPANION_BOOTSTRAP_CHANNEL,
						controlVersion: COMPANION_CONTROL_VERSION,
						type: "READY",
						role: "agents-server",
						pid: this.pid,
						processVersion: "0.0.1",
						nonce,
						serverIdentity: parsed.serverIdentity,
						endpoint: {
							host: "127.0.0.1",
							port: 40_000 + this.pid,
							path: "/rpc",
						},
					}
				: {
						channel: COMPANION_BOOTSTRAP_CHANNEL,
						controlVersion: COMPANION_CONTROL_VERSION,
						type: "READY",
						role: "executor",
						pid: this.pid,
						processVersion: "0.0.1",
						nonce,
						identity: parsed.identity,
						agentsServer,
					};
		this.stdoutController.enqueue(new TextEncoder().encode(`${JSON.stringify(ready)}\n`));
		if (this.plan.exitAfterReady !== undefined) {
			this.finish(this.plan.exitAfterReady);
		}
	}

	async closeStdin(): Promise<void> {
		this.stdinCloseCount += 1;
		this.stopOrder?.push(`${this.role}:stdin`);
		if (this.plan.exitOnStdinClose !== false) {
			this.finish(0);
		}
	}

	kill(signal: CompanionSignal): void {
		this.signals.push(signal);
		this.stopOrder?.push(`${this.role}:${signal}`);
		if (this.plan.ignoreSignals !== true) {
			this.finish(0);
		}
	}

	crash(exitCode: number): void {
		this.finish(exitCode);
	}

	private finish(exitCode: number): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.stdoutController.close();
		this.resolveExited?.(exitCode);
	}
}

function parseFakeAgentsServerBinding(value: unknown): {
	identity: Record<string, unknown>;
	endpoint: { host: string; port: number; path: string };
} {
	if (
		!isObject(value) ||
		!isObject(value.identity) ||
		!isObject(value.endpoint) ||
		typeof value.endpoint.host !== "string" ||
		typeof value.endpoint.port !== "number" ||
		typeof value.endpoint.path !== "string"
	) {
		throw new Error("Fake executor received no agents-server READY record.");
	}
	return {
		identity: value.identity,
		endpoint: {
			host: value.endpoint.host,
			port: value.endpoint.port,
			path: value.endpoint.path,
		},
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDeferred(): {
	promise: Promise<void>;
	resolve(): void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.();
		},
	};
}

function createSupervisor(
	spawner: FakeSpawner,
	overrides: Partial<
		Omit<ConstructorParameters<typeof CompanionProcessSupervisor>[0], "executables">
	> = {},
): CompanionProcessSupervisor {
	const { dependencies, ...options } = overrides;
	return new CompanionProcessSupervisor({
		executables: EXECUTABLES,
		environment: createCompanionEnvironment({
			HOME: "/Users/test",
			TMPDIR: "/tmp/test",
			PATH: "/usr/bin",
		}),
		dependencies: {
			spawnProcess: spawner.spawn,
			now: () => 1_000,
			createNonce: createSequentialNonce(),
			...dependencies,
		},
		...options,
	});
}

function createSequentialNonce(): () => string {
	let value = 0;
	return () => {
		value += 1;
		return `test-generation-${value}`;
	};
}
