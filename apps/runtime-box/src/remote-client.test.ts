import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxCompatibilityReportPayload,
	createRuntimeBoxServerChallengePayload,
	createExecutorToolParameterPayload,
	productRpcMethods,
	runtimeBoxChallengeOutputSchema,
	runtimeBoxCompatibilityReportInputSchema,
	runtimeBoxRegisterInputSchema,
	type RuntimeBoxChallengeInput,
} from "@moshu/contracts";
import {
	RpcConnectionClosedError,
	type RpcPeer,
	type RpcRequestContext,
	type RpcRequestHandler,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import {
	calculateRemoteReconnectDelayMs,
	pairRemoteRuntimeBox,
	RemoteRuntimePermanentError,
	RemoteRuntimeUpgradeRequiredError,
	runRemoteRuntimeBox,
} from "./remote-client";
import { RemoteRuntimeBoxState } from "./remote-state";
import { ExecutorToolRuntime } from "./tools";

describe("Remote Runtime Box client", () => {
	test("claims pairing, waits for approval, and persists pinned identities", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-pair-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			const server = generateKeyPairSync("ed25519");
			const agentServerPublicKey = server.publicKey
				.export({ format: "der", type: "spki" })
				.toString("base64url");
			let statusCalls = 0;
			let now = 1_000;
			const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const body = JSON.parse(String(init?.body));
				if (url.endsWith("/runtime-pair/claim")) {
					expect(body.code).toBe("pair-code");
					return Response.json({
						pairingId: "550e8400-e29b-41d4-a716-446655440001",
						claimToken: Buffer.alloc(32, 4).toString("base64url"),
						status: "pending_approval",
					});
				}
				statusCalls += 1;
				return Response.json(
					statusCalls === 1
						? { status: "pending_approval" }
						: {
								status: "approved",
								runtimeBoxId: "remote-box",
								agentServerId: "550e8400-e29b-41d4-a716-446655440000",
								agentServerPublicKey,
							},
				);
			};
			const config = await pairRemoteRuntimeBox({
				state,
				runtimeBaseUrl: "https://runtime.example/",
				code: "pair-code",
				fetch: fetcher,
				now: () => now,
				sleep: async (milliseconds) => {
					now += milliseconds;
				},
			});
			expect(config.runtimeBaseUrl).toBe("https://runtime.example");
			expect(config.runtimeBoxId).toBe("remote-box");
			expect(state.read().privateKey).not.toBe(config.publicKey);
			expect(statusCalls).toBe(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("treats HTTP 426 as a permanent upgrade-required failure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-upgrade-required-"));
		try {
			await expect(
				pairRemoteRuntimeBox({
					state: new RemoteRuntimeBoxState(directory),
					runtimeBaseUrl: "https://runtime.example/",
					code: "pair-code",
					fetch: async () =>
						Response.json(
							{
								error: "RUNTIME_BOX_UPGRADE_REQUIRED",
								minProtocolVersion: 2,
								maxProtocolVersion: 2,
							},
							{ status: 426 },
						),
				}),
			).rejects.toBeInstanceOf(RemoteRuntimePermanentError);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reports a signed incompatible run and preserves upgrade-required", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-upgrade-report-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			const device = generateKeyPairSync("ed25519");
			const server = generateKeyPairSync("ed25519");
			const config = {
				schemaVersion: 1 as const,
				runtimeBaseUrl: "https://runtime.example",
				runtimeBoxId: "remote-box",
				deviceKeyId: "device-key",
				publicKey: device.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
				privateKey: device.privateKey
					.export({ format: "der", type: "pkcs8" })
					.toString("base64url"),
				agentServerId: "550e8400-e29b-41d4-a716-446655440000",
				agentServerPublicKey: server.publicKey
					.export({ format: "der", type: "spki" })
					.toString("base64url"),
				generation: 0,
				displayName: "Remote Test",
			};
			state.write(config);
			let reports = 0;
			await expect(
				runRemoteRuntimeBox({
					state,
					toolRuntime: new ExecutorToolRuntime({ rg: "/unused/rg", fd: "/unused/fd" }),
					signal: new AbortController().signal,
					fetch: async (input, init) => {
						const url = String(input);
						if (url.endsWith("/runtime-auth/challenge")) {
							return Response.json(
								{
									error: "RUNTIME_BOX_UPGRADE_REQUIRED",
									minProtocolVersion: 2,
									maxProtocolVersion: 2,
								},
								{ status: 426 },
							);
						}
						expect(url).toEndWith("/runtime-auth/compatibility");
						reports += 1;
						const report = runtimeBoxCompatibilityReportInputSchema.parse(
							JSON.parse(String(init?.body)),
						);
						const { signature, ...unsigned } = report;
						expect(report).toMatchObject({
							runtimeBoxId: "remote-box",
							deviceKeyId: "device-key",
							generation: 1,
							protocolVersion: 1,
						});
						expect(
							verify(
								null,
								Buffer.from(
									createRuntimeBoxCompatibilityReportPayload(config.agentServerId, unsigned),
									"utf8",
								),
								device.publicKey,
								Buffer.from(signature, "base64url"),
							),
						).toBe(true);
						return Response.json({
							accepted: true,
							requiredProtocolMinVersion: 2,
							requiredProtocolMaxVersion: 2,
						});
					},
					connect: async () => {
						throw new Error("Incompatible Runtime Box must not attempt WebSocket.");
					},
				}),
			).rejects.toBeInstanceOf(RemoteRuntimeUpgradeRequiredError);
			expect(reports).toBe(1);
			expect(state.read().generation).toBe(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("cancels a stalled compatibility report during shutdown", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-upgrade-report-cancel-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			const device = generateKeyPairSync("ed25519");
			const server = generateKeyPairSync("ed25519");
			state.write({
				schemaVersion: 1,
				runtimeBaseUrl: "https://runtime.example",
				runtimeBoxId: "remote-box",
				deviceKeyId: "device-key",
				publicKey: device.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
				privateKey: device.privateKey
					.export({ format: "der", type: "pkcs8" })
					.toString("base64url"),
				agentServerId: "550e8400-e29b-41d4-a716-446655440000",
				agentServerPublicKey: server.publicKey
					.export({ format: "der", type: "spki" })
					.toString("base64url"),
				generation: 0,
				displayName: "Remote Test",
			});
			const controller = new AbortController();
			let reportStartedResolve: (() => void) | undefined;
			const reportStarted = new Promise<void>((resolve) => {
				reportStartedResolve = resolve;
			});
			const run = runRemoteRuntimeBox({
				state,
				toolRuntime: new ExecutorToolRuntime({ rg: "/unused/rg", fd: "/unused/fd" }),
				signal: controller.signal,
				fetch: async (input, init) => {
					if (String(input).endsWith("/runtime-auth/challenge")) {
						return Response.json({}, { status: 426 });
					}
					reportStartedResolve?.();
					return new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason ?? new Error("aborted")),
							{ once: true },
						);
					});
				},
			});
			await reportStarted;
			controller.abort(new Error("shutdown"));
			await expect(run).resolves.toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("recovers from transient network loss, authenticates, and registers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-run-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			const device = generateKeyPairSync("ed25519");
			const server = generateKeyPairSync("ed25519");
			const config = {
				schemaVersion: 1 as const,
				runtimeBaseUrl: "http://127.0.0.1:40123",
				runtimeBoxId: "remote-box",
				deviceKeyId: "device-key",
				publicKey: device.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
				privateKey: device.privateKey
					.export({ format: "der", type: "pkcs8" })
					.toString("base64url"),
				agentServerId: "550e8400-e29b-41d4-a716-446655440000",
				agentServerPublicKey: server.publicKey
					.export({ format: "der", type: "spki" })
					.toString("base64url"),
				generation: 0,
				displayName: "Remote Test",
			};
			state.write(config);
			const controller = new AbortController();
			const rpcIdentity = {
				role: "agents" as const,
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 4,
			};
			let challengeInput: RuntimeBoxChallengeInput | undefined;
			let fetchAttempts = 0;
			const reconnectDelays: number[] = [];
			let issuedChallenge:
				| {
						challengeId: string;
						nonce: string;
						expiresAt: string;
						agentServerId: string;
						rpcIdentity: typeof rpcIdentity;
						actionJournalEpoch: string;
						negotiatedProtocolVersion: 1;
						transportSecurity: "relay-tls";
						supportedTransportSecurity: Array<"relay-tls" | "noise-xx">;
				  }
				| undefined;
			const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
				fetchAttempts += 1;
				if (fetchAttempts === 1) {
					throw new Error("simulated network suspension");
				}
				challengeInput = JSON.parse(String(init?.body)) as RuntimeBoxChallengeInput;
				issuedChallenge = {
					challengeId: "550e8400-e29b-41d4-a716-446655440002",
					nonce: Buffer.alloc(32, 5).toString("base64url"),
					expiresAt: new Date(Date.now() + 30_000).toISOString(),
					agentServerId: config.agentServerId,
					rpcIdentity,
					actionJournalEpoch: "550e8400-e29b-41d4-a716-446655440099",
					negotiatedProtocolVersion: 1,
					transportSecurity: "relay-tls",
					supportedTransportSecurity: ["relay-tls"],
				};
				return Response.json({
					...issuedChallenge,
					signature: sign(
						null,
						Buffer.from(
							createRuntimeBoxServerChallengePayload(challengeInput, issuedChallenge),
							"utf8",
						),
						server.privateKey,
					).toString("base64url"),
				});
			};
			let registered = false;
			await runRemoteRuntimeBox({
				state,
				toolRuntime: new ExecutorToolRuntime({ rg: "/unused/rg", fd: "/unused/fd" }),
				signal: controller.signal,
				fetch: fetcher,
				connect: async (options) => {
					const headers = new Headers(await options.getHandshakeHeaders?.());
					if (challengeInput === undefined || issuedChallenge === undefined) {
						throw new Error("Challenge was not requested.");
					}
					const signature = headers.get("x-moshu-signature");
					if (signature === null) {
						throw new Error("Device signature is missing.");
					}
					expect(
						verify(
							null,
							Buffer.from(
								createRuntimeBoxAuthenticationPayload(challengeInput, issuedChallenge),
								"utf8",
							),
							device.publicKey,
							Buffer.from(signature, "base64url"),
						),
					).toBe(true);
					expect(options.identity.peerId).toBe("remote-box");
					expect(options.expectedServerIdentity).toEqual(rpcIdentity);
					return {
						closed: Promise.resolve(),
						close() {},
						async request(method, payload) {
							if (method === productRpcMethods.runtimeBoxRegister) {
								const input = runtimeBoxRegisterInputSchema.parse(payload);
								expect(input.runtimeBox.kind).toBe("remote");
							} else {
								expect(method).toBe(productRpcMethods.runtimeBoxReady);
								registered = true;
								controller.abort();
							}
							return rpcJsonValueSchema.parse({
								schemaVersion: 1,
								accepted: true,
								runtimeBoxId: "remote-box",
							});
						},
					};
				},
				sleep: async (milliseconds) => {
					reconnectDelays.push(milliseconds);
				},
			});
			expect(registered).toBe(true);
			expect(fetchAttempts).toBe(2);
			expect(reconnectDelays).toEqual([1_000]);
			expect(state.read().generation).toBe(2);
			expect(
				createPublicKey({
					key: Buffer.from(config.publicKey, "base64url"),
					format: "der",
					type: "spki",
				}).asymmetricKeyType,
			).toBe("ed25519");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("cancels and drains a surviving Action before a permanent reconnect failure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "moshu-remote-permanent-failure-"));
		try {
			const state = new RemoteRuntimeBoxState(directory);
			const device = generateKeyPairSync("ed25519");
			const server = generateKeyPairSync("ed25519");
			const config = {
				schemaVersion: 1 as const,
				runtimeBaseUrl: "http://127.0.0.1:40123",
				runtimeBoxId: "remote-box",
				deviceKeyId: "device-key",
				publicKey: device.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
				privateKey: device.privateKey
					.export({ format: "der", type: "pkcs8" })
					.toString("base64url"),
				agentServerId: "550e8400-e29b-41d4-a716-446655440000",
				agentServerPublicKey: server.publicKey
					.export({ format: "der", type: "spki" })
					.toString("base64url"),
				generation: 0,
				displayName: "Remote Test",
			};
			state.write(config);
			const rpcIdentity = {
				role: "agents" as const,
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 4,
			};
			const peerClosed = Promise.withResolvers<void>();
			const online = Promise.withResolvers<void>();
			const actionStarted = Promise.withResolvers<void>();
			let actionSignal: AbortSignal | undefined;
			let challengeCalls = 0;
			let invokeTool: RpcRequestHandler | undefined;
			let targetIdentity:
				| {
						role: "runtime-box";
						peerId: string;
						instanceId: string;
						generation: number;
						deviceKeyId: string;
				  }
				| undefined;
			const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
				challengeCalls += 1;
				if (challengeCalls > 1) {
					return new Response(null, { status: 401 });
				}
				const challengeInput = JSON.parse(String(init?.body)) as RuntimeBoxChallengeInput;
				const challenge = runtimeBoxChallengeOutputSchema.omit({ signature: true }).parse({
					challengeId: "550e8400-e29b-41d4-a716-446655440002",
					nonce: Buffer.alloc(32, 5).toString("base64url"),
					expiresAt: new Date(Date.now() + 30_000).toISOString(),
					agentServerId: config.agentServerId,
					rpcIdentity,
					actionJournalEpoch: "550e8400-e29b-41d4-a716-446655440099",
					negotiatedProtocolVersion: 1,
					transportSecurity: "relay-tls",
					supportedTransportSecurity: ["relay-tls"],
				});
				return Response.json({
					...challenge,
					signature: sign(
						null,
						Buffer.from(createRuntimeBoxServerChallengePayload(challengeInput, challenge), "utf8"),
						server.privateKey,
					).toString("base64url"),
				});
			};
			const runtime = {
				async execute(_input: unknown, options: { signal: AbortSignal }) {
					actionSignal = options.signal;
					actionStarted.resolve();
					await new Promise<never>((_resolve, reject) => {
						const abort = () => reject(options.signal.reason);
						options.signal.addEventListener("abort", abort, { once: true });
						if (options.signal.aborted) {
							abort();
						}
					});
				},
			} as unknown as ExecutorToolRuntime;
			const controller = new AbortController();
			const run = runRemoteRuntimeBox({
				state,
				toolRuntime: runtime,
				signal: controller.signal,
				fetch: fetcher,
				connect: async (options) => {
					invokeTool = options.handlers?.requests?.[productRpcMethods.runtimeBoxToolInvoke];
					targetIdentity = options.identity as typeof targetIdentity;
					return {
						closed: peerClosed.promise,
						close() {},
						async request() {
							return rpcJsonValueSchema.parse({
								schemaVersion: 1,
								accepted: true,
								runtimeBoxId: config.runtimeBoxId,
							});
						},
					};
				},
				sleep: async () => {},
				onState(status) {
					if (status === "online") {
						online.resolve();
					}
				},
			});
			const runOutcome = run.then(
				() => undefined,
				(error: unknown) => error,
			);
			await online.promise;
			if (invokeTool === undefined || targetIdentity === undefined) {
				throw new Error("Remote Runtime Box tool handler was not installed.");
			}
			const parameters = {
				schemaVersion: 1 as const,
				invocationId: crypto.randomUUID(),
				runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
				toolCallId: "permanent-reconnect-failure",
				cwd: "/server/workspace",
				call: { tool: "read" as const, arguments: { path: "README.md" } },
			};
			const requestController = new AbortController();
			const contextPeer = {
				remoteIdentity: rpcIdentity,
				localIdentity: targetIdentity,
				isClosed: false,
				emitEvent() {},
			} as unknown as RpcPeer;
			const context: RpcRequestContext = {
				peer: contextPeer,
				remoteIdentity: rpcIdentity,
				signal: requestController.signal,
				traceId: "permanent-reconnect-failure",
				requestId: "permanent-reconnect-failure",
				method: productRpcMethods.runtimeBoxToolInvoke,
				deadlineAt: Date.now() + 60_000,
			};
			const action = invokeTool(
				{
					...parameters,
					authorization: {
						actionId: crypto.randomUUID(),
						grantId: crypto.randomUUID(),
						grantToken: Buffer.alloc(32, 7).toString("base64url"),
						parameterDigest: createHash("sha256")
							.update(createExecutorToolParameterPayload(parameters))
							.digest("hex"),
						originInstanceId: rpcIdentity.instanceId,
						originGeneration: rpcIdentity.generation,
						targetRuntimeBoxId: targetIdentity.peerId,
						targetInstanceId: targetIdentity.instanceId,
						targetGeneration: targetIdentity.generation,
						executionScope: "runtime-box-workspace",
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				},
				context,
			);
			const actionOutcome = Promise.resolve(action).then(
				() => undefined,
				(error: unknown) => error,
			);
			await actionStarted.promise;

			requestController.abort(new RpcConnectionClosedError(1006, "transport lost"));
			peerClosed.resolve();
			const [runError, actionError] = await Promise.all([runOutcome, actionOutcome]);

			expect(runError).toBeInstanceOf(RemoteRuntimePermanentError);
			expect(actionError).toMatchObject({ code: "RUNTIME_BOX_TOOL_CANCELLED" });
			expect(actionSignal?.aborted).toBe(true);
			expect(challengeCalls).toBe(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("caps reconnect delay at thirty seconds with bounded jitter", () => {
		expect([0, 1, 2, 3, 4, 5].map((attempt) => calculateRemoteReconnectDelayMs(attempt))).toEqual([
			1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
		]);
		expect(calculateRemoteReconnectDelayMs(6, () => 0)).toBe(24_000);
		expect(calculateRemoteReconnectDelayMs(100, () => 1)).toBe(36_000);
	});
});
