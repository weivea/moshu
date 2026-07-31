import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
	type ApproveMobilePairingInput,
	approveMobilePairingInputSchema,
	approveMobilePairingOutputSchema,
	type ClaimMobilePairingInput,
	type CreateMobilePairingOutput,
	claimMobilePairingInputSchema,
	claimMobilePairingOutputSchema,
	createMobileAuthenticationPayload,
	createMobilePairingOutputSchema,
	createMobileServerChallengePayload,
	currentMobileProtocolVersion,
	getMobilePairingStatusInputSchema,
	listMobilePairingClaimsOutputSchema,
	type MobileChallengeInput,
	type MobilePairingStatusOutput,
	mobileChallengeInputSchema,
	mobileChallengeOutputSchema,
	mobilePairingStatusOutputSchema,
	mobileProtocolMaxVersion,
	mobileProtocolMinVersion,
	type ProcessPeerIdentity,
	type RevokeMobileDeviceInput,
	rejectMobilePairingInputSchema,
	rejectMobilePairingOutputSchema,
	revokeMobileDeviceInputSchema,
	revokeMobileDeviceOutputSchema,
} from "@moshu/contracts";
import {
	type MobileDeviceKey,
	MobilePairingFingerprintMismatchError,
	type MobilePairingRepository,
	MobilePairingSessionNotFoundError,
	MobilePairingSessionStateError,
} from "@moshu/database";
import {
	RpcHandlerError,
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
	readonly input: MobileChallengeInput;
	readonly nonce: string;
	readonly expiresAt: string;
}

export type MobilePublicUrlProvider = () => string | undefined;

interface MobileIngressAuthOptions {
	pairings: MobilePairingRepository;
	identity: AgentServerIdentity;
	rpcIdentity: ProcessPeerIdentity;
	actionJournalEpoch: string;
	getMobilePublicUrl: MobilePublicUrlProvider;
	now?: () => number;
	preAuthRequestTimeoutMs?: number;
	maxConcurrentPreAuthRequests?: number;
}

