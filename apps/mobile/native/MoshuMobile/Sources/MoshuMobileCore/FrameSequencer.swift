import Foundation

/// Transport frame limits. These bound a single frame and the total bytes queued for send so a
/// runaway producer can't exhaust memory; they mirror the RPC limits negotiated on the JS side.
public struct FrameLimits {
	public let maxFrameBytes: Int
	public let maxQueuedBytes: Int

	public init(maxFrameBytes: Int, maxQueuedBytes: Int) {
		self.maxFrameBytes = maxFrameBytes
		self.maxQueuedBytes = maxQueuedBytes
	}

	/// Matches the Product RPC defaults used by the JS `ConnectionController`.
	public static let productDefault = FrameLimits(maxFrameBytes: 1_048_576, maxQueuedBytes: 8_388_608)
}

/// Assigns the monotonic per-connection sequence numbers that accompany each frame delivered to JS,
/// and drops frames that belong to a superseded connection. JS applies the same discipline
/// (`NativeRpcConnection`): frames whose `connectionId` is not the active one, or whose sequence is
/// not strictly increasing, are discarded.
public final class InboundFrameSequencer {
	public private(set) var activeConnectionId: String?
	private var lastSequence = 0

	public init() {}

	/// Marks a connection as the active one and resets the sequence. Any later frames from a prior
	/// connectionId are considered stale.
	public func activate(connectionId: String) {
		activeConnectionId = connectionId
		lastSequence = 0
	}

	/// Returns the next sequence number for a frame on `connectionId`, or nil if the frame is stale
	/// (belongs to a superseded connection) and must be dropped.
	public func nextSequence(for connectionId: String) -> Int? {
		guard connectionId == activeConnectionId else {
			return nil
		}
		lastSequence += 1
		return lastSequence
	}

	public func deactivate(connectionId: String) {
		if connectionId == activeConnectionId {
			activeConnectionId = nil
		}
	}
}

/// Tracks outbound (JS→socket) frames against the limits and applies backpressure. Binary frames are
/// rejected outright: the Mobile transport is text-only (process-rpc JSON frames).
public final class OutboundFrameQueue {
	private let limits: FrameLimits
	public private(set) var queuedBytes = 0

	public init(limits: FrameLimits = .productDefault) {
		self.limits = limits
	}

	/// Validates a text frame and reserves its bytes. Throws `.frameTooLarge` if the frame exceeds
	/// the per-frame cap or `.backpressure` if enqueuing it would exceed the queued-bytes cap.
	@discardableResult
	public func reserve(_ text: String) throws -> Int {
		let size = text.utf8.count
		if size > limits.maxFrameBytes {
			throw MobileTransportError.frameTooLarge
		}
		if queuedBytes + size > limits.maxQueuedBytes {
			throw MobileTransportError.backpressure
		}
		queuedBytes += size
		return size
	}

	/// Releases the bytes reserved for a frame once the socket reports it was sent.
	public func release(_ size: Int) {
		queuedBytes = max(0, queuedBytes - size)
	}

	/// The transport never accepts binary frames; callers must drop them.
	public func rejectsBinary() -> Bool { true }
}
