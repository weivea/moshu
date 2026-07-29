import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxServerChallengePayload,
	productRpcMethods,
	runtimeBoxRegisterInputSchema,
	type RuntimeBoxChallengeInput,
} from "@moshu/contracts";
import { rpcJsonValueSchema } from "@moshu/process-rpc";

import {
	calculateRemoteReconnectDelayMs,
	pairRemoteRuntimeBox,
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

	test("authenticates, registers as remote, and exits when aborted", async () => {
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
			let issuedChallenge:
				| {
						challengeId: string;
						nonce: string;
						expiresAt: string;
						agentServerId: string;
						rpcIdentity: typeof rpcIdentity;
						actionJournalEpoch: string;
				  }
				| undefined;
			const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
				challengeInput = JSON.parse(String(init?.body)) as RuntimeBoxChallengeInput;
				issuedChallenge = {
					challengeId: "550e8400-e29b-41d4-a716-446655440002",
					nonce: Buffer.alloc(32, 5).toString("base64url"),
					expiresAt: new Date(Date.now() + 30_000).toISOString(),
					agentServerId: config.agentServerId,
					rpcIdentity,
					actionJournalEpoch: "550e8400-e29b-41d4-a716-446655440099",
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
				sleep: async () => {},
			});
			expect(registered).toBe(true);
			expect(state.read().generation).toBe(1);
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

	test("caps reconnect delay at thirty seconds with bounded jitter", () => {
		expect([0, 1, 2, 3, 4, 5].map((attempt) => calculateRemoteReconnectDelayMs(attempt))).toEqual([
			1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
		]);
		expect(calculateRemoteReconnectDelayMs(6, () => 0)).toBe(24_000);
		expect(calculateRemoteReconnectDelayMs(100, () => 1)).toBe(36_000);
	});
});
