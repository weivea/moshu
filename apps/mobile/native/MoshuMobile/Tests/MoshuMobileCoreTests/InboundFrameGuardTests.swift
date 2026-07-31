import XCTest

@testable import MoshuMobileCore

final class InboundFrameGuardTests: XCTestCase {
	// f5: the limit is enforced on the UTF-8 byte count, not the character count, so a multibyte
	// payload with few characters but many bytes cannot slip past.
	func testMultibyteOversizeIsRejectedByByteCount() {
		let guardian = InboundFrameGuard(maxFrameBytes: 5)

		// "hello" = 5 ASCII bytes == the limit → accepted.
		XCTAssertEqual(guardian.evaluateText("hello"), .accept)

		// "héllo" is 5 characters but 6 UTF-8 bytes (é = 2 bytes) → oversize, even though the
		// character count would have passed.
		XCTAssertEqual("héllo".count, 5)
		XCTAssertEqual("héllo".utf8.count, 6)
		XCTAssertEqual(guardian.evaluateText("héllo"), .rejectOversize(bytes: 6, max: 5))
	}

	func testEmojiOversize() {
		let guardian = InboundFrameGuard(maxFrameBytes: 3)
		// A single emoji is 4 UTF-8 bytes.
		XCTAssertEqual(guardian.evaluateText("😀"), .rejectOversize(bytes: 4, max: 3))
	}

	func testWithinBudgetAccepts() {
		let guardian = InboundFrameGuard(maxFrameBytes: 1024)
		XCTAssertEqual(guardian.evaluateText("{\"type\":\"request\"}"), .accept)
		XCTAssertEqual(guardian.evaluateText(""), .accept)
	}

	// A binary frame is never silently consumed — the text-only transport protocol-closes it.
	func testBinaryFrameIsRejected() {
		let guardian = InboundFrameGuard(maxFrameBytes: 1024)
		XCTAssertEqual(guardian.evaluateBinary(), .rejectBinary)
	}

	func testProductDefaultMatchesFrameLimits() {
		XCTAssertEqual(InboundFrameGuard.productDefault.maxFrameBytes, FrameLimits.productDefault.maxFrameBytes)
		XCTAssertEqual(InboundFrameGuard.productDefault.maxFrameBytes, 1_048_576)
	}
}
