import Foundation

/// The process-rpc peer identity the Mobile client presents in its `hello` envelope. It MUST be
/// byte-for-byte the same identity the Agent Server authenticated on the WSS upgrade — including
/// `deviceKeyId`. The server compares the hello `peer` against the authenticated identity with
/// `isSameRpcPeerIdentity` (which compares `deviceKeyId`), and echoes it back as `acceptedPeer`, so
/// omitting `deviceKeyId` here makes the real handshake fail with an identity mismatch.
public struct MobileHelloIdentity: Equatable {
	public let role: String
	public let peerId: String
	public let instanceId: String
	public let generation: Int
	public let deviceKeyId: String?

	public init(role: String, peerId: String, instanceId: String, generation: Int, deviceKeyId: String?) {
		self.role = role
		self.peerId = peerId
		self.instanceId = instanceId
		self.generation = generation
		self.deviceKeyId = deviceKeyId
	}

	/// The Capacitor-bridge dictionary. `deviceKeyId` is included only when present so the server's
	/// role-`agents` identity (which has none) round-trips unchanged.
	public func asDictionary() -> [String: Any] {
		var value: [String: Any] = [
			"role": role,
			"peerId": peerId,
			"instanceId": instanceId,
			"generation": generation,
		]
		if let deviceKeyId {
			value["deviceKeyId"] = deviceKeyId
		}
		return value
	}
}

public enum MobileHandshakeIdentity {
	/// The authenticated mobile-client identity. `deviceKeyId` is required so the hello matches the
	/// server's authenticated canonical identity exactly.
	public static func local(
		binding: MobileBinding,
		instanceId: String,
		generation: Int
	) -> MobileHelloIdentity {
		MobileHelloIdentity(
			role: "mobile-client",
			peerId: binding.mobileClientId,
			instanceId: instanceId,
			generation: generation,
			deviceKeyId: binding.deviceKeyId
		)
	}

	/// The Agent Server (role "agents") identity the plugin verified via the signed challenge. It
	/// carries no `deviceKeyId`.
	public static func server(
		role: String,
		peerId: String,
		instanceId: String,
		generation: Int
	) -> MobileHelloIdentity {
		MobileHelloIdentity(
			role: role,
			peerId: peerId,
			instanceId: instanceId,
			generation: generation,
			deviceKeyId: nil
		)
	}
}
