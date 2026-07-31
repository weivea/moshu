import Foundation
import XCTest

@testable import MoshuMobileCore

/// A `SecretStore` double whose `set` can be made to fail on demand, to prove a failed write never
/// loses or regresses the previously persisted value.
private final class FailableSecretStore: SecretStore {
	private var storage: [String: Data] = [:]
	var failSet = false

	func get(_ account: String) throws -> Data? { storage[account] }
	func set(_ account: String, data: Data) throws {
		if failSet {
			throw MobileTransportError.keychainFailure
		}
		storage[account] = data
	}
	func delete(_ account: String) throws { storage.removeValue(forKey: account) }
	func seed(_ account: String, _ value: String) { storage[account] = Data(value.utf8) }
}

/// Records the sequence of mutating operations so a test can assert the repository never
/// delete-then-adds (which would momentarily lose the value on a crash between the two).
private final class RecordingSecretStore: SecretStore {
	enum Op: Equatable { case get(String), set(String), delete(String) }
	private var storage: [String: Data] = [:]
	private(set) var ops: [Op] = []

	func get(_ account: String) throws -> Data? {
		ops.append(.get(account))
		return storage[account]
	}
	func set(_ account: String, data: Data) throws {
		ops.append(.set(account))
		storage[account] = data
	}
	func delete(_ account: String) throws {
		ops.append(.delete(account))
		storage.removeValue(forKey: account)
	}
}

final class GenerationAtomicityTests: XCTestCase {
	// f4: a failed generation write must retain the old value — never lose or regress it.
	func testSetFailureRetainsOldGeneration() throws {
		let store = FailableSecretStore()
		store.seed("moshu.device.generation", "5")
		let repo = DeviceIdentityRepository(store: store)
		XCTAssertEqual(try repo.currentGeneration(), 5)

		store.failSet = true
		XCTAssertThrowsError(try repo.nextGeneration()) { error in
			XCTAssertEqual(error as? MobileTransportError, .keychainFailure)
		}

		// The persisted generation is unchanged — not wiped, not regressed.
		store.failSet = false
		XCTAssertEqual(try repo.currentGeneration(), 5)
		// And it can still advance once writes succeed again.
		XCTAssertEqual(try repo.nextGeneration(), 6)
	}

	// Concurrent nextGeneration() callers must each get a distinct, strictly-increasing value with no
	// duplicates or gaps, because the read→increment→persist is serialized under the mutation lock.
	func testConcurrentNextGenerationIsDistinctAndMonotonic() {
		let store = InMemorySecretStore()
		let repo = DeviceIdentityRepository(store: store)
		let iterations = 100
		let collected = NSLock()
		var results: [Int] = []

		DispatchQueue.concurrentPerform(iterations: iterations) { _ in
			if let value = try? repo.nextGeneration() {
				collected.lock()
				results.append(value)
				collected.unlock()
			}
		}

		XCTAssertEqual(results.count, iterations)
		XCTAssertEqual(Set(results).count, iterations, "generations must be distinct (no duplicates)")
		XCTAssertEqual(results.min(), 1)
		XCTAssertEqual(results.max(), iterations)
		XCTAssertEqual(try? repo.currentGeneration(), iterations)
	}

	// The repository advances the generation with an in-place set, never a delete-then-add.
	func testNextGenerationDoesNotDeleteThenAdd() throws {
		let store = RecordingSecretStore()
		let repo = DeviceIdentityRepository(store: store)
		_ = try repo.nextGeneration()
		_ = try repo.nextGeneration()

		XCTAssertFalse(
			store.ops.contains(.delete("moshu.device.generation")),
			"nextGeneration must not delete the generation before writing it"
		)
		XCTAssertTrue(store.ops.contains(.set("moshu.device.generation")))
	}
}
