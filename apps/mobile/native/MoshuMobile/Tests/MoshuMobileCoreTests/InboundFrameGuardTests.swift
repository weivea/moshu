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
		XCTAssertEqual(InboundFrameGuard.productDefault.maxFrameBytes, 4_194_304)
	}

	// The product frame limit is aligned to the JS Product-RPC cap (`productRpcMaxFrameBytes`, 4 MiB)
	// via the shared canonical fixture, so native inbound / outbound / pre-bind can't drift from JS.
	func testProductLimitsMatchSharedFixture() throws {
		let fixture = try FixtureLoader.canonicalVectors()
		XCTAssertEqual(fixture.transportLimits.maxFrameBytes, 4_194_304)
		XCTAssertEqual(FrameLimits.productDefault.maxFrameBytes, fixture.transportLimits.maxFrameBytes)
		XCTAssertEqual(FrameLimits.productDefault.maxQueuedBytes, fixture.transportLimits.maxQueuedBytes)
		XCTAssertEqual(InboundFrameGuard.productDefault.maxFrameBytes, fixture.transportLimits.maxFrameBytes)
		// The queued-bytes bound is conservative but must never be below a single max frame.
		XCTAssertGreaterThanOrEqual(FrameLimits.productDefault.maxQueuedBytes, FrameLimits.productDefault.maxFrameBytes)
	}

	// f-limits: a frame between the old 1 MiB cap and the new 4 MiB cap is now ACCEPTED (it would have
	// been wrongly rejected before), 4 MiB exactly is accepted, and 4 MiB + 1 byte is rejected.
	func testFourMebibyteBoundary() {
		let guardian = InboundFrameGuard.productDefault
		let max = guardian.maxFrameBytes

		let oneAndAHalfMiB = String(repeating: "a", count: 1_572_864) // 1.5 MiB, was rejected at 1 MiB
		XCTAssertEqual(oneAndAHalfMiB.utf8.count, 1_572_864)
		XCTAssertEqual(guardian.evaluateText(oneAndAHalfMiB), .accept)

		let atLimit = String(repeating: "a", count: max)
		XCTAssertEqual(guardian.evaluateText(atLimit), .accept)

		let overByOne = String(repeating: "a", count: max + 1)
		XCTAssertEqual(guardian.evaluateText(overByOne), .rejectOversize(bytes: max + 1, max: max))
	}

	// The oversize check counts UTF-8 bytes: a multibyte string one scalar over the cap is rejected.
	func testFourMebibyteBoundaryMultibyte() {
		let guardian = InboundFrameGuard.productDefault
		let max = guardian.maxFrameBytes
		// (max - 1) ASCII bytes + one 2-byte scalar = max + 1 bytes → oversize.
		let payload = String(repeating: "a", count: max - 1) + "é"
		XCTAssertEqual(payload.utf8.count, max + 1)
		XCTAssertEqual(guardian.evaluateText(payload), .rejectOversize(bytes: max + 1, max: max))
	}

	// The decision exposes the stable protocol close code the engine sends.
	func testDecisionCloseCodes() {
		XCTAssertNil(InboundFrameDecision.accept.closeCode)
		XCTAssertEqual(InboundFrameDecision.rejectOversize(bytes: 10, max: 5).closeCode, 1009)
		XCTAssertEqual(InboundFrameDecision.rejectBinary.closeCode, 1003)
		XCTAssertEqual(InboundFrameCloseCode.oversize, 1009)
		XCTAssertEqual(InboundFrameCloseCode.binary, 1003)
	}
}
