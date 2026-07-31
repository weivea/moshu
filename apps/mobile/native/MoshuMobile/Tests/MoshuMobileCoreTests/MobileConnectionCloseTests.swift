import XCTest

@testable import MoshuMobileCore

final class MobileConnectionCloseTests: XCTestCase {
	// f2: a live device revoked by the Desktop is closed with WS 1008 → AUTH_REVOKED.
	func testWebSocket1008IsAuthRevoked() {
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: 1008, httpStatus: nil),
			.authRevoked
		)
	}

	// A rejected WSS upgrade returns HTTP 401/403 → AUTH_FAILED (generic auth rejection).
	func testHttp401And403AreAuthFailed() {
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: nil, httpStatus: 401),
			.authFailed
		)
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: nil, httpStatus: 403),
			.authFailed
		)
	}

	// A protocol-version mismatch on the upgrade returns HTTP 426 → PROTOCOL_MISMATCH.
	func testHttp426IsProtocolMismatch() {
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: nil, httpStatus: 426),
			.protocolMismatch
		)
	}

	// A successful upgrade (101) followed by a 1008 revoke close must classify from the close code —
	// the 101 status must not shadow the fatal WS close.
	func testUpgrade101WithRevokeCloseIsAuthRevoked() {
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: 1008, httpStatus: 101),
			.authRevoked
		)
	}

	// Anything not explicitly fatal is transient and may be retried.
	func testTransientCases() {
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: 1006, httpStatus: nil),
			.transient
		)
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: nil, httpStatus: nil),
			.transient
		)
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: nil, httpStatus: 500),
			.transient
		)
		XCTAssertEqual(
			MobileConnectionCloseClassifier.classify(closeCode: 1000, httpStatus: nil),
			.transient
		)
	}

	func testIsFatalFlag() {
		XCTAssertTrue(MobileConnectionCloseReason.authRevoked.isFatal)
		XCTAssertTrue(MobileConnectionCloseReason.authFailed.isFatal)
		XCTAssertTrue(MobileConnectionCloseReason.protocolMismatch.isFatal)
		XCTAssertFalse(MobileConnectionCloseReason.transient.isFatal)
	}

	func testRawTokensAreStableAndNonLocalized() {
		XCTAssertEqual(MobileConnectionCloseReason.authRevoked.rawValue, "AUTH_REVOKED")
		XCTAssertEqual(MobileConnectionCloseReason.authFailed.rawValue, "AUTH_FAILED")
		XCTAssertEqual(MobileConnectionCloseReason.protocolMismatch.rawValue, "PROTOCOL_MISMATCH")
	}

	// f-close: the teardown path must send the SPECIFIC close code (not always .goingAway) so the peer
	// learns why. Oversize → messageTooBig (1009), binary → unsupportedData (1003).
	func testSendableCodeMapsProtocolCloses() {
		XCTAssertEqual(WebSocketClose.sendableCode(InboundFrameCloseCode.oversize), .messageTooBig)
		XCTAssertEqual(WebSocketClose.sendableCode(InboundFrameCloseCode.binary), .unsupportedData)
		XCTAssertEqual(WebSocketClose.sendableCode(1009), .messageTooBig)
		XCTAssertEqual(WebSocketClose.sendableCode(1003), .unsupportedData)
	}

	func testSendableCodeMapsStandardCodes() {
		XCTAssertEqual(WebSocketClose.sendableCode(1000), .normalClosure)
		XCTAssertEqual(WebSocketClose.sendableCode(1001), .goingAway)
		XCTAssertEqual(WebSocketClose.sendableCode(1002), .protocolError)
		XCTAssertEqual(WebSocketClose.sendableCode(1007), .invalidFramePayloadData)
		XCTAssertEqual(WebSocketClose.sendableCode(1008), .policyViolation)
		XCTAssertEqual(WebSocketClose.sendableCode(1010), .mandatoryExtensionMissing)
		XCTAssertEqual(WebSocketClose.sendableCode(1011), .internalServerError)
	}

	// nil means "no specific code" → a normal goingAway (e.g. explicit close/unpair with no code).
	func testSendableCodeNilIsGoingAway() {
		XCTAssertEqual(WebSocketClose.sendableCode(nil), .goingAway)
	}

	// Reserved/local-only codes (1005/1006/1015), un-modeled application codes and anything unknown
	// must fall back to a safe, sendable code rather than producing an illegal on-the-wire value.
	func testSendableCodeFallsBackForUnsendableCodes() {
		XCTAssertEqual(WebSocketClose.sendableCode(1005), .internalServerError)
		XCTAssertEqual(WebSocketClose.sendableCode(1006), .internalServerError)
		XCTAssertEqual(WebSocketClose.sendableCode(1015), .internalServerError)
		XCTAssertEqual(WebSocketClose.sendableCode(4999), .internalServerError)
		XCTAssertEqual(WebSocketClose.sendableCode(0), .internalServerError)
		XCTAssertEqual(WebSocketClose.sendableCode(-1), .internalServerError)
	}

	func testBoundedReasonNilAndEmpty() {
		XCTAssertNil(WebSocketClose.boundedReasonData(nil))
		XCTAssertNil(WebSocketClose.boundedReasonData(""))
	}

	func testBoundedReasonShortReasonRoundTrips() {
		let reason = "inbound-frame-too-large"
		let data = WebSocketClose.boundedReasonData(reason)
		XCTAssertEqual(data, Data(reason.utf8))
		XCTAssertLessThanOrEqual(data?.count ?? 0, WebSocketClose.maxReasonBytes)
	}

	// A long multibyte reason is truncated to <= 123 UTF-8 bytes WITHOUT splitting a scalar, so the
	// result is always valid UTF-8 the OS will accept as a control-frame payload.
	func testBoundedReasonTruncatesMultibyteToValidUtf8() throws {
		let reason = String(repeating: "é", count: 200) // 400 UTF-8 bytes, é = 2 bytes each
		let data = WebSocketClose.boundedReasonData(reason)
		let bytes = try XCTUnwrap(data)
		XCTAssertLessThanOrEqual(bytes.count, WebSocketClose.maxReasonBytes)
		// 123 is odd; the last 2-byte scalar can't fit, so we stop at 122 bytes (61 × "é").
		XCTAssertEqual(bytes.count, 122)
		// Decodes back to valid UTF-8 (no split scalar).
		let decoded = String(data: bytes, encoding: .utf8)
		XCTAssertNotNil(decoded)
		XCTAssertEqual(decoded, String(repeating: "é", count: 61))
	}

	func testBoundedReasonCustomMaxBytes() {
		XCTAssertEqual(WebSocketClose.boundedReasonData("hello", maxBytes: 3), Data("hel".utf8))
		XCTAssertNil(WebSocketClose.boundedReasonData("hello", maxBytes: 0))
	}
}
