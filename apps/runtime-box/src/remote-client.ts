import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import { join } from "node:path";
import {
	agentsRuntimeBoxRequestMethods,
	claimRuntimeBoxPairingOutputSchema,
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxServerChallengePayload,
	executorToolNames,
	executorToolRpcTimeoutMs,
	productRpcMaxBufferedOutboundBytes,
	productRpcMaxFrameBytes,
	productRpcMethods,
	runtimeBoxChallengeOutputSchema,
	runtimeBoxPairingStatusOutputSchema,
	runtimeBoxRegisterInputSchema,
	runtimeBoxRegisterOutputSchema,
	type ProcessPeerIdentity,
} from "@moshu/contracts";
import {
	type ConnectRpcClientOptions,
	connectRpcClient,
	RpcHandshakeError,
	type RpcPeer,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import {
	createExecutorToolRequestHandler,
	createInvocationAcknowledgementHandler,
} from "./tool-handler";
import {
	reconcileInvocationJournal,
	RuntimeBoxInvocationJournal,
	watchInvocationReconciliation,
} from "./invocation-journal";
import { validateProjectPathRequestHandler } from "./project-path";
import type { RemoteRuntimeBoxConfig, RemoteRuntimeBoxState } from "./remote-state";
import { normalizeRuntimeBaseUrl } from "./remote-state";
import type { ExecutorToolRuntime } from "./tools";

const stableConnectionMs = 30_000;
const reconnectDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RemoteRuntimeRpcPeer {
	readonly closed: Promise<unknown>;
	close: RpcPeer["close"];
	request: RpcPeer["request"];
}

export class RemoteRuntimePermanentError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RemoteRuntimePermanentError";
	}
}

export interface PairRemoteRuntimeBoxOptions {
	state: RemoteRuntimeBoxState;
	runtimeBaseUrl: string;
	code: string;
	displayName?: string;
	fetch?: RuntimeFetch;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	onStatus?: (status: string) => void;
}

export async function pairRemoteRuntimeBox(
	options: PairRemoteRuntimeBoxOptions,
): Promise<RemoteRuntimeBoxConfig> {
	if (options.state.isPaired()) {
		throw new Error("Remote Runtime Box is already paired; unpair it before pairing again.");
	}
	const fetcher = options.fetch ?? globalThis.fetch;
	const sleep = options.sleep ?? Bun.sleep;
	const now = options.now ?? Date.now;
	const runtimeBaseUrl = normalizeRuntimeBaseUrl(options.runtimeBaseUrl);
	const device = generateKeyPairSync("ed25519");
	const deviceKeyId = randomUUID();
	const deadline = now() + 5 * 60_000;
	const publicKey = device.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
	const privateKey = device.privateKey
		.export({ format: "der", type: "pkcs8" })
		.toString("base64url");
	const claim = claimRuntimeBoxPairingOutputSchema.parse(
		await postJson(
			fetcher,
			runtimeBaseUrl,
			"/runtime-pair/claim",
			{
				code: options.code,
				deviceKeyId,
				publicKey,
				displayName: options.displayName ?? defaultDisplayName(),
				platform: requireSupportedPlatform(process.platform),
				arch: process.arch,
			},
			AbortSignal.timeout(30_000),
		),
	);
	options.onStatus?.("pending_approval");
	while (now() < deadline) {
		const remaining = Math.max(1, deadline - now());
		const status = runtimeBoxPairingStatusOutputSchema.parse(
			await postJson(
				fetcher,
				runtimeBaseUrl,
				"/runtime-pair/status",
				{
					pairingId: claim.pairingId,
					claimToken: claim.claimToken,
				},
				AbortSignal.timeout(remaining),
			),
		);
		if (status.status === "approved") {
			const serverPublicKey = createPublicKey({
				key: Buffer.from(status.agentServerPublicKey, "base64url"),
				format: "der",
				type: "spki",
			});
			if (serverPublicKey.asymmetricKeyType !== "ed25519") {
				throw new Error("Agent Server pairing identity must use Ed25519.");
			}
			const config: RemoteRuntimeBoxConfig = {
				schemaVersion: 1,
				runtimeBaseUrl,
				runtimeBoxId: status.runtimeBoxId,
				deviceKeyId,
				publicKey,
				privateKey,
				agentServerId: status.agentServerId,
				agentServerPublicKey: status.agentServerPublicKey,
				generation: 0,
				displayName: options.displayName ?? defaultDisplayName(),
			};
			options.state.write(config);
			options.onStatus?.("approved");
			return config;
		}
		if (status.status === "rejected" || status.status === "expired") {
			throw new RemoteRuntimePermanentError(`Runtime Box pairing ${status.status}.`);
		}
		await sleep(2_000);
	}
	throw new RemoteRuntimePermanentError("Runtime Box pairing approval timed out.");
}

