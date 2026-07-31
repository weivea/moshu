import XCTest

@testable import MoshuMobileCore

final class DeviceIdentityRepositoryTests: XCTestCase {
	private func makeBinding(agentServerId: String = "22222222-2222-4222-8222-222222222222") -> MobileBinding {
		MobileBinding(
			agentServerId: agentServerId,
			mobileClientId: "mobile-client-01",
			deviceKeyId: "device-key-01",
			mobileURL: "wss://example.devtunnels.ms/mobile",
			serverPublicKeySPKIBase64URL: "MCowBQYDK2VwAyEADT1eG8Xxe8DTT7ZMDhIpvkNLhegrqhrOsfHF6dTaOKM",
			protocolVersion: 1,
			transportSecurity: "relay-tls",
			serverLabel: "Desktop"
		)
	}

	func testSaveAndLoadBinding() throws {
		let store = InMemorySecretStore()
		let repo = DeviceIdentityRepository(store: store)
		let key = Ed25519DeviceKey()
		let binding = makeBinding()

		XCTAssertFalse(try repo.hasBinding())
		try repo.saveBinding(binding, deviceKey: key)

		XCTAssertTrue(try repo.hasBinding())
		XCTAssertEqual(try repo.loadBinding(), binding)
		XCTAssertEqual(try repo.loadDeviceKey()?.rawSeed, key.rawSeed)
	}

	func testSingleBindingRefusesOverwrite() throws {
		let store = InMemorySecretStore()
		let repo = DeviceIdentityRepository(store: store)
		try repo.saveBinding(makeBinding(), deviceKey: Ed25519DeviceKey())

		XCTAssertThrowsError(
			try repo.saveBinding(
				makeBinding(agentServerId: "99999999-9999-4999-8999-999999999999"),
				deviceKey: Ed25519DeviceKey()
			)
		) { error in
			XCTAssertEqual(error as? MobileTransportError, .alreadyPaired)
		}
		// The original binding is intact.
		XCTAssertEqual(try repo.loadBinding()?.agentServerId, "22222222-2222-4222-8222-222222222222")
	}

	func testUnpairWipesEverything() throws {
		let store = InMemorySecretStore()
		let repo = DeviceIdentityRepository(store: store)
		try repo.saveBinding(makeBinding(), deviceKey: Ed25519DeviceKey())
		_ = try repo.nextGeneration()

		try repo.unpair()

		XCTAssertFalse(try repo.hasBinding())
		XCTAssertNil(try repo.loadBinding())
		XCTAssertNil(try repo.loadDeviceKey())
		XCTAssertEqual(try repo.currentGeneration(), 0)
		XCTAssertTrue(store.accounts.isEmpty)

		// After unpair a fresh binding is allowed (change of server).
		XCTAssertNoThrow(try repo.saveBinding(makeBinding(), deviceKey: Ed25519DeviceKey()))
	}

	func testGenerationIsMonotonic() throws {
		let store = InMemorySecretStore()
		let repo = DeviceIdentityRepository(store: store)
		XCTAssertEqual(try repo.currentGeneration(), 0)
		XCTAssertEqual(try repo.nextGeneration(), 1)
		XCTAssertEqual(try repo.nextGeneration(), 2)
		XCTAssertEqual(try repo.nextGeneration(), 3)
		XCTAssertEqual(try repo.currentGeneration(), 3)

		// A fresh repository over the same store keeps the persisted generation.
		let repo2 = DeviceIdentityRepository(store: store)
		XCTAssertEqual(try repo2.nextGeneration(), 4)
	}

	func testServerFingerprintDerivesFromPinnedKey() {
		let binding = makeBinding()
		XCTAssertTrue(binding.serverPublicKeyFingerprint.hasPrefix("SHA256:"))
		XCTAssertNotNil(binding.serverRawPublicKey)
		XCTAssertEqual(binding.serverRawPublicKey?.count, 32)
	}
}
