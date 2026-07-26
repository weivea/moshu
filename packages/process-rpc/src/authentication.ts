import { createHash } from "node:crypto";

import { type RpcPeerIdentity, rpcPeerIdentitySchema } from "./protocol";

/** Minimum decoded entropy-bearing byte length for a bootstrap credential. */
export const MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES = 32;
/** Maximum decoded bootstrap credential length accepted in an HTTP header. */
export const MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES = 128;
const MAX_RPC_BOOTSTRAP_CREDENTIAL_CHARACTERS = 171;

export type RpcHandshakeAuthenticator = (
	request: Request,
) => RpcPeerIdentity | null | Promise<RpcPeerIdentity | null>;

export type RpcHandshakeHeadersProvider = () => Bun.HeadersInit | Promise<Bun.HeadersInit>;

export interface RpcBearerCredentialBinding {
	readonly credential: string;
	readonly identity: RpcPeerIdentity;
}

/**
 * Creates a bootstrap authenticator that derives the canonical peer identity from a bearer
 * credential. Each binding is intentionally tied to one instance and generation; issue a fresh
 * credential when either changes. Credentials are hashed when registered and never included in
 * protocol frames.
 */
export function createRpcBearerAuthenticator(
	bindings: readonly RpcBearerCredentialBinding[],
): RpcHandshakeAuthenticator {
	if (bindings.length === 0) {
		throw new TypeError("At least one RPC bearer credential binding is required.");
	}

	const identitiesByCredentialHash = new Map<string, RpcPeerIdentity>();
	for (const binding of bindings) {
		assertBootstrapCredential(binding.credential);
		const credentialHash = hashCredential(binding.credential);
		if (identitiesByCredentialHash.has(credentialHash)) {
			throw new TypeError("RPC bearer credentials must be unique.");
		}
		identitiesByCredentialHash.set(
			credentialHash,
			Object.freeze(rpcPeerIdentitySchema.parse(binding.identity)),
		);
	}

	return (request) => {
		const credential = readBearerCredential(request.headers.get("authorization"));
		if (credential === null) {
			return null;
		}
		return identitiesByCredentialHash.get(hashCredential(credential)) ?? null;
	};
}

/**
 * Returns a lazy header provider so bootstrap credentials are not retained by an `RpcPeer`
 * or serialized into protocol data.
 */
export function createRpcBearerHandshakeHeaders(credential: string): RpcHandshakeHeadersProvider {
	assertBootstrapCredential(credential);
	return () => ({
		authorization: `Bearer ${credential}`,
	});
}

function assertBootstrapCredential(credential: string): void {
	const decoded = decodeCanonicalBootstrapCredential(credential);
	if (decoded === null) {
		throw new TypeError("RPC bootstrap credentials must be canonical unpadded base64url strings.");
	}

	if (
		decoded.byteLength < MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES ||
		decoded.byteLength > MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES
	) {
		throw new RangeError(
			`RPC bootstrap credentials must encode between ${MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES} and ${MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES} bytes.`,
		);
	}
}

function decodeCanonicalBootstrapCredential(credential: string): Buffer | null {
	if (
		credential.length > MAX_RPC_BOOTSTRAP_CREDENTIAL_CHARACTERS ||
		!/^[A-Za-z0-9_-]+$/.test(credential)
	) {
		return null;
	}
	const decoded = Buffer.from(credential, "base64url");
	return decoded.toString("base64url") === credential ? decoded : null;
}

function hashCredential(credential: string): string {
	return createHash("sha256").update(credential, "ascii").digest("base64url");
}

function readBearerCredential(authorization: string | null): string | null {
	if (authorization === null) {
		return null;
	}
	const match = /^Bearer ([^\s]+)$/i.exec(authorization);
	const credential = match?.[1];
	if (credential === undefined) {
		return null;
	}
	try {
		assertBootstrapCredential(credential);
		return credential;
	} catch {
		return null;
	}
}
