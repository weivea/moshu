import XCTest

@testable import MoshuMobileCore

final class Base64URLTests: XCTestCase {
	func testEncodeStripsPaddingAndUsesURLAlphabet() {
		// 0xFB 0xFF encodes to "+/" in standard base64 → "-_" url-safe.
		let data = Data([0xfb, 0xff])
		XCTAssertEqual(Base64URL.encode(data), "-_8")
	}

	func testRoundTrip() throws {
		for length in 0...64 {
			let bytes = (0..<length).map { UInt8(($0 * 37 + 11) % 256) }
			let data = Data(bytes)
			let text = Base64URL.encode(data)
			XCTAssertFalse(text.contains("+"))
			XCTAssertFalse(text.contains("/"))
			XCTAssertFalse(text.contains("="))
			let decoded = try XCTUnwrap(Base64URL.decode(text))
			XCTAssertEqual(decoded, data)
		}
	}

	func testDecodeAcceptsMissingPadding() throws {
		let decoded = try XCTUnwrap(Base64URL.decode("-_8"))
		XCTAssertEqual(decoded, Data([0xfb, 0xff]))
	}
}
