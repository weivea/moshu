import XCTest

@testable import MoshuMobileCore

/// A scriptable fake background-task host that records begin/end and lets the test drive expiration.
/// It retains EACH task's expiration handler keyed by the id it returned, so a test can fire a stale
/// task's expiration after a newer task has begun (proving generation isolation).
private final class FakeBackgroundTaskHost: BackgroundTaskHost {
	private(set) var beginCount = 0
	private(set) var endedIds: [Int] = []
	private var nextId = 1
	private var handlers: [Int: () -> Void] = [:]
	private var lastId: Int?

	func beginTask(expirationHandler: @escaping () -> Void) -> Int {
		beginCount += 1
		let id = nextId
		nextId += 1
		handlers[id] = expirationHandler
		lastId = id
		return id
	}

	func endTask(_ id: Int) {
		endedIds.append(id)
	}

	/// Simulates the OS calling the most recently registered expiration handler.
	func fireExpiration() {
		if let id = lastId {
			handlers[id]?()
		}
	}

	/// Simulates the OS firing the expiration handler for a SPECIFIC (possibly stale) task id.
	func fireExpiration(forId id: Int) {
		handlers[id]?()
	}
}

/// A host that fires the expiration handler SYNCHRONOUSLY inside `beginTask`, before it returns the
/// id — reproducing the OS handing back an already-expired background task. Used to prove the
/// coordinator still runs cleanup exactly once even though the id is not yet recorded.
private final class SynchronousExpirationHost: BackgroundTaskHost {
	private(set) var beginCount = 0
	private(set) var endedIds: [Int] = []
	private var nextId = 1

	func beginTask(expirationHandler: @escaping () -> Void) -> Int {
		beginCount += 1
		let id = nextId
		nextId += 1
		// Fire before returning: the coordinator has not recorded this id yet.
		expirationHandler()
		return id
	}

	func endTask(_ id: Int) {
		endedIds.append(id)
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

	func testStaleExpirationAfterEndIsANoOpAndCannotCloseANewerConnection() {
		let host = FakeBackgroundTaskHost()
		var expireCount = 0
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: { expireCount += 1 })

		// Foreground returned and ended the task BEFORE the OS fired the (now stale) expiration handler.
		coordinator.begin()
		coordinator.end()
		host.fireExpiration()

		// The stale expiration must not run cleanup: otherwise it would tear down whatever socket the
		// next foreground session opens.
		XCTAssertEqual(expireCount, 0, "A stale expiration after end() must not run onExpire")
		XCTAssertEqual(host.endedIds.count, 1, "end() already released the task; no double-end")
		XCTAssertFalse(coordinator.isActive)
	}

	func testLateExpirationOfTaskACannotCloseTaskB() {
		let host = FakeBackgroundTaskHost()
		var expireCount = 0
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: { expireCount += 1 })

		// Window A begins and is ended by a foreground return; then a NEW background window B begins.
		coordinator.begin() // task id 1 (A)
		coordinator.end()
		coordinator.begin() // task id 2 (B)
		XCTAssertTrue(coordinator.isActive)

		// The OS now fires task A's (stale) expiration handler LATE, after B is live.
		host.fireExpiration(forId: 1)

		// A's late callback must be a strict no-op: it must not run onExpire and must not end B's task,
		// so B's socket stays alive until B legitimately expires or the app ends it.
		XCTAssertEqual(expireCount, 0, "A stale task-A expiration must never run onExpire for task B")
		XCTAssertEqual(host.endedIds, [1], "Only A was ended (by end()); B must remain active")
		XCTAssertTrue(coordinator.isActive, "Task B must still be active after A's stale expiration")

		// B still expires correctly on its own handler.
		host.fireExpiration(forId: 2)
		XCTAssertEqual(expireCount, 1, "Task B's own expiration runs cleanup exactly once")
		XCTAssertEqual(host.endedIds, [1, 2])
		XCTAssertFalse(coordinator.isActive)
	}

	func testSynchronousExpirationDuringBeginStillRunsCleanupExactlyOnce() {
		let host = SynchronousExpirationHost()
		var expireCount = 0
		let coordinator = BackgroundActivityCoordinator(host: host, onExpire: { expireCount += 1 })

		// The host fires expiration synchronously inside beginTask, before the coordinator records the
		// id. The coordinator must still run onExpire once and end exactly that task — never leaving a
		// zombie window that is recorded as active but already expired.
		coordinator.begin()

		XCTAssertEqual(host.beginCount, 1)
		XCTAssertEqual(expireCount, 1, "A synchronous expiration must still run onExpire exactly once")
		XCTAssertEqual(host.endedIds, [1], "The synchronously-expired task must be ended exactly once")
		XCTAssertFalse(coordinator.isActive, "No zombie active window may remain after sync expiration")

		// A subsequent begin() opens a genuinely fresh task.
		coordinator.begin()
		XCTAssertEqual(host.beginCount, 2)
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
