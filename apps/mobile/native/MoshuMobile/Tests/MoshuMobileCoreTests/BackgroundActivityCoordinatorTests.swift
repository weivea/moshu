import XCTest

@testable import MoshuMobileCore

/// A scriptable fake background-task host that records begin/end and lets the test drive expiration.
private final class FakeBackgroundTaskHost: BackgroundTaskHost {
	private(set) var beginCount = 0
	private(set) var endedIds: [Int] = []
	private var nextId = 1
	private var expirationHandler: (() -> Void)?

	func beginTask(expirationHandler: @escaping () -> Void) -> Int {
		beginCount += 1
		self.expirationHandler = expirationHandler
		let id = nextId
		nextId += 1
		return id
	}

	func endTask(_ id: Int) {
		endedIds.append(id)
	}

	/// Simulates the OS calling the most recently registered expiration handler.
	func fireExpiration() {
		expirationHandler?()
	}
}

final class BackgroundActivityCoordinatorTests: XCTestCase {
	func testBeginIsIdempotentAndStartsExactlyOneTask() {
		let host = FakeBackgroundTaskHost()
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: {})

		coordinator.begin()
		coordinator.begin()
		coordinator.begin()

		XCTAssertEqual(host.beginCount, 1, "A second begin() must not start another task")
		XCTAssertTrue(coordinator.isActive)
	}

	func testEndIsIdempotentAndReleasesTheTask() {
		let host = FakeBackgroundTaskHost()
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: {})

		coordinator.begin()
		coordinator.end()
		coordinator.end()

		XCTAssertEqual(host.endedIds.count, 1, "end() must release the task exactly once")
		XCTAssertFalse(coordinator.isActive)
	}

	func testExpirationRunsCleanupExactlyOnceAndEndsTheTask() {
		let host = FakeBackgroundTaskHost()
		var expireCount = 0
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: { expireCount += 1 })

		coordinator.begin()
		host.fireExpiration()

		XCTAssertEqual(expireCount, 1, "onExpire must run exactly once")
		XCTAssertEqual(host.endedIds.count, 1, "expiration must guarantee the task is ended")
		XCTAssertFalse(coordinator.isActive)

		// A late end() after expiration must not double-end.
		coordinator.end()
		XCTAssertEqual(host.endedIds.count, 1)
	}

	func testBeginAfterExpirationStartsAFreshTask() {
		let host = FakeBackgroundTaskHost()
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: {})

		coordinator.begin()
		host.fireExpiration()
		coordinator.begin()

		XCTAssertEqual(host.beginCount, 2, "A new foreground→background cycle may begin a new task")
		XCTAssertTrue(coordinator.isActive)
	}
}

final class NotificationContentBuilderTests: XCTestCase {
	func testStableIdIsDeterministicPositiveAnd31Bit() {
		XCTAssertEqual(
			NotificationContentBuilder.stableId(forSeq: 42),
			NotificationContentBuilder.stableId(forSeq: 42)
		)
		for seq in [0, 1, 7, 2_147_483_647, 5_000_000_000] {
			let id = NotificationContentBuilder.stableId(forSeq: seq)
			XCTAssertGreaterThan(id, 0)
			XCTAssertLessThanOrEqual(id, NotificationContentBuilder.maxNotificationId)
		}
	}

	func testBuildSelectsGenericKeysByKind() {
		let content = NotificationContentBuilder.build(
			MobileAttentionDescriptor(kind: .approvalRequired, seq: 3, approvalId: "appr-1")
		)
		XCTAssertEqual(content.titleKey, "attention.approvalRequired.title")
		XCTAssertEqual(content.bodyKey, "attention.approvalRequired.body")
		XCTAssertEqual(content.id, 3)
	}

	func testBuildCarriesOnlyOpaqueRouteIdsAndNoBusinessContent() {
		let content = NotificationContentBuilder.build(
			MobileAttentionDescriptor(
				kind: .runFailed,
				seq: 9,
				sessionId: "sess-1",
				runId: "run-1"
			)
		)
		XCTAssertEqual(content.routeUserInfo, ["sessionId": "sess-1", "runId": "run-1"])
		// The localization keys are static and never contain business content.
		XCTAssertFalse(content.titleKey.contains(" "))
		XCTAssertFalse(content.bodyKey.contains(" "))
	}

	func testEveryKindHasDistinctGenericKeys() {
		var seen = Set<String>()
		for kind in MobileAttentionKind.allCases {
			let keys = NotificationContentBuilder.localizationKeys(for: kind)
			XCTAssertTrue(seen.insert(keys.title).inserted, "duplicate title key for \(kind)")
		}
	}
}
