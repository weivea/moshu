import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	claimRuntimeBoxPairingInputSchema,
	claimRuntimeBoxPairingOutputSchema,
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxPairingOutputSchema,
	createRuntimeBoxServerChallengePayload,
	getRuntimeBoxPairingStatusInputSchema,
	listRuntimeBoxPairingClaimsOutputSchema,
	rejectRuntimeBoxPairingInputSchema,
	rejectRuntimeBoxPairingOutputSchema,
	revokeRuntimeBoxDeviceInputSchema,
	revokeRuntimeBoxDeviceOutputSchema,
	runtimeBoxChallengeInputSchema,
	runtimeBoxChallengeOutputSchema,
	runtimeBoxPairingStatusOutputSchema,
	type ApproveRuntimeBoxPairingInput,
	type ClaimRuntimeBoxPairingInput,
	type CreateRuntimeBoxPairingOutput,
	type RuntimeBoxChallengeInput,
	type RuntimeBoxPairingStatusOutput,
	type ProcessPeerIdentity,
} from "@moshu/contracts";
import {
	PairingFingerprintMismatchError,
	PairingSessionNotFoundError,
	PairingSessionStateError,
	type RuntimeBoxDeviceKey,
	type RuntimeBoxPairingRepository,
	type RuntimeBoxRepository,
} from "@moshu/database";
import {
	type RpcHandshakeAuthenticator,
	RpcHandshakeHttpError,
	type RpcHttpRequestContext,
	type RpcPeerIdentity,
} from "@moshu/process-rpc";

import type { AgentServerIdentity } from "./agent-server-identity";

const maxPreAuthBodyBytes = 32 * 1024;
const pairingTtlMs = 5 * 60_000;
const challengeTtlMs = 30_000;
const maxOutstandingChallenges = 128;
const maxConcurrentPreAuthRequests = 128;
const preAuthRequestTimeoutMs = 5_000;

interface PendingChallenge {
	readonly input: RuntimeBoxChallengeInput;
	readonly nonce: string;
	readonly expiresAt: string;
}

interface RuntimeIngressAuthOptions {
	pairings: RuntimeBoxPairingRepository;
	runtimeBoxes: RuntimeBoxRepository;
	identity: AgentServerIdentity;
	rpcIdentity: ProcessPeerIdentity;
	actionJournalEpoch: string;
	localAuthenticator: RpcHandshakeAuthenticator;
	now?: () => number;
	preAuthRequestTimeoutMs?: number;
	maxConcurrentPreAuthRequests?: number;
}

