import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
	approveRuntimeBoxPairingInputSchema,
	approveRuntimeBoxPairingOutputSchema,
	claimRuntimeBoxPairingInputSchema,
	claimRuntimeBoxPairingOutputSchema,
	createRuntimeBoxAuthenticationPayload,
	createRuntimeBoxCompatibilityReportPayload,
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
	runtimeBoxCompatibilityReportInputSchema,
	runtimeBoxCompatibilityReportOutputSchema,
	runtimeBoxPairingStatusOutputSchema,
	type ApproveRuntimeBoxPairingInput,
	type ClaimRuntimeBoxPairingInput,
	type CreateRuntimeBoxPairingOutput,
	type RuntimeBoxChallengeInput,
	type RuntimeBoxCompatibilityReportInput,
	type RuntimeBoxPairingStatusOutput,
	type ProcessPeerIdentity,
	currentRuntimeBoxProtocolVersion,
	runtimeBoxProtocolMinVersion,
	runtimeBoxProtocolMaxVersion,
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
const compatibilityReportTtlMs = 60_000;

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
	onUpgradeRequired?: (runtimeBoxId: string) => void;
}

class RuntimeBoxUpgradeRequiredError extends Error {
	constructor(readonly runtimeBoxId: string) {
		super("Runtime Box protocol version is incompatible.");
		this.name = "RuntimeBoxUpgradeRequiredError";
	}
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
	readonly #compatibilityReports = new Map<string, number>();
	readonly #httpLimiters = new Map([
		["/runtime-pair/claim", new PreAuthRateLimiter(120, 60)],
		["/runtime-pair/status", new PreAuthRateLimiter(360, 180)],
		["/runtime-auth/challenge", new PreAuthRateLimiter(360, 60)],
		["/runtime-auth/compatibility", new PreAuthRateLimiter(120, 30)],
	]);
	readonly #upgradeLimiter = new PreAuthRateLimiter(600, 30);
	readonly #preAuthRequestTimeoutMs: number;
	readonly #maxConcurrentPreAuthRequests: number;
	readonly #onUpgradeRequired: ((runtimeBoxId: string) => void) | undefined;
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
		this.#onUpgradeRequired = options.onUpgradeRequired;
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
			pathname !== "/runtime-auth/challenge" &&
			pathname !== "/runtime-auth/compatibility"
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
			if (pathname === "/runtime-auth/compatibility") {
				return jsonResponse(
					this.#reportCompatibility(runtimeBoxCompatibilityReportInputSchema.parse(body)),
				);
			}
			return jsonResponse(this.#createChallenge(runtimeBoxChallengeInputSchema.parse(body)));
		} catch (error) {
			if (error instanceof RuntimeBoxUpgradeRequiredError) {
				return jsonResponse(
					{
						error: "RUNTIME_BOX_UPGRADE_REQUIRED",
						minProtocolVersion: runtimeBoxProtocolMinVersion,
						maxProtocolVersion: runtimeBoxProtocolMaxVersion,
					},
					426,
				);
			}
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
		if (input.protocolVersion !== currentRuntimeBoxProtocolVersion) {
			throw new RuntimeBoxUpgradeRequiredError(input.runtimeBoxId);
		}
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
		const unsigned = runtimeBoxChallengeOutputSchema.omit({ signature: true }).parse({
			challengeId,
			nonce,
			expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
			negotiatedProtocolVersion: currentRuntimeBoxProtocolVersion,
			transportSecurity: "relay-tls" as const,
			supportedTransportSecurity: ["relay-tls"],
		});
		this.#challenges.set(challengeId, { input, nonce, expiresAt });
		return runtimeBoxChallengeOutputSchema.parse({
			...unsigned,
			signature: this.#identity.sign(createRuntimeBoxServerChallengePayload(input, unsigned)),
		});
	}

	#reportCompatibility(input: RuntimeBoxCompatibilityReportInput) {
		if (
			input.protocolVersion >= runtimeBoxProtocolMinVersion &&
			input.protocolVersion <= runtimeBoxProtocolMaxVersion
		) {
			throw new Error("Runtime Box protocol is already compatible.");
		}
		const issuedAtMs = Date.parse(input.issuedAt);
		const now = this.#now();
		if (issuedAtMs < now - compatibilityReportTtlMs || issuedAtMs > now + 5_000) {
			throw new Error("Runtime Box compatibility report is expired.");
		}
		for (const [reportId, expiresAtMs] of this.#compatibilityReports) {
			if (expiresAtMs <= now) {
				this.#compatibilityReports.delete(reportId);
			}
		}
		if (
			this.#compatibilityReports.has(input.reportId) ||
			this.#compatibilityReports.size >= maxOutstandingChallenges
		) {
			throw new Error("Runtime Box compatibility report is not consumable.");
		}
		const key = this.#pairings.getActiveDeviceKey(input.runtimeBoxId, input.deviceKeyId);
		let signature: Buffer;
		try {
			signature = Buffer.from(input.signature, "base64url");
			if (signature.toString("base64url") !== input.signature) {
				throw new Error("non-canonical signature");
			}
		} catch (error) {
			throw new Error("Runtime Box compatibility signature is invalid.", { cause: error });
		}
		const unsigned = {
			runtimeBoxId: input.runtimeBoxId,
			deviceKeyId: input.deviceKeyId,
			instanceId: input.instanceId,
			generation: input.generation,
			protocolVersion: input.protocolVersion,
			reportId: input.reportId,
			issuedAt: input.issuedAt,
		};
		if (
			!verify(
				null,
				Buffer.from(
					createRuntimeBoxCompatibilityReportPayload(this.#identity.agentServerId, unsigned),
					"utf8",
				),
				parsePublicKey(key.publicKey),
				signature,
			)
		) {
			throw new Error("Runtime Box compatibility signature is invalid.");
		}
		const generation = this.#runtimeBoxes.markUpgradeRequired(
			input.runtimeBoxId,
			input.instanceId,
			input.generation,
			input.protocolVersion,
		);
		if (!generation.accepted) {
			throw new Error("Runtime Box compatibility generation is stale or conflicting.");
		}
		this.#compatibilityReports.set(input.reportId, now + compatibilityReportTtlMs);
		this.#onUpgradeRequired?.(input.runtimeBoxId);
		return runtimeBoxCompatibilityReportOutputSchema.parse({
			accepted: true,
			requiredProtocolMinVersion: runtimeBoxProtocolMinVersion,
			requiredProtocolMaxVersion: runtimeBoxProtocolMaxVersion,
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
		if (parsedInput.data.protocolVersion !== currentRuntimeBoxProtocolVersion) {
			throw new RpcHandshakeHttpError(426, "Runtime Box upgrade required.", {
				"x-moshu-runtime-protocol-min": String(runtimeBoxProtocolMinVersion),
				"x-moshu-runtime-protocol-max": String(runtimeBoxProtocolMaxVersion),
			});
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
		const unsigned = runtimeBoxChallengeOutputSchema.omit({ signature: true }).parse({
			challengeId,
			nonce: challenge.nonce,
			expiresAt: challenge.expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
			negotiatedProtocolVersion: currentRuntimeBoxProtocolVersion,
			transportSecurity: "relay-tls" as const,
			supportedTransportSecurity: ["relay-tls"],
		});
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
