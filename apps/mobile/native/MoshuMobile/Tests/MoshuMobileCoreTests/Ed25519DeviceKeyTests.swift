import CryptoKit
import XCTest

@testable import MoshuMobileCore

final class Ed25519DeviceKeyTests: XCTestCase {
	func testGeneratedKeyProducesCanonicalSPKI() {
		let key = Ed25519DeviceKey()
		// SPKI = 12-byte Ed25519 prefix + 32-byte raw key.
		XCTAssertEqual(key.spkiDER.count, 44)
		XCTAssertEqual(key.spkiDER.prefix(12), Data([
			0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
		]))
		XCTAssertEqual(key.spkiDER.suffix(32), key.rawPublicKey)
	}

	func testSignAndVerifyRoundTrip() throws {
		let key = Ed25519DeviceKey()
		let payload = "moshu-canonical-payload"
		let signature = try key.sign(payload)
		XCTAssertTrue(
			Ed25519DeviceKey.verify(
				signature: signature,
				payload: payload,
				rawPublicKey: key.rawPublicKey
			)
		)
		XCTAssertFalse(
			Ed25519DeviceKey.verify(
				signature: signature,
				payload: "tampered",
				rawPublicKey: key.rawPublicKey
			)
		)
	}

	func testRawPublicKeyExtractionRejectsNonSPKI() {
		let key = Ed25519DeviceKey()
		XCTAssertEqual(Ed25519DeviceKey.rawPublicKey(fromSPKIDER: key.spkiDER), key.rawPublicKey)
		XCTAssertNil(Ed25519DeviceKey.rawPublicKey(fromSPKIDER: Data([0x00, 0x01, 0x02])))
		// Wrong prefix, right length.
		var wrong = Data(repeating: 0xaa, count: 44)
		wrong[0] = 0x31
		XCTAssertNil(Ed25519DeviceKey.rawPublicKey(fromSPKIDER: wrong))
	}

	func testSeedReconstructionIsStable() throws {
		let key = Ed25519DeviceKey()
		let seed = key.rawSeed
		let restored = try Ed25519DeviceKey(rawSeed: seed)
		XCTAssertEqual(restored.rawPublicKey, key.rawPublicKey)
		XCTAssertEqual(restored.publicKeyBase64URL, key.publicKeyBase64URL)
	}
}