export interface RunRemoteRuntimeBoxOptions {
	state: RemoteRuntimeBoxState;
	toolRuntime: ExecutorToolRuntime;
	signal: AbortSignal;
	fetch?: RuntimeFetch;
	connect?: (options: ConnectRpcClientOptions) => Promise<RemoteRuntimeRpcPeer>;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
	onState?: (state: "connecting" | "online" | "disconnected") => void;
}

export async function runRemoteRuntimeBox(options: RunRemoteRuntimeBoxOptions): Promise<void> {
	const fetcher = options.fetch ?? globalThis.fetch;
	const connect = options.connect ?? connectRpcClient;
	const sleep = options.sleep ?? Bun.sleep;
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	options.state.initializeDirectories();
	let attempt = 0;
	let authenticationFailures = 0;
	while (!options.signal.aborted) {
		options.onState?.("connecting");
		const identity = options.state.nextConnectionIdentity();
		try {
			const challengeInput = {
				runtimeBoxId: identity.config.runtimeBoxId,
				deviceKeyId: identity.config.deviceKeyId,
				instanceId: identity.instanceId,
				generation: identity.generation,
				protocolVersion: 1 as const,
			};
			const challenge = runtimeBoxChallengeOutputSchema.parse(
				await postJson(
					fetcher,
					identity.config.runtimeBaseUrl,
					"/runtime-auth/challenge",
					challengeInput,
					options.signal,
				),
			);
			options.signal.throwIfAborted();
			verifyServerChallenge(identity.config, challengeInput, challenge, now());
			const invocationJournal = new RuntimeBoxInvocationJournal(
				join(
					options.state.root,
					"journal",
					identity.config.agentServerId,
					identity.config.runtimeBoxId,
					challenge.actionJournalEpoch,
				),
			);
			const toolHandler = createExecutorToolRequestHandler(options.toolRuntime, {
				cwd: options.state.workspacePath,
				journal: invocationJournal,
			});
			const privateKey = createPrivateKey({
				key: Buffer.from(identity.config.privateKey, "base64url"),
				format: "der",
				type: "pkcs8",
			});
			const signature = sign(
				null,
				Buffer.from(
					createRuntimeBoxAuthenticationPayload(challengeInput, {
						challengeId: challenge.challengeId,
						nonce: challenge.nonce,
						expiresAt: challenge.expiresAt,
						agentServerId: challenge.agentServerId,
						rpcIdentity: challenge.rpcIdentity,
						actionJournalEpoch: challenge.actionJournalEpoch,
					}),
					"utf8",
				),
				privateKey,
			).toString("base64url");
			const peer = await connect({
				url: toRuntimeWebSocketUrl(identity.config.runtimeBaseUrl),
				identity: {
					role: "runtime-box",
					peerId: identity.config.runtimeBoxId,
					instanceId: identity.instanceId,
					generation: identity.generation,
					deviceKeyId: identity.config.deviceKeyId,
				},
				expectedServerIdentity: challenge.rpcIdentity,
				signal: options.signal,
				getHandshakeHeaders: () => ({
					"x-moshu-runtime-box-id": identity.config.runtimeBoxId,
					"x-moshu-device-key-id": identity.config.deviceKeyId,
					"x-moshu-instance-id": identity.instanceId,
					"x-moshu-generation": String(identity.generation),
					"x-moshu-protocol-version": "1",
					"x-moshu-challenge-id": challenge.challengeId,
					"x-moshu-signature": signature,
				}),
				methodAllowlist: { agents: { requests: agentsRuntimeBoxRequestMethods } },
				handlers: {
					requests: {
						[productRpcMethods.runtimeBoxToolInvoke]: toolHandler,
						[productRpcMethods.runtimeBoxProjectValidatePath]: validateProjectPathRequestHandler,
						[productRpcMethods.runtimeBoxInvocationsAck]:
							createInvocationAcknowledgementHandler(invocationJournal),
					},
				},
				requestTimeoutLimits: {
					[productRpcMethods.runtimeBoxToolInvoke]: executorToolRpcTimeoutMs,
				},
				limits: {
					maxFrameBytes: productRpcMaxFrameBytes,
					maxBufferedOutboundBytes: productRpcMaxBufferedOutboundBytes,
				},
			});
			options.signal.throwIfAborted();
			const onAbort = () => peer.close(1000, "Remote Runtime Box shutting down.");
			options.signal.addEventListener("abort", onAbort, { once: true });
			const reconciliationController = new AbortController();
			const reconciliationSignal = AbortSignal.any([
				options.signal,
				reconciliationController.signal,
			]);
			let reconciliationObservation: Promise<void> = Promise.resolve();
			let registeredAt: number | undefined;
			try {
				const registration = await peer.request(
					productRpcMethods.runtimeBoxRegister,
					rpcJsonValueSchema.parse(
						runtimeBoxRegisterInputSchema.parse({
							schemaVersion: 1,
							status: "ready",
							runtimeBox: {
								schemaVersion: 1,
								runtimeBoxId: identity.config.runtimeBoxId,
								kind: "remote",
								displayName: identity.config.displayName,
								runtimeBoxVersion: "0.0.1",
								platform: requireSupportedPlatform(process.platform),
								arch: process.arch,
								capabilities: [
									...executorToolNames.map((tool) => `tool.${tool}`),
									"projects.validate-path",
								],
							},
						}),
					),
				);
				runtimeBoxRegisterOutputSchema.parse(registration);
				await reconcileInvocationJournal(peer, invocationJournal, reconciliationSignal);
				await peer.request(
					productRpcMethods.runtimeBoxReady,
					{},
					{
						signal: reconciliationSignal,
					},
				);
				reconciliationObservation = watchInvocationReconciliation(
					peer,
					invocationJournal,
					reconciliationSignal,
					{
						onError: (error) =>
							console.error(
								error instanceof Error
									? error.message
									: "Remote Runtime Box Action reconciliation failed.",
							),
					},
				);
				registeredAt = now();
				options.onState?.("online");
				authenticationFailures = 0;
				await peer.closed;
			} finally {
				reconciliationController.abort();
				await reconciliationObservation;
				options.signal.removeEventListener("abort", onAbort);
				peer.close(1000, "Remote Runtime Box connection attempt ended.");
			}
			if (registeredAt !== undefined && now() - registeredAt >= stableConnectionMs) {
				attempt = 0;
			} else {
				attempt += 1;
			}
		} catch (error) {
			if (options.signal.aborted) {
				return;
			}
			if (isAuthenticationFailure(error)) {
				authenticationFailures += 1;
				if (authenticationFailures < 3) {
					attempt += 1;
					options.onState?.("disconnected");
					await sleepWithAbort(
						calculateRemoteReconnectDelayMs(Math.max(0, attempt - 1), random),
						options.signal,
						sleep,
					);
					continue;
				}
			}
			if (isPermanentConnectionError(error) || authenticationFailures >= 3) {
				throw new RemoteRuntimePermanentError("Remote Runtime Box authentication failed.", {
					cause: error,
				});
			}
			attempt += 1;
		}
		options.onState?.("disconnected");
		await sleepWithAbort(
			calculateRemoteReconnectDelayMs(Math.max(0, attempt - 1), random),
			options.signal,
			sleep,
		);
	}
}

