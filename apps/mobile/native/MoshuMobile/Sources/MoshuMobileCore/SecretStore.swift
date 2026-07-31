import Foundation
import Security

/// An injectable key/value secret store. Abstracting the real Keychain behind a protocol lets the
/// security logic (single binding, generation, key persistence) be unit-tested with an in-memory
/// double, while production uses `KeychainSecretStore` backed by `SecItem`.
public protocol SecretStore: AnyObject {
	func get(_ account: String) throws -> Data?
	func set(_ account: String, data: Data) throws
	func delete(_ account: String) throws
}

/// A `SecItem`-backed store. Every item is created with
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `kSecAttrSynchronizable == false`, so secrets
/// never leave the device, never sync to iCloud, and are unavailable while the device is locked.
public final class KeychainSecretStore: SecretStore {
	private let service: String

	public init(service: String) {
		self.service = service
	}

	private func baseQuery(_ account: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecAttrSynchronizable as String: false,
		]
	}

	public func get(_ account: String) throws -> Data? {
		var query = baseQuery(account)
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var item: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &item)
		if status == errSecItemNotFound {
			return nil
		}
		guard status == errSecSuccess, let data = item as? Data else {
			throw MobileTransportError.keychainFailure
		}
		return data
	}

	public func set(_ account: String, data: Data) throws {
		// Never delete-then-add: a failed add after a successful delete would lose the old value
		// (e.g. wiping the persisted generation, which must never regress). Update in place when the
		// item exists, and only add when it is genuinely absent. On any error the old value survives.
		let updateStatus = SecItemUpdate(
			baseQuery(account) as CFDictionary,
			[kSecValueData as String: data] as CFDictionary
		)
		if updateStatus == errSecSuccess {
			return
		}
		guard updateStatus == errSecItemNotFound else {
			throw MobileTransportError.keychainFailure
		}
		var attributes = baseQuery(account)
		attributes[kSecValueData as String] = data
		attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
		let addStatus = SecItemAdd(attributes as CFDictionary, nil)
		guard addStatus == errSecSuccess else {
			throw MobileTransportError.keychainFailure
		}
	}

	public func delete(_ account: String) throws {
		let status = SecItemDelete(baseQuery(account) as CFDictionary)
		guard status == errSecSuccess || status == errSecItemNotFound else {
			throw MobileTransportError.keychainFailure
		}
	}
}

/// A deterministic in-memory `SecretStore` for tests. It has no persistence and no iCloud — it only
/// mirrors the get/set/delete semantics the repositories depend on.
public final class InMemorySecretStore: SecretStore {
	private var storage: [String: Data] = [:]

	public init() {}

	public func get(_ account: String) throws -> Data? { storage[account] }
	public func set(_ account: String, data: Data) throws { storage[account] = data }
	public func delete(_ account: String) throws { storage.removeValue(forKey: account) }

	public var accounts: [String] { Array(storage.keys) }
}
