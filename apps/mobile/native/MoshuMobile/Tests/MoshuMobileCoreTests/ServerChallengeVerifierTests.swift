import CryptoKit
import XCTest

@testable import MoshuMobileCore

final class ServerChallengeVerifierTests: XCTestCase {
	/// Builds a binding whose pinned server key is `serverKey`, matching the fixture's first vector
	/// identity so the challenge/input line up.
	private func binding(for serverKey: Ed25519DeviceKey, agentServerId: String) -> MobileBinding {
		MobileBinding(
			agentServerId: agentServerId,
			mobileClientId: "mobile-client-01",
			deviceKeyId: "device-key-01",
			mobileURL: "wss://example.devtunnels.ms/mobile",
			serverPublicKeySPKIBase64URL: serverKey.publicKeyBase64URL,
			protocolVersion: 1,
			transportSecurity: "relay-tls",
			serverLabel: "Desktop"
		)
	}

	func testVerifiesValidServerSignatureAndSignsAuthentication() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let vector = try XCTUnwrap(fixture.vectors.first)
		let serverKey = Ed25519DeviceKey()
		let deviceKey = Ed25519DeviceKey()
		let binding = binding(for: serverKey, agentServerId: vector.challenge.agentServerId)

		let serverPayload = MobileCanonicalPayload.serverChallengePayload(
			input: vector.input,
			challenge: vector.challenge
		)
		let serverSignature = Base64URL.encode(try serverKey.sign(serverPayload))

		XCTAssertNoThrow(
			try ServerChallengeVerifier.verifyServerChallenge(
				input: vector.input,
				challenge: vector.challenge,
				serverSignatureBase64URL: serverSignature,
				binding: binding
			)
		)

		let proof = try ServerChallengeVerifier.signAuthentication(
			input: vector.input,
			challenge: vector.challenge,
			deviceKey: deviceKey
		)
		let authPayload = MobileCanonicalPayload.authenticationPayload(
			input: vector.input,
			challenge: vector.challenge
		)
		XCTAssertTrue(
			Ed25519DeviceKey.verify(
				signature: try XCTUnwrap(Base64URL.decode(proof)),
				payload: authPayload,
				rawPublicKey: deviceKey.rawPublicKey
			)
		)
	}

	func testRejectsSignatureFromWrongServerKey() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let vector = try XCTUnwrap(fixture.vectors.first)
		let pinnedKey = Ed25519DeviceKey()
		let attackerKey = Ed25519DeviceKey()
		let binding = binding(for: pinnedKey, agentServerId: vector.challenge.agentServerId)

		let serverPayload = MobileCanonicalPayload.serverChallengePayload(
			input: vector.input,
			challenge: vector.challenge
		)
		let forged = Base64URL.encode(try attackerKey.sign(serverPayload))

		XCTAssertThrowsError(
			try ServerChallengeVerifier.verifyServerChallenge(
				input: vector.input,
				challenge: vector.challenge,
				serverSignatureBase64URL: forged,
				binding: binding
			)
		) { error in
			XCTAssertEqual(error as? MobileTransportError, .identityMismatch)
		}
	}

	func testRejectsAgentServerIdMismatch() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let vector = try XCTUnwrap(fixture.vectors.first)
		let serverKey = Ed25519DeviceKey()
		let binding = binding(for: serverKey, agentServerId: "00000000-0000-4000-8000-000000000000")

		let serverPayload = MobileCanonicalPayload.serverChallengePayload(
			input: vector.input,
			challenge: vector.challenge
		)
		let serverSignature = Base64URL.encode(try serverKey.sign(serverPayload))

		XCTAssertThrowsError(
			try ServerChallengeVerifier.verifyServerChallenge(
				input: vector.input,
				challenge: vector.challenge,
				serverSignatureBase64URL: serverSignature,
				binding: binding
			)
		) { error in
			XCTAssertEqual(error as? MobileTransportError, .identityMismatch)
		}
	}

	func testRejectsProtocolMismatch() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		let vector = try XCTUnwrap(fixture.vectors.first)
		let serverKey = Ed25519DeviceKey()
		var mismatched = binding(for: serverKey, agentServerId: vector.challenge.agentServerId)
		mismatched = MobileBinding(
			agentServerId: mismatched.agentServerId,
			mobileClientId: mismatched.mobileClientId,
			deviceKeyId: mismatched.deviceKeyId,
			mobileURL: mismatched.mobileURL,
			serverPublicKeySPKIBase64URL: mismatched.serverPublicKeySPKIBase64URL,
			protocolVersion: 999,
			transportSecurity: mismatched.transportSecurity,
			serverLabel: mismatched.serverLabel
		)

		let serverPayload = MobileCanonicalPayload.serverChallengePayload(
			input: vector.input,
			challenge: vector.challenge
		)
		let serverSignature = Base64URL.encode(try serverKey.sign(serverPayload))

		XCTAssertThrowsError(
			try ServerChallengeVerifier.verifyServerChallenge(
				input: vector.input,
				challenge: vector.challenge,
				serverSignatureBase64URL: serverSignature,
				binding: mismatched
			)
		) { error in
			XCTAssertEqual(error as? MobileTransportError, .protocolMismatch)
		}
	}
}
