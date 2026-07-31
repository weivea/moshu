import CryptoKit
import Foundation

/// A software Ed25519 device key backed by CryptoKit `Curve25519.Signing`. This is intentionally a
/// software key (not Secure Enclave — the Enclave only supports P-256); the private key's protection
/// comes from the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, no iCloud sync), never
/// from being exported to JavaScript.
public struct Ed25519DeviceKey {
	public let privateKey: Curve25519.Signing.PrivateKey

	/// The fixed ASN.1 prefix for an Ed25519 SubjectPublicKeyInfo carrying a 32-byte key:
	/// SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING (32 bytes) }.
	private static let spkiPrefix = Data([
		0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
	])

	public init() {
		privateKey = Curve25519.Signing.PrivateKey()
	}

	public init(privateKey: Curve25519.Signing.PrivateKey) {
		self.privateKey = privateKey
	}

	/// Reconstructs the key from its 32-byte raw seed (used by the shared vectors and Keychain load).
	public init(rawSeed: Data) throws {
		privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawSeed)
	}

	public var rawSeed: Data { privateKey.rawRepresentation }

	public var rawPublicKey: Data { privateKey.publicKey.rawRepresentation }

	/// The canonical SPKI-DER encoding the Agent Server contract expects for a device public key.
	public var spkiDER: Data { Ed25519DeviceKey.spkiPrefix + rawPublicKey }

	/// The device public key in the contract wire format: base64url(SPKI-DER).
	public var publicKeyBase64URL: String { Base64URL.encode(spkiDER) }

	public func sign(_ payload: String) throws -> Data {
		try privateKey.signature(for: Data(payload.utf8))
	}

	public func signBase64URL(_ payload: String) throws -> String {
		Base64URL.encode(try sign(payload))
	}

	/// Verifies an Ed25519 signature made by a peer whose 32-byte raw public key is known (used to
	/// verify the Agent Server's app-layer challenge signature against the pinned server key).
	public static func verify(
		signature: Data,
		payload: String,
		rawPublicKey: Data
	) -> Bool {
		guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: rawPublicKey) else {
			return false
		}
		return key.isValidSignature(signature, for: Data(payload.utf8))
	}

	/// Extracts the 32-byte raw key from a canonical SPKI-DER encoding, rejecting anything that is
	/// not exactly the Ed25519 SPKI shape.
	public static func rawPublicKey(fromSPKIDER der: Data) -> Data? {
		guard der.count == spkiPrefix.count + 32, der.prefix(spkiPrefix.count) == spkiPrefix else {
			return nil
		}
		return der.suffix(32)
	}
}
