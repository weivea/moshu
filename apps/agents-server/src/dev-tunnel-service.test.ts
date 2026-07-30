import { describe, expect, test } from "bun:test";
import { openAppDatabase } from "@moshu/database";

import {
	type DevTunnelAdapter,
	type DevTunnelAuthenticationProcess,
	DevTunnelCliAdapter,
	type DevTunnelHostProcess,
	DevTunnelService,
	findListedTunnelId,
	monitorHostPorts,
	parseDevTunnelLoginStatus,
	parseQualifiedTunnelId,
	parseTunnelPortProtocol,
	parseTunnelPorts,
} from "./dev-tunnel-service";

function commandResult(stdout = "", exitCode = 0) {
	return {
		exitCode,
		stdout,
		stderr: "",
		message: exitCode === 0 ? stdout : "Command failed.",
	};
}

class FakeHost implements DevTunnelHostProcess {
	readonly exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	stopped = false;

	waitForPort(port: number): Promise<{ publicUrl: string }> {
		return Promise.resolve({ publicUrl: `https://moshu-${port}.test.devtunnels.ms` });
	}

	stop(): void {
		this.stopped = true;
		this.exit.resolve(0);
	}
}

class FakeDevTunnelAdapter implements DevTunnelAdapter {
	authenticated = true;
	readonly hosts: FakeHost[] = [];
	readonly deleted: string[] = [];
	readonly hostedTunnelIds: string[] = [];
	ensureCalls = 0;

	isAuthenticated(_signal: AbortSignal): Promise<boolean> {
		return Promise.resolve(this.authenticated);
	}

	startAuthentication(): DevTunnelAuthenticationProcess {
		return {
			completed: Promise.resolve({ exitCode: 0, message: "Authenticated." }),
			onOutput() {
				return () => undefined;
			},
			stop() {},
		};
	}

	ensureTunnel(tunnelId: string, _ports: readonly number[], _signal: AbortSignal): Promise<string> {
		this.ensureCalls += 1;
		return Promise.resolve(tunnelId.includes(".") ? tunnelId : `${tunnelId}.euw`);
	}

	deleteTunnel(tunnelId: string): Promise<void> {
		this.deleted.push(tunnelId);
		return Promise.resolve();
	}

	startHost(tunnelId: string, _ports: readonly number[]): DevTunnelHostProcess {
		this.hostedTunnelIds.push(tunnelId);
		const host = new FakeHost();
		this.hosts.push(host);
		return host;
	}
}

class DelayedAuthAdapter extends FakeDevTunnelAdapter {
	readonly authGate = Promise.withResolvers<boolean>();
	readonly loginGate = Promise.withResolvers<{ exitCode: number; message: string }>();

	override isAuthenticated(signal: AbortSignal): Promise<boolean> {
		const aborted = Promise.withResolvers<boolean>();
		signal.addEventListener(
			"abort",
			() =>
				aborted.reject(
					signal.reason instanceof Error ? signal.reason : new Error("Authentication cancelled."),
				),
			{ once: true },
		);
		return Promise.race([this.authGate.promise, aborted.promise]);
	}

	override startAuthentication(): DevTunnelAuthenticationProcess {
		return {
			completed: this.loginGate.promise,
			onOutput(listener) {
				queueMicrotask(() =>
					listener("Open https://github.com/login/device and enter code ABCD-EFGH"),
				);
				return () => undefined;
			},
			stop: () => this.loginGate.resolve({ exitCode: 1, message: "Stopped." }),
		};
	}
}

class DelayedDeleteAdapter extends FakeDevTunnelAdapter {
	readonly deleteGate = Promise.withResolvers<void>();

	override deleteTunnel(tunnelId: string): Promise<void> {
		this.deleted.push(tunnelId);
		return this.deleteGate.promise;
	}
}

class DelayedEnsureAdapter extends FakeDevTunnelAdapter {
	firstTunnelId: string | undefined;

	override ensureTunnel(
		tunnelId: string,
		_ports: readonly number[],
		signal: AbortSignal,
	): Promise<string> {
		this.ensureCalls += 1;
		if (this.firstTunnelId !== undefined) {
			return Promise.resolve(tunnelId.includes(".") ? tunnelId : `${tunnelId}.euw`);
		}
		this.firstTunnelId = tunnelId;
		return new Promise((_, reject) => {
			signal.addEventListener(
				"abort",
				() =>
					reject(
						signal.reason instanceof Error ? signal.reason : new Error("Tunnel setup cancelled."),
					),
				{ once: true },
			);
		});
	}
}

