import CryptoKit
import Foundation

/// SHA-256 fingerprint helper. Produces a stable, displayable, non-secret fingerprint of a public
/// key (safe to show in Settings) in the form `SHA256:<base64url>`.
public enum Fingerprint {
	public static func of(_ data: Data) -> String {
		let digest = SHA256.hash(data: data)
		return "SHA256:" + Base64URL.encode(Data(digest))
	}
}

/// The single-server binding. First-version rule: one iPhone binds to exactly one Agent Server; the
/// exact mobile URL and the pinned server public key are persisted here and never overwritten
/// without an explicit unpair. No business data is stored — only the identity/transport binding.
public struct MobileBinding: Codable, Equatable {
	public let agentServerId: String
	public let mobileClientId: String
	public let deviceKeyId: String
	/// The exact authenticated Mobile ingress URL (wss). Pinned; JS never sees it.
	public let mobileURL: String
	/// The pinned Agent Server public key, canonical SPKI-DER, base64url.
	public let serverPublicKeySPKIBase64URL: String
	public let protocolVersion: Int
	public let transportSecurity: String
	public let serverLabel: String

	public init(
		agentServerId: String,
		mobileClientId: String,
		deviceKeyId: String,
		mobileURL: String,
		serverPublicKeySPKIBase64URL: String,
		protocolVersion: Int,
		transportSecurity: String,
		serverLabel: String
	) {
		self.agentServerId = agentServerId
		self.mobileClientId = mobileClientId
		self.deviceKeyId = deviceKeyId
		self.mobileURL = mobileURL
		self.serverPublicKeySPKIBase64URL = serverPublicKeySPKIBase64URL
		self.protocolVersion = protocolVersion
		self.transportSecurity = transportSecurity
		self.serverLabel = serverLabel
	}

	public var serverPublicKeyFingerprint: String {
		guard let der = Base64URL.decode(serverPublicKeySPKIBase64URL) else {
			return "SHA256:invalid"
		}
		return Fingerprint.of(der)
	}

	/// The 32-byte raw server key extracted from the pinned SPKI-DER, for signature verification.
	public var serverRawPublicKey: Data? {
		guard let der = Base64URL.decode(serverPublicKeySPKIBase64URL) else { return nil }
		return Ed25519DeviceKey.rawPublicKey(fromSPKIDER: der)
	}
}

/// Persists the device identity: the software Ed25519 private key, the single binding, and the
/// monotonic connection generation. Enforces the single-binding rule (a second bind without unpair
/// throws `.alreadyPaired`) and, on unpair, wipes the key, binding, and generation so no residue
/// remains.
public final class DeviceIdentityRepository {
	private enum Account {
		static let privateKey = "moshu.device.privateKeySeed"
		static let binding = "moshu.device.binding"
		static let generation = "moshu.device.generation"
	}

	private let store: SecretStore
	// Serializes the read-modify-write mutations (generation bump, save, unpair) so two concurrent
	// callers can't both read the same generation and persist a duplicate, and so a save/unpair is
	// never interleaved. Keychain writes complete before the lock is released.
	private let mutationLock = NSLock()

	public init(store: SecretStore) {
		self.store = store
	}

	// MARK: Binding

	public func hasBinding() throws -> Bool {
		try store.get(Account.binding) != nil
	}

	public func loadBinding() throws -> MobileBinding? {
		guard let data = try store.get(Account.binding) else { return nil }
		return try JSONDecoder().decode(MobileBinding.self, from: data)
	}

	/// Atomically persists the device key + binding. Refuses to overwrite an existing binding — the
	/// caller must `unpair()` first. This is the single-binding guarantee.
	public func saveBinding(_ binding: MobileBinding, deviceKey: Ed25519DeviceKey) throws {
		mutationLock.lock()
		defer { mutationLock.unlock() }
		if try hasBinding() {
			throw MobileTransportError.alreadyPaired
		}
		let encoded = try JSONEncoder().encode(binding)
		try store.set(Account.privateKey, data: deviceKey.rawSeed)
		try store.set(Account.binding, data: encoded)
	}

	// MARK: Device key

	public func loadDeviceKey() throws -> Ed25519DeviceKey? {
		guard let seed = try store.get(Account.privateKey) else { return nil }
		return try Ed25519DeviceKey(rawSeed: seed)
	}

	// MARK: Generation

	public func currentGeneration() throws -> Int {
		guard let data = try store.get(Account.generation),
			let text = String(data: data, encoding: .utf8),
			let value = Int(text)
		else {
			return 0
		}
		return value
	}

	/// Returns a strictly-increasing generation, persisting the new value. Each connection attempt
	/// takes a fresh generation so an old, revoked generation can never be reused. The read →
	/// increment → persist sequence is serialized under `mutationLock`, and the new value is written
	/// to the store before returning, so concurrent callers get distinct, monotonic generations and a
	/// failed write never advances (or regresses) the persisted value.
	@discardableResult
	public func nextGeneration() throws -> Int {
		mutationLock.lock()
		defer { mutationLock.unlock() }
		let next = try currentGeneration() + 1
		try store.set(Account.generation, data: Data(String(next).utf8))
		return next
	}

	// MARK: Unpair

	public func unpair() throws {
		mutationLock.lock()
		defer { mutationLock.unlock() }
		try store.delete(Account.binding)
		try store.delete(Account.privateKey)
		try store.delete(Account.generation)
	}
}
