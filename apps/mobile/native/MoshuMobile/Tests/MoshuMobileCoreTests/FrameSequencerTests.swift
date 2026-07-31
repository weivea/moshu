import XCTest

@testable import MoshuMobileCore

final class FrameSequencerTests: XCTestCase {
	func testInboundSequenceIsMonotonicPerActiveConnection() {
		let sequencer = InboundFrameSequencer()
		sequencer.activate(connectionId: "conn-1")
		XCTAssertEqual(sequencer.nextSequence(for: "conn-1"), 1)
		XCTAssertEqual(sequencer.nextSequence(for: "conn-1"), 2)
		XCTAssertEqual(sequencer.nextSequence(for: "conn-1"), 3)
	}

	func testStaleConnectionFramesAreDropped() {
		let sequencer = InboundFrameSequencer()
		sequencer.activate(connectionId: "conn-1")
		XCTAssertEqual(sequencer.nextSequence(for: "conn-1"), 1)

		// A new connection supersedes the old one; frames from conn-1 are now stale.
		sequencer.activate(connectionId: "conn-2")
		XCTAssertNil(sequencer.nextSequence(for: "conn-1"))
		XCTAssertEqual(sequencer.nextSequence(for: "conn-2"), 1)
	}

	func testDeactivateClearsActiveConnection() {
		let sequencer = InboundFrameSequencer()
		sequencer.activate(connectionId: "conn-1")
		sequencer.deactivate(connectionId: "conn-1")
		XCTAssertNil(sequencer.activeConnectionId)
		XCTAssertNil(sequencer.nextSequence(for: "conn-1"))
	}

	func testOutboundReservesAndReleasesBytes() throws {
		let queue = OutboundFrameQueue(limits: FrameLimits(maxFrameBytes: 100, maxQueuedBytes: 100))
		let size = try queue.reserve("hello")
		XCTAssertEqual(size, 5)
		XCTAssertEqual(queue.queuedBytes, 5)
		queue.release(size)
		XCTAssertEqual(queue.queuedBytes, 0)
	}

	func testOutboundRejectsFrameTooLarge() {
		let queue = OutboundFrameQueue(limits: FrameLimits(maxFrameBytes: 4, maxQueuedBytes: 100))
		XCTAssertThrowsError(try queue.reserve("hello")) { error in
			XCTAssertEqual(error as? MobileTransportError, .frameTooLarge)
		}
		XCTAssertEqual(queue.queuedBytes, 0)
	}

	func testOutboundAppliesBackpressure() throws {
		let queue = OutboundFrameQueue(limits: FrameLimits(maxFrameBytes: 100, maxQueuedBytes: 8))
		try queue.reserve("12345")
		XCTAssertThrowsError(try queue.reserve("6789")) { error in
			XCTAssertEqual(error as? MobileTransportError, .backpressure)
		}
		// The rejected frame did not consume budget.
		XCTAssertEqual(queue.queuedBytes, 5)
	}

	func testTransportRejectsBinary() {
		XCTAssertTrue(OutboundFrameQueue().rejectsBinary())
	}
}