class DelayedReplacementAdapter extends FakeDevTunnelAdapter {
	readonly replacementGate = Promise.withResolvers<string>();

	override ensureTunnel(
		tunnelId: string,
		_ports: readonly number[],
		signal: AbortSignal,
	): Promise<string> {
		this.ensureCalls += 1;
		if (this.ensureCalls === 1) {
			return Promise.resolve(tunnelId.includes(".") ? tunnelId : `${tunnelId}.euw`);
		}
		const aborted = Promise.withResolvers<string>();
		signal.addEventListener(
			"abort",
			() =>
				aborted.reject(
					signal.reason instanceof Error ? signal.reason : new Error("Replacement cancelled."),
				),
			{ once: true },
		);
		return Promise.race([this.replacementGate.promise, aborted.promise]);
	}
}

class DelayedStopHost extends FakeHost {
	override stop(): void {
		this.stopped = true;
	}
}

class DelayedStopAdapter extends FakeDevTunnelAdapter {
	override startHost(tunnelId: string, _ports: readonly number[]): DevTunnelHostProcess {
		this.hostedTunnelIds.push(tunnelId);
		const host = new DelayedStopHost();
		this.hosts.push(host);
		return host;
	}
}

class RejectedAuthenticationAdapter extends FakeDevTunnelAdapter {
	override startAuthentication(): DevTunnelAuthenticationProcess {
		return {
			completed: Promise.reject(new Error("Authentication output failed.")),
			onOutput() {
				return () => undefined;
			},
			stop() {},
		};
	}
}

class PendingReadyHost implements DevTunnelHostProcess {
	readonly readyGate = Promise.withResolvers<{ publicUrl: string }>();
	readonly exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	stopped = false;

	waitForPort(_port: number): Promise<{ publicUrl: string }> {
		return this.readyGate.promise;
	}

	stop(): void {
		this.stopped = true;
		this.exit.resolve(0);
	}
}

class PendingReadyAdapter extends FakeDevTunnelAdapter {
	readonly pendingHosts: PendingReadyHost[] = [];

	override startHost(tunnelId: string, _ports: readonly number[]): DevTunnelHostProcess {
		this.hostedTunnelIds.push(tunnelId);
		const host = new PendingReadyHost();
		this.pendingHosts.push(host);
		return host;
	}
}

class DelayedPendingReadyHost extends PendingReadyHost {
	override stop(): void {
		this.stopped = true;
	}
}

class CancelledRecreateAdapter extends FakeDevTunnelAdapter {
	readonly replacementHost = new DelayedPendingReadyHost();

	override startHost(tunnelId: string, _ports: readonly number[]): DevTunnelHostProcess {
		this.hostedTunnelIds.push(tunnelId);
		if (this.hostedTunnelIds.length === 2) {
			return this.replacementHost;
		}
		const host = new FakeHost();
		this.hosts.push(host);
		return host;
	}
}

