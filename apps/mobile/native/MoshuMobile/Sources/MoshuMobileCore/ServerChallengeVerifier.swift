import Foundation

/// Verifies the Agent Server's app-layer challenge and produces the device-signed upgrade proof.
///
/// The flow, per the Mobile ingress contract:
/// 1. The client requests a challenge with its `MobileChallengeInput`.
/// 2. The server returns a `MobileServerChallenge` plus an Ed25519 `signature` over the canonical
///    server-challenge payload, made with the server's app-layer key.
/// 3. The client verifies that signature against the *pinned* server key (not the TLS/relay cert),
///    and checks the challenge's identity/protocol match the binding.
/// 4. The client signs the canonical authentication payload with its device key; that signature
///    becomes the WSS upgrade proof.
public enum ServerChallengeVerifier {
	/// Verifies the server's signature over the canonical server-challenge payload and that the
	/// challenge's identity matches the pinned binding. Throws `.identityMismatch` on any mismatch.
	public static func verifyServerChallenge(
		input: MobileChallengeInput,
		challenge: MobileServerChallenge,
		serverSignatureBase64URL: String,
		binding: MobileBinding
	) throws {
		guard challenge.rpcIdentity.role == "agents" else {
			throw MobileTransportError.identityMismatch
		}
		guard challenge.agentServerId == binding.agentServerId else {
			throw MobileTransportError.identityMismatch
		}
		guard challenge.negotiatedProtocolVersion == binding.protocolVersion else {
			throw MobileTransportError.protocolMismatch
		}
		guard let serverRawKey = binding.serverRawPublicKey else {
			throw MobileTransportError.identityMismatch
		}
		guard let signature = Base64URL.decode(serverSignatureBase64URL) else {
			throw MobileTransportError.identityMismatch
		}
		let payload = MobileCanonicalPayload.serverChallengePayload(input: input, challenge: challenge)
		let ok = Ed25519DeviceKey.verify(
			signature: signature,
			payload: payload,
			rawPublicKey: serverRawKey
		)
		guard ok else {
			throw MobileTransportError.identityMismatch
		}
	}

	/// Signs the canonical authentication payload with the device key, returning the base64url
	/// signature to carry as the WSS upgrade proof.
	public static func signAuthentication(
		input: MobileChallengeInput,
		challenge: MobileServerChallenge,
		deviceKey: Ed25519DeviceKey
	) throws -> String {
		let payload = MobileCanonicalPayload.authenticationPayload(input: input, challenge: challenge)
		return try deviceKey.signBase64URL(payload)
	}
}