export class RuntimeIngressAuth {
	readonly #pairings: RuntimeBoxPairingRepository;
	readonly #runtimeBoxes: RuntimeBoxRepository;
	readonly #identity: AgentServerIdentity;
	readonly #rpcIdentity: ProcessPeerIdentity;
	readonly #actionJournalEpoch: string;
	readonly #localAuthenticator: RpcHandshakeAuthenticator;
	readonly #now: () => number;
	readonly #challenges = new Map<string, PendingChallenge>();
	readonly #httpLimiters = new Map([
		["/runtime-pair/claim", new PreAuthRateLimiter(120, 60)],
		["/runtime-pair/status", new PreAuthRateLimiter(360, 180)],
		["/runtime-auth/challenge", new PreAuthRateLimiter(360, 60)],
	]);
	readonly #upgradeLimiter = new PreAuthRateLimiter(600, 30);
	readonly #preAuthRequestTimeoutMs: number;
	readonly #maxConcurrentPreAuthRequests: number;
	#activeHttpRequests = 0;

	constructor(options: RuntimeIngressAuthOptions) {
		this.#pairings = options.pairings;
		this.#runtimeBoxes = options.runtimeBoxes;
		this.#identity = options.identity;
		if (options.rpcIdentity.role !== "agents") {
			throw new TypeError("Runtime ingress RPC identity must use the agents role.");
		}
		this.#rpcIdentity = options.rpcIdentity;
		this.#actionJournalEpoch = options.actionJournalEpoch;
		this.#localAuthenticator = options.localAuthenticator;
		this.#now = options.now ?? Date.now;
		this.#preAuthRequestTimeoutMs = options.preAuthRequestTimeoutMs ?? preAuthRequestTimeoutMs;
		this.#maxConcurrentPreAuthRequests =
			options.maxConcurrentPreAuthRequests ?? maxConcurrentPreAuthRequests;
		if (
			!Number.isSafeInteger(this.#preAuthRequestTimeoutMs) ||
			this.#preAuthRequestTimeoutMs <= 0 ||
			!Number.isSafeInteger(this.#maxConcurrentPreAuthRequests) ||
			this.#maxConcurrentPreAuthRequests <= 0
		) {
			throw new TypeError("Runtime ingress pre-auth limits must be positive safe integers.");
		}
	}

	createPairing(): CreateRuntimeBoxPairingOutput {
		const code = randomBytes(24).toString("base64url");
		const pairingId = randomUUID();
		const expiresAtMs = this.#now() + pairingTtlMs;
		this.#pairings.create({
			id: pairingId,
			codeHash: hashSecret(code),
			expiresAtMs,
		});
		return createRuntimeBoxPairingOutputSchema.parse({
			pairingId,
			code,
			expiresAt: new Date(expiresAtMs).toISOString(),
		});
	}

	listPendingClaims() {
		return listRuntimeBoxPairingClaimsOutputSchema.parse({
			items: this.#pairings.listPendingClaims(),
		});
	}

	approve(inputValue: ApproveRuntimeBoxPairingInput) {
		const input = approveRuntimeBoxPairingInputSchema.parse(inputValue);
		const runtimeBox = this.#pairings.approve(input.pairingId, input.expectedPublicKeyFingerprint);
		this.#runtimeBoxes.get(runtimeBox.runtimeBoxId);
		return approveRuntimeBoxPairingOutputSchema.parse({ runtimeBox });
	}

	reject(inputValue: unknown) {
		const input = rejectRuntimeBoxPairingInputSchema.parse(inputValue);
		this.#pairings.reject(input.pairingId);
		return rejectRuntimeBoxPairingOutputSchema.parse({ rejected: true });
	}

	revokeDeviceKey(inputValue: unknown) {
		const input = revokeRuntimeBoxDeviceInputSchema.parse(inputValue);
		this.#pairings.revokeDeviceKey(input.runtimeBoxId, input.deviceKeyId);
		return revokeRuntimeBoxDeviceOutputSchema.parse({ revoked: true });
	}

	readonly authenticate: RpcHandshakeAuthenticator = async (
		request,
		context = { remoteAddress: null },
	) => {
		if (isLoopbackAddress(context.remoteAddress)) {
			const localIdentity = await this.#localAuthenticator(request, context);
			if (localIdentity !== null) {
				return localIdentity;
			}
		}
		return this.#authenticateDevice(request, context);
	};

	readonly handleHttpRequest = async (
		request: Request,
		context: RpcHttpRequestContext = { remoteAddress: null },
	): Promise<Response | undefined> => {
		const pathname = new URL(request.url).pathname;
		if (
			pathname !== "/runtime-pair/claim" &&
			pathname !== "/runtime-pair/status" &&
			pathname !== "/runtime-auth/challenge"
		) {
			return undefined;
		}
		if (request.method !== "POST") {
			return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
		}
		if (this.#activeHttpRequests >= this.#maxConcurrentPreAuthRequests) {
			return jsonResponse({ error: "CAPACITY_EXCEEDED" }, 429);
		}
		const limiter = this.#httpLimiters.get(pathname);
		const source = resolveRateLimitSource(request, context);
		if (limiter === undefined || !limiter.allow(source, this.#now())) {
			return jsonResponse({ error: "RATE_LIMITED" }, 429);
		}
		this.#activeHttpRequests += 1;
		try {
			const body = await readBoundedJson(request, this.#preAuthRequestTimeoutMs);
			if (pathname === "/runtime-pair/claim") {
				return jsonResponse(this.#claimPairing(claimRuntimeBoxPairingInputSchema.parse(body)));
			}
			if (pathname === "/runtime-pair/status") {
				return jsonResponse(this.#getPairingStatus(body));
			}
			return jsonResponse(this.#createChallenge(runtimeBoxChallengeInputSchema.parse(body)));
		} catch (error) {
			if (
				error instanceof PairingSessionNotFoundError ||
				error instanceof PairingSessionStateError ||
				error instanceof PairingFingerprintMismatchError
			) {
				return jsonResponse({ error: "PAIRING_REJECTED" }, 400);
			}
			return jsonResponse({ error: "INVALID_REQUEST" }, 400);
		} finally {
			this.#activeHttpRequests -= 1;
		}
	};

	#claimPairing(input: ClaimRuntimeBoxPairingInput) {
		const publicKey = parsePublicKey(input.publicKey);
		if (publicKey.asymmetricKeyType !== "ed25519") {
			throw new Error("Runtime Box device keys must use Ed25519.");
		}
		const canonicalPublicKey = publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64url");
		if (canonicalPublicKey !== input.publicKey) {
			throw new Error("Runtime Box public key must use canonical SPKI DER encoding.");
		}
		const claimToken = randomBytes(32).toString("base64url");
		const claimed = this.#pairings.claim({
			codeHash: hashSecret(input.code),
			claimTokenHash: hashSecret(claimToken),
			deviceKeyId: input.deviceKeyId,
			publicKey: input.publicKey,
			publicKeyFingerprint: fingerprintPublicKey(input.publicKey),
			displayName: input.displayName,
			platform: input.platform,
			arch: input.arch,
		});
		return claimRuntimeBoxPairingOutputSchema.parse({
			pairingId: claimed.pairingId,
			claimToken,
			status: "pending_approval",
		});
	}

	#getPairingStatus(body: unknown): RuntimeBoxPairingStatusOutput {
		const input = getRuntimeBoxPairingStatusInputSchema.parse(body);
		const status = this.#pairings.getStatus(input.pairingId, hashSecret(input.claimToken));
		if (status.status !== "approved") {
			return runtimeBoxPairingStatusOutputSchema.parse(status);
		}
		return runtimeBoxPairingStatusOutputSchema.parse({
			status: "approved",
			runtimeBoxId: status.runtimeBoxId,
			agentServerId: this.#identity.agentServerId,
			agentServerPublicKey: this.#identity.publicKey,
		});
	}

	#createChallenge(input: RuntimeBoxChallengeInput) {
		this.#removeExpiredChallenges();
		if (this.#challenges.size >= maxOutstandingChallenges) {
			throw new Error("Runtime Box challenge capacity is full.");
		}
		try {
			this.#pairings.getActiveDeviceKey(input.runtimeBoxId, input.deviceKeyId);
		} catch (error) {
			if (!(error instanceof PairingSessionNotFoundError)) {
				throw error;
			}
			// Missing and revoked keys receive the same signed challenge shape as active keys.
		}
		const challengeId = randomUUID();
		const nonce = randomBytes(32).toString("base64url");
		const expiresAt = new Date(this.#now() + challengeTtlMs).toISOString();
		const unsigned = {
			challengeId,
			nonce,
			expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
		};
		this.#challenges.set(challengeId, { input, nonce, expiresAt });
		return runtimeBoxChallengeOutputSchema.parse({
			...unsigned,
			signature: this.#identity.sign(createRuntimeBoxServerChallengePayload(input, unsigned)),
		});
	}

	#authenticateDevice(request: Request, context: RpcHttpRequestContext): RpcPeerIdentity | null {
		const runtimeBoxId = request.headers.get("x-moshu-runtime-box-id");
		const deviceKeyId = request.headers.get("x-moshu-device-key-id");
		const instanceId = request.headers.get("x-moshu-instance-id");
		const generationText = request.headers.get("x-moshu-generation");
		const protocolVersionText = request.headers.get("x-moshu-protocol-version");
		const challengeId = request.headers.get("x-moshu-challenge-id");
		const signature = request.headers.get("x-moshu-signature");
		if (
			runtimeBoxId === null ||
			deviceKeyId === null ||
			instanceId === null ||
			generationText === null ||
			protocolVersionText === null ||
			challengeId === null ||
			signature === null
		) {
			return null;
		}
		if (signature.length > 171 || !/^[A-Za-z0-9_-]+$/.test(signature)) {
			return null;
		}
		const generation = Number(generationText);
		const protocolVersion = Number(protocolVersionText);
		const parsedInput = runtimeBoxChallengeInputSchema.safeParse({
			runtimeBoxId,
			deviceKeyId,
			instanceId,
			generation,
			protocolVersion,
		});
		if (!parsedInput.success) {
			return null;
		}
		if (!this.#upgradeLimiter.allow(resolveRateLimitSource(request, context), this.#now())) {
			throw new RpcHandshakeHttpError(429, "Runtime ingress authentication rate limited.", {
				"retry-after": "60",
			});
		}
		const challenge = this.#challenges.get(challengeId);
		this.#challenges.delete(challengeId);
		if (
			challenge === undefined ||
			Date.parse(challenge.expiresAt) <= this.#now() ||
			JSON.stringify(challenge.input) !== JSON.stringify(parsedInput.data)
		) {
			return null;
		}
		let key: RuntimeBoxDeviceKey;
		try {
			key = this.#pairings.getActiveDeviceKey(runtimeBoxId, deviceKeyId);
		} catch {
			return null;
		}
		const unsigned = {
			challengeId,
			nonce: challenge.nonce,
			expiresAt: challenge.expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
		};
		let signatureBytes: Buffer;
		try {
			signatureBytes = Buffer.from(signature, "base64url");
			if (signatureBytes.toString("base64url") !== signature) {
				return null;
			}
		} catch {
			return null;
		}
		let valid: boolean;
		try {
			valid = verify(
				null,
				Buffer.from(createRuntimeBoxAuthenticationPayload(parsedInput.data, unsigned), "utf8"),
				parsePublicKey(key.publicKey),
				signatureBytes,
			);
		} catch {
			return null;
		}
		return valid
			? {
					role: "runtime-box",
					peerId: runtimeBoxId,
					instanceId,
					generation,
					deviceKeyId,
				}
			: null;
	}

	#removeExpiredChallenges(): void {
		const now = this.#now();
		for (const [challengeId, challenge] of this.#challenges) {
			if (Date.parse(challenge.expiresAt) <= now) {
				this.#challenges.delete(challengeId);
			}
		}
	}
}

