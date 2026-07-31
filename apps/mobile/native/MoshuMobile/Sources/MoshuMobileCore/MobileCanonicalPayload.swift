import Foundation

/// The Agent Server RPC identity carried in a challenge (role is always "agents" for the server).
public struct MobileRpcIdentity: Equatable, Codable {
	public let role: String
	public let peerId: String
	public let instanceId: String
	public let generation: Int

	public init(role: String, peerId: String, instanceId: String, generation: Int) {
		self.role = role
		self.peerId = peerId
		self.instanceId = instanceId
		self.generation = generation
	}
}

/// The client-supplied challenge request. `generation` is the device's monotonic connection
/// generation; `instanceId` is fresh per connection.
public struct MobileChallengeInput: Equatable, Codable {
	public let mobileClientId: String
	public let deviceKeyId: String
	public let instanceId: String
	public let generation: Int
	public let protocolVersion: Int

	public init(
		mobileClientId: String,
		deviceKeyId: String,
		instanceId: String,
		generation: Int,
		protocolVersion: Int
	) {
		self.mobileClientId = mobileClientId
		self.deviceKeyId = deviceKeyId
		self.instanceId = instanceId
		self.generation = generation
		self.protocolVersion = protocolVersion
	}
}

/// The server's challenge (minus its signature). Field names and order match
/// `mobileChallengeOutputSchema` in `packages/contracts/src/mobile.ts`.
public struct MobileServerChallenge: Equatable, Codable {
	public let challengeId: String
	public let nonce: String
	public let expiresAt: String
	public let agentServerId: String
	public let rpcIdentity: MobileRpcIdentity
	public let actionJournalEpoch: String
	public let negotiatedProtocolVersion: Int
	public let transportSecurity: String
	public let supportedTransportSecurity: [String]

	public init(
		challengeId: String,
		nonce: String,
		expiresAt: String,
		agentServerId: String,
		rpcIdentity: MobileRpcIdentity,
		actionJournalEpoch: String,
		negotiatedProtocolVersion: Int,
		transportSecurity: String,
		supportedTransportSecurity: [String]
	) {
		self.challengeId = challengeId
		self.nonce = nonce
		self.expiresAt = expiresAt
		self.agentServerId = agentServerId
		self.rpcIdentity = rpcIdentity
		self.actionJournalEpoch = actionJournalEpoch
		self.negotiatedProtocolVersion = negotiatedProtocolVersion
		self.transportSecurity = transportSecurity
		self.supportedTransportSecurity = supportedTransportSecurity
	}
}

/// Byte-for-byte Swift equivalents of the canonical payload builders in
/// `packages/contracts/src/mobile.ts`. The tags and field ORDER must never diverge from the TS
/// source; the shared test vectors enforce this.
public enum MobileCanonicalPayload {
	public static let serverChallengeTag = "moshu-mobile-server-challenge-v1"
	public static let authenticationTag = "moshu-mobile-authentication-v1"

	public static func serverChallengePayload(
		input: MobileChallengeInput,
		challenge: MobileServerChallenge
	) -> String {
		CanonicalJSON.encodeArray(fields(tag: serverChallengeTag, input: input, challenge: challenge))
	}

	public static func authenticationPayload(
		input: MobileChallengeInput,
		challenge: MobileServerChallenge
	) -> String {
		CanonicalJSON.encodeArray(fields(tag: authenticationTag, input: input, challenge: challenge))
	}

	private static func fields(
		tag: String,
		input: MobileChallengeInput,
		challenge: MobileServerChallenge
	) -> [CanonicalJSONValue] {
		[
			.string(tag),
			.string(challenge.agentServerId),
			.string(challenge.rpcIdentity.role),
			.string(challenge.rpcIdentity.peerId),
			.string(challenge.rpcIdentity.instanceId),
			.int(challenge.rpcIdentity.generation),
			.string(challenge.actionJournalEpoch),
			.int(challenge.negotiatedProtocolVersion),
			.string(challenge.transportSecurity),
			.stringArray(challenge.supportedTransportSecurity),
			.string(input.mobileClientId),
			.string(input.deviceKeyId),
			.string(input.instanceId),
			.int(input.generation),
			.int(input.protocolVersion),
			.string(challenge.challengeId),
			.string(challenge.nonce),
			.string(challenge.expiresAt),
		]
	}
}