export class MobileIngressAuth {
	readonly #pairings: MobilePairingRepository;
	readonly #identity: AgentServerIdentity;
	readonly #rpcIdentity: ProcessPeerIdentity;
	readonly #actionJournalEpoch: string;
	readonly #getMobilePublicUrl: MobilePublicUrlProvider;
	readonly #now: () => number;
	readonly #challenges = new Map<string, PendingChallenge>();
	readonly #httpLimiters = new Map([
		["/mobile-pair/claim", new PreAuthRateLimiter(120, 60)],
		["/mobile-pair/status", new PreAuthRateLimiter(360, 180)],
		["/mobile-auth/challenge", new PreAuthRateLimiter(360, 60)],
		["/mobile-auth/compatibility", new PreAuthRateLimiter(120, 30)],
	]);
	readonly #upgradeLimiter = new PreAuthRateLimiter(600, 30);
	readonly #preAuthRequestTimeoutMs: number;
	readonly #maxConcurrentPreAuthRequests: number;
	#activeHttpRequests = 0;

	constructor(options: MobileIngressAuthOptions) {
		this.#pairings = options.pairings;
		this.#identity = options.identity;
		if (options.rpcIdentity.role !== "agents") {
			throw new TypeError("Mobile ingress RPC identity must use the agents role.");
		}
		this.#rpcIdentity = options.rpcIdentity;
		this.#actionJournalEpoch = options.actionJournalEpoch;
		this.#getMobilePublicUrl = options.getMobilePublicUrl;
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
			throw new TypeError("Mobile ingress pre-auth limits must be positive safe integers.");
		}
	}

	createPairing(): CreateMobilePairingOutput {
		// Fail closed: a pairing is only useful once the Mobile ingress is live and has an exact public
		// URL to embed in the QR. If it is not ready we refuse *before* minting any state, so we never
		// create a code the phone could never reach and never leave a dangling, QR-less pairing record.
		const mobileUrl = this.#getMobilePublicUrl();
		if (mobileUrl === undefined) {
			throw new RpcHandlerError(
				"MOBILE_INGRESS_NOT_READY",
				"The Mobile ingress is not exposed yet, so a pairing QR cannot be published.",
			);
		}
		const code = randomBytes(24).toString("base64url");
		const pairingId = randomUUID();
		const expiresAtMs = this.#now() + pairingTtlMs;
		const expiresAt = new Date(expiresAtMs).toISOString();
		this.#pairings.create({
			id: pairingId,
			codeHash: hashSecret(code),
			expiresAtMs,
		});
		return createMobilePairingOutputSchema.parse({
			pairingId,
			code,
			expiresAt,
			mobileUrl,
			qr: {
				v: 1,
				kind: "moshu-mobile-pairing",
				mobileUrl,
				pairingId,
				code,
				agentServerId: this.#identity.agentServerId,
				agentServerPublicKey: this.#identity.publicKey,
				agentServerPublicKeyFingerprint: fingerprintPublicKey(this.#identity.publicKey),
				expiresAt,
				protocolMinVersion: mobileProtocolMinVersion,
				protocolMaxVersion: mobileProtocolMaxVersion,
			},
		});
	}

	listPendingClaims() {
		return listMobilePairingClaimsOutputSchema.parse({
			items: this.#pairings.listPendingClaims(),
		});
	}

	approve(inputValue: ApproveMobilePairingInput) {
		const input = approveMobilePairingInputSchema.parse(inputValue);
		const device = this.#pairings.approve(input.pairingId, input.expectedPublicKeyFingerprint);
		return approveMobilePairingOutputSchema.parse({ device });
	}

	reject(inputValue: unknown) {
		const input = rejectMobilePairingInputSchema.parse(inputValue);
		this.#pairings.reject(input.pairingId);
		return rejectMobilePairingOutputSchema.parse({ rejected: true });
	}

	revokeDevice(inputValue: RevokeMobileDeviceInput) {
		const input = revokeMobileDeviceInputSchema.parse(inputValue);
		// Revoking any active key of a device revokes the device (its last key). The peer disconnect
		// is driven by the caller in create-agents-server; the durable revoke flag blocks reconnects.
		this.#pairings.revokeDeviceKey(input.mobileClientId, input.deviceKeyId);
		return revokeMobileDeviceOutputSchema.parse({ revoked: true });
	}

	readonly authenticate: RpcHandshakeAuthenticator = (request, context = { remoteAddress: null }) =>
		this.#authenticateDevice(request, context);

	readonly handleHttpRequest = async (
		request: Request,
		context: RpcHttpRequestContext = { remoteAddress: null },
	): Promise<Response | undefined> => {
		const pathname = new URL(request.url).pathname;
		if (
			pathname !== "/mobile-pair/claim" &&
			pathname !== "/mobile-pair/status" &&
			pathname !== "/mobile-auth/challenge" &&
			pathname !== "/mobile-auth/compatibility"
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
			if (pathname === "/mobile-pair/claim") {
				return jsonResponse(this.#claimPairing(claimMobilePairingInputSchema.parse(body)));
			}
			if (pathname === "/mobile-pair/status") {
				return jsonResponse(this.#getPairingStatus(body));
			}
			if (pathname === "/mobile-auth/compatibility") {
				return jsonResponse(this.#reportCompatibility(body));
			}
			return jsonResponse(this.#createChallenge(mobileChallengeInputSchema.parse(body)));
		} catch (error) {
			if (error instanceof MobileUpgradeRequiredError) {
				return jsonResponse(
					{
						error: "MOBILE_UPGRADE_REQUIRED",
						minProtocolVersion: mobileProtocolMinVersion,
						maxProtocolVersion: mobileProtocolMaxVersion,
					},
					426,
				);
			}
			if (
				error instanceof MobilePairingSessionNotFoundError ||
				error instanceof MobilePairingSessionStateError ||
				error instanceof MobilePairingFingerprintMismatchError
			) {
				return jsonResponse({ error: "PAIRING_REJECTED" }, 400);
			}
			return jsonResponse({ error: "INVALID_REQUEST" }, 400);
		} finally {
			this.#activeHttpRequests -= 1;
		}
	};

	#claimPairing(input: ClaimMobilePairingInput) {
		const publicKey = parsePublicKey(input.publicKey);
		if (publicKey.asymmetricKeyType !== "ed25519") {
			throw new Error("Mobile device keys must use Ed25519.");
		}
		const canonicalPublicKey = publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64url");
		if (canonicalPublicKey !== input.publicKey) {
			throw new Error("Mobile public key must use canonical SPKI DER encoding.");
		}
		const claimToken = randomBytes(32).toString("base64url");
		const claimed = this.#pairings.claim({
			codeHash: hashSecret(input.code),
			claimTokenHash: hashSecret(claimToken),
			deviceKeyId: input.deviceKeyId,
			publicKey: input.publicKey,
			publicKeyFingerprint: fingerprintPublicKey(input.publicKey),
			displayName: input.displayName,
			model: input.model,
			platform: input.platform,
			appVersion: input.appVersion,
		});
		return claimMobilePairingOutputSchema.parse({
			pairingId: claimed.pairingId,
			claimToken,
			status: "pending_approval",
		});
	}

	#getPairingStatus(body: unknown): MobilePairingStatusOutput {
		const input = getMobilePairingStatusInputSchema.parse(body);
		const status = this.#pairings.getStatus(input.pairingId, hashSecret(input.claimToken));
		if (status.status !== "approved") {
			return mobilePairingStatusOutputSchema.parse(status);
		}
		return mobilePairingStatusOutputSchema.parse({
			status: "approved",
			mobileClientId: status.mobileClientId,
			agentServerId: this.#identity.agentServerId,
			agentServerPublicKey: this.#identity.publicKey,
		});
	}

	// The compatibility endpoint is reserved for a future protocol bump. Today the only supported
	// version is the current one, so we always answer with the supported range without mutating state.
	#reportCompatibility(_body: unknown) {
		throw new MobileUpgradeRequiredError();
	}

	#createChallenge(input: MobileChallengeInput) {
		if (input.protocolVersion !== currentMobileProtocolVersion) {
			throw new MobileUpgradeRequiredError();
		}
		this.#removeExpiredChallenges();
		if (this.#challenges.size >= maxOutstandingChallenges) {
			throw new Error("Mobile challenge capacity is full.");
		}
		try {
			this.#pairings.getActiveDeviceKey(input.mobileClientId, input.deviceKeyId);
		} catch (error) {
			if (!(error instanceof MobilePairingSessionNotFoundError)) {
				throw error;
			}
			// Missing and revoked keys receive the same signed challenge shape as active keys, so a
			// probe cannot learn whether a device/key exists from the challenge response.
		}
		const challengeId = randomUUID();
		const nonce = randomBytes(32).toString("base64url");
		const expiresAt = new Date(this.#now() + challengeTtlMs).toISOString();
		const unsigned = mobileChallengeOutputSchema.omit({ signature: true }).parse({
			challengeId,
			nonce,
			expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
			negotiatedProtocolVersion: currentMobileProtocolVersion,
			transportSecurity: "relay-tls" as const,
			supportedTransportSecurity: ["relay-tls"],
		});
		this.#challenges.set(challengeId, { input, nonce, expiresAt });
		return mobileChallengeOutputSchema.parse({
			...unsigned,
			signature: this.#identity.sign(createMobileServerChallengePayload(input, unsigned)),
		});
	}

	#authenticateDevice(request: Request, context: RpcHttpRequestContext): RpcPeerIdentity | null {
		const mobileClientId = request.headers.get("x-moshu-mobile-client-id");
		const deviceKeyId = request.headers.get("x-moshu-device-key-id");
		const instanceId = request.headers.get("x-moshu-instance-id");
		const generationText = request.headers.get("x-moshu-generation");
		const protocolVersionText = request.headers.get("x-moshu-protocol-version");
		const challengeId = request.headers.get("x-moshu-challenge-id");
		const signature = request.headers.get("x-moshu-signature");
		if (
			mobileClientId === null ||
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
		const parsedInput = mobileChallengeInputSchema.safeParse({
			mobileClientId,
			deviceKeyId,
			instanceId,
			generation,
			protocolVersion,
		});
		if (!parsedInput.success) {
			return null;
		}
		if (parsedInput.data.protocolVersion !== currentMobileProtocolVersion) {
			throw new RpcHandshakeHttpError(426, "Mobile upgrade required.", {
				"x-moshu-mobile-protocol-min": String(mobileProtocolMinVersion),
				"x-moshu-mobile-protocol-max": String(mobileProtocolMaxVersion),
			});
		}
		if (!this.#upgradeLimiter.allow(resolveRateLimitSource(request, context), this.#now())) {
			throw new RpcHandshakeHttpError(429, "Mobile ingress authentication rate limited.", {
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
		let key: MobileDeviceKey;
		try {
			key = this.#pairings.getActiveDeviceKey(mobileClientId, deviceKeyId);
		} catch {
			return null;
		}
		const unsigned = mobileChallengeOutputSchema.omit({ signature: true }).parse({
			challengeId,
			nonce: challenge.nonce,
			expiresAt: challenge.expiresAt,
			agentServerId: this.#identity.agentServerId,
			rpcIdentity: this.#rpcIdentity,
			actionJournalEpoch: this.#actionJournalEpoch,
			negotiatedProtocolVersion: currentMobileProtocolVersion,
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
				Buffer.from(createMobileAuthenticationPayload(parsedInput.data, unsigned), "utf8"),
				parsePublicKey(key.publicKey),
				signatureBytes,
			);
		} catch {
			return null;
		}
		return valid
			? {
					role: "mobile-client",
					peerId: mobileClientId,
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

class MobileUpgradeRequiredError extends Error {
	constructor() {
		super("Mobile protocol version is incompatible.");
		this.name = "MobileUpgradeRequiredError";
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
			throw new Error("Mobile ingress request body is too large.");
		}
	}
	if (request.body === null) {
		throw new Error("Mobile ingress request body is required.");
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel("Mobile ingress request timed out.");
	}, timeoutMs);
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			total += next.value.byteLength;
			if (total > maxPreAuthBodyBytes) {
				await reader.cancel("Mobile ingress request body is too large.");
				throw new Error("Mobile ingress request body is too large.");
			}
			chunks.push(next.value);
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	if (timedOut) {
		throw new Error("Mobile ingress request timed out.");
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