export function calculateRemoteReconnectDelayMs(
	attempt: number,
	random: () => number = Math.random,
): number {
	if (!Number.isSafeInteger(attempt) || attempt < 0) {
		throw new TypeError("Reconnect attempt must be a nonnegative safe integer.");
	}
	const index = Math.min(attempt, reconnectDelaysMs.length - 1);
	const base = reconnectDelaysMs[index] ?? 30_000;
	if (attempt < reconnectDelaysMs.length) {
		return base;
	}
	return Math.round(30_000 * (0.8 + random() * 0.4));
}

async function postJson(
	fetcher: RuntimeFetch,
	runtimeBaseUrl: string,
	pathname: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(`${runtimeBaseUrl}${pathname}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		throw new Error("Runtime ingress is unreachable.", { cause: error });
	}
	if (!response.ok) {
		if (response.status === 400 || response.status === 401 || response.status === 403) {
			throw new RemoteRuntimePermanentError("Runtime ingress rejected the device.");
		}
		throw new Error(`Runtime ingress returned HTTP ${response.status}.`);
	}
	return response.json();
}

function verifyServerChallenge(
	config: RemoteRuntimeBoxConfig,
	input: {
		runtimeBoxId: string;
		deviceKeyId: string;
		instanceId: string;
		generation: number;
		protocolVersion: 1;
	},
	challenge: {
		challengeId: string;
		nonce: string;
		expiresAt: string;
		agentServerId: string;
		rpcIdentity: ProcessPeerIdentity;
		actionJournalEpoch: string;
		signature: string;
	},
	now: number,
): void {
	if (challenge.agentServerId !== config.agentServerId || Date.parse(challenge.expiresAt) <= now) {
		throw new RemoteRuntimePermanentError("Agent Server challenge identity or expiry is invalid.");
	}
	const publicKey = createPublicKey({
		key: Buffer.from(config.agentServerPublicKey, "base64url"),
		format: "der",
		type: "spki",
	});
	const valid = verify(
		null,
		Buffer.from(
			createRuntimeBoxServerChallengePayload(input, {
				challengeId: challenge.challengeId,
				nonce: challenge.nonce,
				expiresAt: challenge.expiresAt,
				agentServerId: challenge.agentServerId,
				rpcIdentity: challenge.rpcIdentity,
				actionJournalEpoch: challenge.actionJournalEpoch,
			}),
			"utf8",
		),
		publicKey,
		Buffer.from(challenge.signature, "base64url"),
	);
	if (!valid) {
		throw new RemoteRuntimePermanentError("Agent Server challenge signature is invalid.");
	}
}

function toRuntimeWebSocketUrl(runtimeBaseUrl: string): string {
	const url = new URL(runtimeBaseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/runtime`;
	return url.toString();
}

function requireSupportedPlatform(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
	if (platform === "darwin" || platform === "win32" || platform === "linux") {
		return platform;
	}
	throw new Error(`Unsupported Runtime Box platform: ${platform}.`);
}

function defaultDisplayName(): string {
	return `${process.platform}-${process.arch} Runtime Box`;
}

function isPermanentConnectionError(error: unknown): boolean {
	return (
		error instanceof RemoteRuntimePermanentError ||
		(error instanceof RpcHandshakeError &&
			(error.code === "ROLE_NOT_ALLOWED" ||
				error.code === "IDENTITY_MISMATCH" ||
				error.code === "UNSUPPORTED_PROTOCOL" ||
				error.code === "UNSUPPORTED_SCHEMA"))
	);
}

function isAuthenticationFailure(error: unknown): boolean {
	return error instanceof RpcHandshakeError && error.code === "AUTHENTICATION_FAILED";
}

async function sleepWithAbort(
	milliseconds: number,
	signal: AbortSignal,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	if (signal.aborted) {
		return;
	}
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			sleep(milliseconds),
			new Promise<void>((resolve) => {
				onAbort = resolve;
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort !== undefined) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
