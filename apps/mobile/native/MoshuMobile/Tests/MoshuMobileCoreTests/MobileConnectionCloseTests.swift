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
}
