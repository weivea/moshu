import CryptoKit
import XCTest

@testable import MoshuMobileCore

/// Proves the Swift canonical payload builders and Ed25519 signing are byte-for-byte identical to the
/// TypeScript contracts, using the shared vectors. If this passes, a Swift-signed upgrade proof is
/// verifiable by the Agent Server exactly as a JS-signed one would be.
final class CanonicalVectorsTests: XCTestCase {
	func testServerChallengePayloadMatchesFixture() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		for vector in fixture.vectors {
			let payload = MobileCanonicalPayload.serverChallengePayload(
				input: vector.input,
				challenge: vector.challenge
			)
			XCTAssertEqual(payload, vector.serverChallengePayload, "vector \(vector.name)")
		}
	}

	func testAuthenticationPayloadMatchesFixture() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		for vector in fixture.vectors {
			let payload = MobileCanonicalPayload.authenticationPayload(
				input: vector.input,
				challenge: vector.challenge
			)
			XCTAssertEqual(payload, vector.authenticationPayload, "vector \(vector.name)")
		}
	}

	func testDeviceKeyDerivationMatchesFixture() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let seed = try XCTUnwrap(dataFromHex(fixture.deviceKey.seedHex))
		let key = try Ed25519DeviceKey(rawSeed: seed)

		XCTAssertEqual(hexFromData(key.rawPublicKey), fixture.deviceKey.rawPublicKeyHex)
		XCTAssertEqual(hexFromData(key.spkiDER), fixture.deviceKey.spkiDerHex)
		XCTAssertEqual(key.publicKeyBase64URL, fixture.deviceKey.spkiDerBase64Url)
	}

	func testSeedFromUtf8MatchesSeedHex() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let utf8Seed = Data(fixture.deviceKey.seedUtf8.utf8)
		XCTAssertEqual(hexFromData(utf8Seed), fixture.deviceKey.seedHex)
	}

	func testFixtureSignaturesVerifyCrossImplementation() throws {
		// The fixture signatures are produced by node/OpenSSL (deterministic RFC 8032). CryptoKit
		// verifies them, proving a JS-signed value is accepted by the Swift verifier — the interop
		// guarantee that actually matters at the transport boundary.
		let fixture = try FixtureLoader.canonicalVectors()
		let seed = try XCTUnwrap(dataFromHex(fixture.deviceKey.seedHex))
		let key = try Ed25519DeviceKey(rawSeed: seed)

		for vector in fixture.vectors {
			let authSignature = try XCTUnwrap(Base64URL.decode(vector.authenticationPayloadSignature))
			XCTAssertTrue(
				Ed25519DeviceKey.verify(
					signature: authSignature,
					payload: vector.authenticationPayload,
					rawPublicKey: key.rawPublicKey
				),
				"authentication signature, vector \(vector.name)"
			)

			let serverSignature = try XCTUnwrap(Base64URL.decode(vector.serverChallengePayloadSignature))
			XCTAssertTrue(
				Ed25519DeviceKey.verify(
					signature: serverSignature,
					payload: vector.serverChallengePayload,
					rawPublicKey: key.rawPublicKey
				),
				"server challenge signature, vector \(vector.name)"
			)
		}
	}

	func testSwiftSignatureVerifiesWithSharedPublicKey() throws {
		// CryptoKit's Ed25519 signatures are randomized (not byte-identical to node's), but must still
		// verify under standard RFC 8032 verification — i.e. the Agent Server would accept them.
		let fixture = try FixtureLoader.canonicalVectors()
		let seed = try XCTUnwrap(dataFromHex(fixture.deviceKey.seedHex))
		let key = try Ed25519DeviceKey(rawSeed: seed)

		for vector in fixture.vectors {
			let signature = try ServerChallengeVerifier.signAuthentication(
				input: vector.input,
				challenge: vector.challenge,
				deviceKey: key
			)
			let raw = try XCTUnwrap(Base64URL.decode(signature))
			XCTAssertTrue(
				Ed25519DeviceKey.verify(
					signature: raw,
					payload: vector.authenticationPayload,
					rawPublicKey: key.rawPublicKey
				),
				"vector \(vector.name)"
			)
		}
	}

	func testTagsMatchFixture() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		XCTAssertEqual(MobileCanonicalPayload.serverChallengeTag, fixture.serverChallengeTag)
		XCTAssertEqual(MobileCanonicalPayload.authenticationTag, fixture.authenticationTag)
	}
}