class PreAuthRateLimiter {
	#windowStartedAt = 0;
	#globalCount = 0;
	readonly #countsBySource = new Map<string, number>();

	constructor(
		private readonly globalLimit: number,
		private readonly keyLimit: number,
	) {}

	allow(source: string, now: number): boolean {
		if (now - this.#windowStartedAt >= 60_000) {
			this.#windowStartedAt = now;
			this.#globalCount = 0;
			this.#countsBySource.clear();
		}
		const sourceCount = this.#countsBySource.get(source) ?? 0;
		if (this.#globalCount >= this.globalLimit || sourceCount >= this.keyLimit) {
			return false;
		}
		this.#globalCount += 1;
		this.#countsBySource.set(source, sourceCount + 1);
		return true;
	}
}

async function readBoundedJson(request: Request, timeoutMs: number): Promise<unknown> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxPreAuthBodyBytes) {
			throw new Error("Runtime ingress request body is too large.");
		}
	}
	if (request.body === null) {
		throw new Error("Runtime ingress request body is required.");
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel("Runtime ingress request timed out.");
	}, timeoutMs);
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			total += next.value.byteLength;
			if (total > maxPreAuthBodyBytes) {
				await reader.cancel("Runtime ingress request body is too large.");
				throw new Error("Runtime ingress request body is too large.");
			}
			chunks.push(next.value);
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	if (timedOut) {
		throw new Error("Runtime ingress request timed out.");
	}
	const bytes = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		total,
	);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function parsePublicKey(value: string) {
	return createPublicKey({
		key: Buffer.from(value, "base64url"),
		format: "der",
		type: "spki",
	});
}

function fingerprintPublicKey(publicKey: string): string {
	return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}

function hashSecret(secret: string): string {
	return createHash("sha256").update(secret, "ascii").digest("base64url");
}

function isLoopbackAddress(address: string | null): boolean {
	if (address === null) {
		return false;
	}
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function resolveRateLimitSource(request: Request, context: RpcHttpRequestContext): string {
	const address = context.remoteAddress;
	if (isLoopbackAddress(address)) {
		const forwarded = request.headers.get("x-forwarded-for");
		const proxyAddress = forwarded?.split(",").at(-1)?.trim();
		if (proxyAddress && /^[0-9a-f:.]+$/i.test(proxyAddress)) {
			return `proxy:${proxyAddress.slice(0, 128)}`;
		}
	}
	return `tcp:${address ?? "unknown"}`;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json",
		},
	});
}
