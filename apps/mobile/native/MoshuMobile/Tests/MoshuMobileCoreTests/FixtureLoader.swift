import Foundation
import XCTest

@testable import MoshuMobileCore

/// Decoded shape of `Fixtures/mobile-canonical-vectors.json`, the shared TS/Swift vectors.
struct CanonicalVectorsFixture: Decodable {
	struct DeviceKey: Decodable {
		let seedUtf8: String
		let seedHex: String
		let rawPublicKeyHex: String
		let spkiDerHex: String
		let spkiDerBase64Url: String
	}

	struct Vector: Decodable {
		let name: String
		let input: MobileChallengeInput
		let challenge: MobileServerChallenge
		let serverChallengePayload: String
		let authenticationPayload: String
		let serverChallengePayloadSignature: String
		let authenticationPayloadSignature: String
	}

	let serverChallengeTag: String
	let authenticationTag: String
	let deviceKey: DeviceKey
	let vectors: [Vector]
}

enum FixtureLoader {
	static func canonicalVectors() throws -> CanonicalVectorsFixture {
		guard
			let url = Bundle.module.url(
				forResource: "mobile-canonical-vectors",
				withExtension: "json",
				subdirectory: "Fixtures"
			)
		else {
			throw XCTSkip("Canonical vectors fixture not found in test bundle")
		}
		let data = try Data(contentsOf: url)
		return try JSONDecoder().decode(CanonicalVectorsFixture.self, from: data)
	}
}

/// Decodes a hex string into `Data`.
func dataFromHex(_ hex: String) -> Data? {
	guard hex.count % 2 == 0 else { return nil }
	var data = Data(capacity: hex.count / 2)
	var index = hex.startIndex
	while index < hex.endIndex {
		let next = hex.index(index, offsetBy: 2)
		guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
		data.append(byte)
		index = next
	}
	return data
}

func hexFromData(_ data: Data) -> String {
	data.map { String(format: "%02x", $0) }.joined()
}