describe("DevTunnelService", () => {
	test("parses CLI authentication, cluster-qualified IDs, and port inventory", () => {
		expect(parseDevTunnelLoginStatus('{"status":"LoggedIn"}')).toBe(true);
		expect(parseDevTunnelLoginStatus('{"Status":"Not logged in"}')).toBe(false);
		expect(
			parseQualifiedTunnelId('{"tunnel":{"tunnelId":"moshu-test","clusterId":"euw"}}', "fallback"),
		).toBe("moshu-test.euw");
		expect(
			parseQualifiedTunnelId(
				'{"tunnel":{"tunnelId":"moshu-test.jpe1","hostConnections":0}}',
				"moshu-test",
			),
		).toBe("moshu-test.jpe1");
		expect(
			findListedTunnelId(
				'{"value":[{"tunnelId":"moshu-other","clusterId":"use"},{"tunnelId":"moshu-test","clusterId":"euw"}]}',
				"moshu-test.euw",
			),
		).toBe("moshu-test.euw");
		expect(
			findListedTunnelId('{"value":[{"tunnelId":"moshu-test","clusterId":"euw"}]}', "moshu-test"),
		).toBe("moshu-test.euw");
		expect(
			findListedTunnelId(
				'{"value":[{"tunnelId":"moshu-test","clusterId":"use"}]}',
				"moshu-test.euw",
			),
		).toBeUndefined();
		expect(
			parseTunnelPorts(
				'{"value":[{"portNumber":41000},{"portNumber":42000},{"portNumber":41000}]}',
			),
		).toEqual([41000, 42000]);
		expect(parseTunnelPortProtocol('{"portNumber":41000,"protocol":"http"}')).toBe("http");
		expect(() => parseTunnelPorts('warning\n{"value":[]}')).toThrow("JSON is invalid");
		expect(() => findListedTunnelId("not-json", "moshu-test.euw")).toThrow(
			"inventory JSON is invalid",
		);
	});

	test("reuses a listed tunnel when its port already matches", async () => {
		const commands: string[][] = [];
		const adapter = new DevTunnelCliAdapter("devtunnel", async (_executable, args) => {
			commands.push([...args]);
			const command = args.join(" ");
			if (command === "list --json") {
				return commandResult('{"value":[{"tunnelId":"moshu-test","clusterId":"euw"}]}');
			}
			if (command === "port list moshu-test.euw --json") {
				return commandResult('{"value":[{"portNumber":41000}]}');
			}
			if (command === "port show moshu-test.euw -p 41000 --json") {
				return commandResult('{"portNumber":41000,"protocol":"http"}');
			}
			if (args[0] === "access") {
				return commandResult();
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		expect(
			await adapter.ensureTunnel("moshu-test.euw", [41_000], new AbortController().signal),
		).toBe("moshu-test.euw");
		expect(commands.some(([command]) => command === "create")).toBe(false);
		expect(
			commands.some(
				([command, operation]) =>
					command === "port" && (operation === "create" || operation === "delete"),
			),
		).toBe(false);
	});

	test("repairs ports on a listed tunnel instead of replacing it", async () => {
		const commands: string[][] = [];
		const adapter = new DevTunnelCliAdapter("devtunnel", async (_executable, args) => {
			commands.push([...args]);
			const command = args.join(" ");
			if (command === "list --json") {
				return commandResult('{"value":[{"tunnelId":"moshu-test","clusterId":"euw"}]}');
			}
			if (command === "port list moshu-test.euw --json") {
				return commandResult('{"value":[{"portNumber":42000}]}');
			}
			if (command === "port show moshu-test.euw -p 41000 --json") {
				return commandResult("", 1);
			}
			if (args[0] === "port" || args[0] === "access") {
				return commandResult();
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		expect(
			await adapter.ensureTunnel("moshu-test.euw", [41_000], new AbortController().signal),
		).toBe("moshu-test.euw");
		expect(commands.some(([command]) => command === "create")).toBe(false);
		expect(commands).toContainEqual(["port", "delete", "moshu-test.euw", "-p", "42000"]);
		expect(commands).toContainEqual([
			"port",
			"create",
			"moshu-test.euw",
			"-p",
			"41000",
			"--protocol",
			"http",
		]);
	});

	test("reconciles an expected port set without deleting a second Moshu ingress", async () => {
		const commands: string[][] = [];
		const adapter = new DevTunnelCliAdapter("devtunnel", async (_executable, args) => {
			commands.push([...args]);
			const command = args.join(" ");
			if (command === "list --json") {
				return commandResult('{"value":[{"tunnelId":"moshu-test","clusterId":"euw"}]}');
			}
			if (command === "port list moshu-test.euw --json") {
				return commandResult(
					'{"value":[{"portNumber":41000},{"portNumber":42000},{"portNumber":43000}]}',
				);
			}
			if (command === "port show moshu-test.euw -p 41000 --json") {
				return commandResult('{"portNumber":41000,"protocol":"http"}');
			}
			if (command === "port show moshu-test.euw -p 42000 --json") {
				return commandResult('{"portNumber":42000,"protocol":"http"}');
			}
			if (args[0] === "port" || args[0] === "access") {
				return commandResult();
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		expect(
			await adapter.ensureTunnel("moshu-test.euw", [41_000, 42_000], new AbortController().signal),
		).toBe("moshu-test.euw");
		// The stale port that no expected ingress claims is removed...
		expect(commands).toContainEqual(["port", "delete", "moshu-test.euw", "-p", "43000"]);
		// ...but neither expected Moshu ingress port is ever deleted (no cross-deletion).
		expect(commands).not.toContainEqual(["port", "delete", "moshu-test.euw", "-p", "41000"]);
		expect(commands).not.toContainEqual(["port", "delete", "moshu-test.euw", "-p", "42000"]);
		// Each expected port keeps its own anonymous access grant.
		expect(commands).toContainEqual([
			"access",
			"create",
			"moshu-test.euw",
			"--port-number",
			"41000",
			"--anonymous",
		]);
		expect(commands).toContainEqual([
			"access",
			"create",
			"moshu-test.euw",
			"--port-number",
			"42000",
			"--anonymous",
		]);
	});

	test("rejects an empty expected port set", async () => {
		const adapter = new DevTunnelCliAdapter("devtunnel", async () => commandResult());
		await expect(
			adapter.ensureTunnel("moshu-test.euw", [], new AbortController().signal),
		).rejects.toThrow("at least one expected ingress port");
	});

	test("creates a tunnel only after a successful inventory confirms it is absent", async () => {
		const commands: string[][] = [];
		const adapter = new DevTunnelCliAdapter("devtunnel", async (_executable, args) => {
			commands.push([...args]);
			const command = args.join(" ");
			if (command === "list --json") {
				return commandResult('{"value":[]}');
			}
			if (command === "create moshu-new --json") {
				return commandResult('{"tunnel":{"tunnelId":"moshu-new","clusterId":"euw"}}');
			}
			if (command === "port list moshu-new.euw --json") {
				return commandResult('{"value":[]}');
			}
			if (command === "port show moshu-new.euw -p 41000 --json") {
				return commandResult("", 1);
			}
			if (args[0] === "port" || args[0] === "access") {
				return commandResult();
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		expect(await adapter.ensureTunnel("moshu-new", [41_000], new AbortController().signal)).toBe(
			"moshu-new.euw",
		);
		expect(commands).toContainEqual(["list", "--json"]);
		expect(commands).toContainEqual(["create", "moshu-new", "--json"]);
	});

	test("does not create a tunnel when listing fails", async () => {
		const commands: string[][] = [];
		const adapter = new DevTunnelCliAdapter("devtunnel", async (_executable, args) => {
			commands.push([...args]);
			throw new Error("Tunnel inventory request failed.");
		});

		await expect(
			adapter.ensureTunnel("moshu-test.euw", [41_000], new AbortController().signal),
		).rejects.toThrow("Tunnel inventory request failed.");
		expect(commands).toEqual([["list", "--json"]]);
	});

	test("persists tunnel identity, hosts the fixed Runtime port, and disables cleanly", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new FakeDevTunnelAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_000,
				adapter,
			});
			const enabled = await service.enable();
			expect(enabled).toMatchObject({
				enabled: true,
				state: "online",
				runtimeIngressPort: 41_000,
				publicUrl: "https://moshu-41000.test.devtunnels.ms",
			});
			expect(enabled.tunnelId).toMatch(/^moshu-/);
			expect(database.remoteAccess.get()).toMatchObject({
				enabled: true,
				tunnelId: enabled.tunnelId,
			});
			if (enabled.tunnelId === undefined) {
				throw new Error("Expected a qualified Dev Tunnel ID.");
			}
			expect(adapter.hostedTunnelIds).toEqual([enabled.tunnelId]);
			expect((await service.disable()).state).toBe("disabled");
			expect(adapter.hosts[0]?.stopped).toBe(true);
		} finally {
			database.close();
		}
	});

	test("stays offline until every expected ingress port is ready, then reports per-port URLs", async () => {
		const database = openAppDatabase(":memory:");

		class GatedHost implements DevTunnelHostProcess {
			readonly gates = new Map<
				number,
				ReturnType<typeof Promise.withResolvers<{ publicUrl: string }>>
			>();
			readonly exit = Promise.withResolvers<number>();
			readonly exited = this.exit.promise;
			stopped = false;

			constructor(ports: readonly number[]) {
				for (const port of ports) {
					this.gates.set(port, Promise.withResolvers<{ publicUrl: string }>());
				}
			}

			waitForPort(port: number): Promise<{ publicUrl: string }> {
				const gate = this.gates.get(port);
				return gate?.promise ?? Promise.reject(new Error(`Unexpected port ${port}.`));
			}

			stop(): void {
				this.stopped = true;
				this.exit.resolve(0);
			}
		}

		class GatedAdapter extends FakeDevTunnelAdapter {
			host: GatedHost | undefined;

			override startHost(tunnelId: string, ports: readonly number[]): DevTunnelHostProcess {
				this.hostedTunnelIds.push(tunnelId);
				this.host = new GatedHost(ports);
				return this.host;
			}
		}

		try {
			const adapter = new GatedAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_000,
				mobileIngressPort: 42_000,
				adapter,
			});
			const enabling = service.enable();
			while (adapter.host === undefined) {
				await Bun.sleep(0);
			}
			// Only the Runtime port is ready; the Mobile ingress is still pending, so we must not come online.
			adapter.host.gates
				.get(41_000)
				?.resolve({ publicUrl: "https://moshu-41000.test.devtunnels.ms" });
			await Bun.sleep(0);
			expect(service.getStatus().state).toBe("starting");
			// Once every expected ingress publishes its URL, the service comes online.
			adapter.host.gates
				.get(42_000)
				?.resolve({ publicUrl: "https://moshu-42000.test.devtunnels.ms" });
			const enabled = await enabling;
			expect(enabled.state).toBe("online");
			// Top-level publicUrl stays backward compatible with the Runtime ingress URL.
			expect(enabled.publicUrl).toBe("https://moshu-41000.test.devtunnels.ms");
			expect(service.getStatus().ingresses).toEqual([
				{
					kind: "runtime",
					port: 41_000,
					ready: true,
					publicUrl: "https://moshu-41000.test.devtunnels.ms",
				},
				{
					kind: "mobile",
					port: 42_000,
					ready: true,
					publicUrl: "https://moshu-42000.test.devtunnels.ms",
				},
			]);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("monitorHostPorts resolves a per-port public URL from a single host stream", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(
					encoder.encode("Connect via browser: https://moshu-41000.euw.devtunnels.ms/\n"),
				);
				controller.enqueue(
					encoder.encode("Connect via browser: https://moshu-42000.euw.devtunnels.ms/\n"),
				);
				controller.close();
			},
		});
		const monitor = monitorHostPorts(stream, [41_000, 42_000]);
		expect((await monitor.waitForPort(41_000)).publicUrl).toBe(
			"https://moshu-41000.euw.devtunnels.ms",
		);
		expect((await monitor.waitForPort(42_000)).publicUrl).toBe(
			"https://moshu-42000.euw.devtunnels.ms",
		);
	});

	test("monitorHostPorts rejects ports whose URL never arrives before the stream ends", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode("Connect via browser: https://moshu-41000.euw.devtunnels.ms/\n"),
				);
				controller.close();
			},
		});
		const monitor = monitorHostPorts(stream, [41_000, 42_000]);
		expect((await monitor.waitForPort(41_000)).publicUrl).toBe(
			"https://moshu-41000.euw.devtunnels.ms",
		);
		await expect(monitor.waitForPort(42_000)).rejects.toThrow(
			"exited before publishing its public URL",
		);
	});

	test("reuses the persisted tunnel identity after disable and enable", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new FakeDevTunnelAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_000,
				adapter,
			});
			const first = await service.enable();
			if (first.tunnelId === undefined) {
				throw new Error("Expected a persisted Dev Tunnel ID.");
			}
			await service.disable();
			const second = await service.enable();
			expect(second.tunnelId).toBe(first.tunnelId);
			expect(adapter.hostedTunnelIds).toEqual([first.tunnelId, first.tunnelId]);
			expect(adapter.ensureCalls).toBe(2);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("persists bounded Runtime traffic estimates and quota warnings", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_010,
				adapter: new FakeDevTunnelAdapter(),
			});
			service.recordTraffic("inbound", 3 * 1024 * 1024 * 1024);
			service.recordTraffic("outbound", 1024 * 1024 * 1024);
			expect(service.getStatus()).toMatchObject({
				trafficEstimate: {
					receivedBytes: 3 * 1024 * 1024 * 1024,
					sentBytes: 1024 * 1024 * 1024,
					totalBytes: 4 * 1024 * 1024 * 1024,
					monthlyLimitBytes: 5 * 1024 * 1024 * 1024,
					warningLevel: "80",
					source: "runtime-rpc-application-payload-estimate",
				},
				serviceLimits: {
					maxTunnelsPerUser: 10,
					maxPortsPerTunnel: 10,
					maxBytesPerSecond: 20 * 1024 * 1024,
				},
			});
			expect(database.remoteAccess.get()).toMatchObject({
				trafficReceivedBytes: 3 * 1024 * 1024 * 1024,
				trafficSentBytes: 1024 * 1024 * 1024,
			});
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("keeps buffered traffic in its ingestion month across UTC rollover", async () => {
		const database = openAppDatabase(":memory:");
		const current = new Date();
		let now = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1) - 1;
		try {
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_010,
				adapter: new FakeDevTunnelAdapter(),
				now: () => now,
			});
			service.recordTraffic("inbound", 100);
			now += 2;
			expect(service.getStatus().trafficEstimate).toMatchObject({
				receivedBytes: 0,
				sentBytes: 0,
			});
			service.recordTraffic("outbound", 200);
			expect(service.getStatus().trafficEstimate).toMatchObject({
				receivedBytes: 0,
				sentBytes: 200,
			});
			await service.shutdown();
			expect(database.remoteAccess.get()).toMatchObject({
				trafficMonth: new Date(now).toISOString().slice(0, 7),
				trafficReceivedBytes: 0,
				trafficSentBytes: 200,
			});
		} finally {
			database.close();
		}
	});

	test("reports auth-required and recreates a persisted tunnel after authentication", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new FakeDevTunnelAdapter();
			adapter.authenticated = false;
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_001,
				adapter,
			});

			expect((await service.enable()).state).toBe("auth_required");
			adapter.authenticated = true;
			const attempt = service.startAuthentication();
			await Bun.sleep(0);
			expect(service.getAuthentication(attempt.attemptId).status).toBe("succeeded");
			expect(service.getStatus().state).toBe("online");
			const original = service.getStatus().tunnelId;
			if (original === undefined) {
				throw new Error("Expected a persisted Dev Tunnel ID.");
			}
			await service.recreate();
			expect(adapter.deleted).toEqual([original]);
			expect(adapter.ensureCalls).toBe(2);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("refreshes and briefly caches the CLI authentication status", async () => {
		const database = openAppDatabase(":memory:");
		let now = Date.now();
		try {
			const adapter = new FakeDevTunnelAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_019,
				adapter,
				now: () => now,
			});
			expect(service.getStatus().authenticated).toBe(false);
			expect((await service.refreshAuthentication()).authenticated).toBe(true);

			adapter.authenticated = false;
			expect((await service.refreshAuthentication()).authenticated).toBe(true);

			now += 5_000;
			expect((await service.refreshAuthentication()).authenticated).toBe(false);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("exposes device-code output while authentication remains active", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedAuthAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_002,
				adapter,
			});
			const attempt = service.startAuthentication();
			await Bun.sleep(0);
			expect(service.getAuthentication(attempt.attemptId)).toMatchObject({
				status: "running",
				message: expect.stringContaining("ABCD-EFGH"),
			});
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("does not start a host after disable fences a delayed enable", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedAuthAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_003,
				adapter,
			});
			const enabling = service.enable();
			await Bun.sleep(0);
			const disabling = service.disable();
			adapter.authGate.resolve(true);
			await Promise.all([enabling, disabling]);
			expect(adapter.hosts).toHaveLength(0);
			expect(service.getStatus()).toMatchObject({ enabled: false, state: "disabled" });
		} finally {
			database.close();
		}
	});

	test("cancels stale tunnel setup before recreating and persisting a replacement", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedEnsureAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_005,
				adapter,
			});
			const enabling = service.enable();
			await Bun.sleep(0);
			const staleTunnelId = database.remoteAccess.get().tunnelId;
			if (staleTunnelId === undefined) {
				throw new Error("Expected the pending Dev Tunnel ID to be persisted.");
			}
			if (adapter.firstTunnelId === undefined) {
				throw new Error("Expected tunnel reconciliation to have started.");
			}
			expect(staleTunnelId).toBe(adapter.firstTunnelId);
			const recreating = service.recreate();
			await Promise.all([enabling, recreating]);
			const replacement = service.getStatus().tunnelId;
			if (replacement === undefined) {
				throw new Error("Expected the replacement Dev Tunnel ID.");
			}
			expect(adapter.deleted).toEqual([staleTunnelId]);
			expect(replacement).not.toBe(staleTunnelId);
			expect(adapter.hostedTunnelIds).toEqual([replacement]);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("does not report disabled until the public host has exited", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedStopAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_006,
				adapter,
			});
			await service.enable();
			let disabled = false;
			const disabling = service.disable().then((status) => {
				disabled = true;
				return status;
			});
			await Bun.sleep(0);
			expect(disabled).toBe(false);
			expect(service.getStatus()).toMatchObject({ enabled: false, state: "stopping" });
			await service.start();
			expect(disabled).toBe(false);
			adapter.hosts[0]?.exit.resolve(0);
			expect((await disabling).state).toBe("disabled");
		} finally {
			database.close();
		}
	});

	test("disable interrupts host readiness and terminates the public host", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new PendingReadyAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_009,
				adapter,
			});
			const enabling = service.enable();
			await Bun.sleep(0);
			expect(adapter.pendingHosts).toHaveLength(1);
			const disabling = service.disable();
			await Promise.all([enabling, disabling]);
			expect(adapter.pendingHosts[0]?.stopped).toBe(true);
			expect(service.getStatus()).toMatchObject({ enabled: false, state: "disabled" });
		} finally {
			database.close();
		}
	});

	test("manual retry replaces a stale restart timer", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new FakeDevTunnelAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_007,
				adapter,
			});
			await service.enable();
			adapter.hosts[0]?.exit.resolve(1);
			await Bun.sleep(0);
			await service.enable();
			adapter.hosts[1]?.exit.resolve(1);
			await Bun.sleep(1_100);
			expect(adapter.hosts).toHaveLength(3);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("records authentication process rejection and rejects work after shutdown", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new RejectedAuthenticationAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_008,
				adapter,
			});
			const attempt = service.startAuthentication();
			await Bun.sleep(0);
			expect(service.getAuthentication(attempt.attemptId)).toMatchObject({
				status: "failed",
				message: "Authentication output failed.",
			});
			await service.shutdown();
			expect(() => service.startAuthentication()).toThrow("shutting down");
			await expect(service.enable()).rejects.toThrow("shutting down");
		} finally {
			database.close();
		}
	});

	test("serializes recreate with a concurrent enable", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedDeleteAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_004,
				adapter,
			});
			await service.enable();
			const recreating = service.recreate();
			await Bun.sleep(0);
			const enabling = service.enable();
			adapter.deleteGate.resolve();
			await Promise.all([recreating, enabling]);
			expect(adapter.deleted).toHaveLength(1);
			expect(service.getStatus().state).toBe("online");
			const activeHost = adapter.hosts.at(-1);
			activeHost?.exit.resolve(1);
			await Bun.sleep(1_100);
			expect(adapter.hosts.length).toBeGreaterThan(2);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("coalesces concurrent recreates after the first deletion succeeds", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedDeleteAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_010,
				adapter,
			});
			await service.enable();
			const first = service.recreate();
			await Bun.sleep(0);
			const second = service.recreate();
			adapter.deleteGate.resolve();
			await Promise.all([first, second]);
			expect(adapter.deleted).toHaveLength(1);
			expect(service.getStatus().state).toBe("online");
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("coalesces concurrent recreates while replacement setup is pending", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedReplacementAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_011,
				adapter,
			});
			await service.enable();
			const first = service.recreate();
			await Bun.sleep(0);
			expect(adapter.ensureCalls).toBe(2);
			const second = service.recreate();
			adapter.replacementGate.resolve("moshu-replacement.euw");
			const [firstStatus, secondStatus] = await Promise.all([first, second]);
			expect(firstStatus).toEqual(secondStatus);
			expect(adapter.deleted).toHaveLength(1);
			expect(adapter.ensureCalls).toBe(2);
			expect(service.getStatus()).toMatchObject({
				state: "online",
				tunnelId: "moshu-replacement.euw",
			});
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("keeps a coalesced recreate alive while another caller is still waiting", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedReplacementAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_014,
				adapter,
			});
			await service.enable();
			const firstController = new AbortController();
			const secondController = new AbortController();
			const first = service.recreate(firstController.signal);
			const firstOutcome = first.then(
				(status) => ({ status, error: undefined }),
				(error: unknown) => ({ status: undefined, error }),
			);
			await Bun.sleep(0);
			const second = service.recreate(secondController.signal);
			firstController.abort(new Error("First caller disconnected."));
			adapter.replacementGate.resolve("moshu-shared-replacement.euw");
			const outcome = await firstOutcome;
			expect(outcome.status).toBeUndefined();
			expect(outcome.error).toBeInstanceOf(Error);
			if (!(outcome.error instanceof Error)) {
				throw new Error("Expected the first recreate caller to be cancelled.");
			}
			expect(outcome.error.message).toBe("First caller disconnected.");
			expect(await second).toMatchObject({
				enabled: true,
				state: "online",
				tunnelId: "moshu-shared-replacement.euw",
			});
			expect(adapter.ensureCalls).toBe(2);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("does not coalesce recreate across an intervening disable", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedDeleteAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_012,
				adapter,
			});
			await service.enable();
			const first = service.recreate();
			await Bun.sleep(0);
			const disabling = service.disable();
			const second = service.recreate();
			adapter.deleteGate.resolve();
			await Promise.all([first, disabling, second]);
			expect(adapter.deleted).toHaveLength(1);
			expect(service.getStatus().state).toBe("online");
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("cancels an in-flight enable when its caller aborts", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new PendingReadyAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_013,
				adapter,
			});
			const controller = new AbortController();
			const enabling = service.enable(controller.signal);
			await Bun.sleep(0);
			expect(adapter.pendingHosts).toHaveLength(1);
			controller.abort(new Error("Caller disconnected."));
			await expect(enabling).rejects.toThrow("Caller disconnected.");
			expect(adapter.pendingHosts[0]?.stopped).toBe(true);
			expect(service.getStatus()).toMatchObject({ enabled: false, state: "disabled" });
		} finally {
			database.close();
		}
	});

	test("does not commit online when readiness and cancellation race", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new PendingReadyAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_017,
				adapter,
			});
			const controller = new AbortController();
			const outcome = service.enable(controller.signal).then(
				(status) => ({ status, error: undefined }),
				(error: unknown) => ({ status: undefined, error }),
			);
			await Bun.sleep(0);
			const host = adapter.pendingHosts[0];
			host?.readyGate.resolve({ publicUrl: "https://race.test.devtunnels.ms" });
			controller.abort(new Error("Caller cancelled at readiness."));
			const settled = await outcome;
			expect(settled.status).toBeUndefined();
			expect(host?.stopped).toBe(true);
			await Bun.sleep(0);
			expect(service.getStatus()).toMatchObject({ enabled: false, state: "disabled" });
		} finally {
			database.close();
		}
	});

	test("enable does not join cleanup from a cancelled recreate", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new CancelledRecreateAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_018,
				adapter,
			});
			await service.enable();
			const controller = new AbortController();
			const recreateOutcome = service.recreate(controller.signal).then(
				(status) => ({ status, error: undefined }),
				(error: unknown) => ({ status: undefined, error }),
			);
			await Bun.sleep(0);
			const enabling = service.enable();
			controller.abort(new Error("Recreate caller disconnected."));
			await Bun.sleep(0);
			adapter.replacementHost.exit.resolve(0);
			const recreated = await recreateOutcome;
			expect(recreated.status).toBeUndefined();
			expect(await enabling).toMatchObject({ enabled: true, state: "online" });
			expect(adapter.hostedTunnelIds).toHaveLength(3);
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("keeps a shared enable alive while another caller is still waiting", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedAuthAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_015,
				adapter,
			});
			const firstController = new AbortController();
			const secondController = new AbortController();
			const firstOutcome = service.enable(firstController.signal).then(
				(status) => ({ status, error: undefined }),
				(error: unknown) => ({ status: undefined, error }),
			);
			await Bun.sleep(0);
			const second = service.enable(secondController.signal);
			firstController.abort(new Error("First enable caller disconnected."));
			adapter.authGate.resolve(true);
			const outcome = await firstOutcome;
			expect(outcome.status).toBeUndefined();
			if (!(outcome.error instanceof Error)) {
				throw new Error("Expected the first enable caller to be cancelled.");
			}
			expect(outcome.error.message).toBe("First enable caller disconnected.");
			expect(await second).toMatchObject({ enabled: true, state: "online" });
			await service.shutdown();
		} finally {
			database.close();
		}
	});

	test("does not let a retry join an already-cancelled recreate", async () => {
		const database = openAppDatabase(":memory:");
		try {
			const adapter = new DelayedDeleteAdapter();
			const service = new DevTunnelService({
				repository: database.remoteAccess,
				runtimeIngressPort: 41_016,
				adapter,
			});
			await service.enable();
			const controller = new AbortController();
			const cancelledOutcome = service.recreate(controller.signal).then(
				(status) => ({ status, error: undefined }),
				(error: unknown) => ({ status: undefined, error }),
			);
			await Bun.sleep(0);
			controller.abort(new Error("Recreate caller disconnected."));
			await Bun.sleep(0);
			const retry = service.recreate();
			adapter.deleteGate.resolve();
			const outcome = await cancelledOutcome;
			expect(outcome.status).toBeUndefined();
			if (!(outcome.error instanceof Error)) {
				throw new Error("Expected the first recreate caller to be cancelled.");
			}
			expect(outcome.error.message).toBe("Recreate caller disconnected.");
			expect(await retry).toMatchObject({ enabled: true, state: "online" });
			await service.shutdown();
		} finally {
			database.close();
		}
	});
});
