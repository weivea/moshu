import XCTest

@testable import MoshuMobileCore

final class MobileHandshakeIdentityTests: XCTestCase {
	private func makeBinding() -> MobileBinding {
		MobileBinding(
			agentServerId: "22222222-2222-4222-8222-222222222222",
			mobileClientId: "mobile-client-01",
			deviceKeyId: "device-key-01",
			mobileURL: "wss://example.devtunnels.ms/mobile",
			serverPublicKeySPKIBase64URL: "MCowBQYDK2VwAyEADT1eG8Xxe8DTT7ZMDhIpvkNLhegrqhrOsfHF6dTaOKM",
			protocolVersion: 1,
			transportSecurity: "relay-tls",
			serverLabel: "Desktop"
		)
	}

	// f1: the mobile hello identity MUST include deviceKeyId so it matches the Layer 3 authenticated
	// canonical identity exactly; the server rejects the hello otherwise.
	func testLocalIdentityIncludesDeviceKeyId() {
		let binding = makeBinding()
		let identity = MobileHandshakeIdentity.local(binding: binding, instanceId: "i-1", generation: 2)

		XCTAssertEqual(identity.role, "mobile-client")
		XCTAssertEqual(identity.peerId, binding.mobileClientId)
		XCTAssertEqual(identity.instanceId, "i-1")
		XCTAssertEqual(identity.generation, 2)
		XCTAssertEqual(identity.deviceKeyId, binding.deviceKeyId)

		let dictionary = identity.asDictionary()
		XCTAssertEqual(dictionary["role"] as? String, "mobile-client")
		XCTAssertEqual(dictionary["peerId"] as? String, binding.mobileClientId)
		XCTAssertEqual(dictionary["instanceId"] as? String, "i-1")
		XCTAssertEqual(dictionary["generation"] as? Int, 2)
		XCTAssertEqual(dictionary["deviceKeyId"] as? String, "device-key-01")
	}

	// The server (role "agents") identity has no device key; the key must be absent (not null) so the
	// dictionary round-trips to the same canonical identity the peer authenticated.
	func testServerIdentityOmitsDeviceKeyId() {
		let identity = MobileHandshakeIdentity.server(
			role: "agents",
			peerId: "agents-1",
			instanceId: "ai-1",
			generation: 3
		)

		XCTAssertNil(identity.deviceKeyId)
		let dictionary = identity.asDictionary()
		XCTAssertNil(dictionary["deviceKeyId"])
		XCTAssertEqual(dictionary.keys.sorted(), ["generation", "instanceId", "peerId", "role"])
	}
}
