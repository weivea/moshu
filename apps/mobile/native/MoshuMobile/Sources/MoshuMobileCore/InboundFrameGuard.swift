import Foundation

/// The decision for a single inbound WebSocket frame, evaluated BEFORE the frame is bridged to JS.
public enum InboundFrameDecision: Equatable {
	/// A text frame within the byte budget — deliver it.
	case accept
	/// A text frame whose UTF-8 byte length exceeds `maxFrameBytes` — protocol-close, do not deliver.
	case rejectOversize(bytes: Int, max: Int)
	/// A binary frame — the Mobile transport is text-only (process-rpc JSON), so protocol-close it
	/// rather than silently consuming it.
	case rejectBinary
}

/// Guards the inbound (socket→JS) direction against oversized and binary frames. The limit is
/// enforced on the UTF-8 byte count (not the character count) so multibyte payloads can't slip past,
/// and it applies uniformly — including pre-handshake frames, since the native receive loop is the
/// same before and after the process-rpc hello.
public struct InboundFrameGuard {
	public let maxFrameBytes: Int

	public init(maxFrameBytes: Int) {
		self.maxFrameBytes = maxFrameBytes
	}

	/// Product-RPC default, matching `FrameLimits.productDefault` and the JS `ConnectionController`.
	public static let productDefault = InboundFrameGuard(maxFrameBytes: FrameLimits.productDefault.maxFrameBytes)

	public func evaluateText(_ text: String) -> InboundFrameDecision {
		let bytes = text.utf8.count
		if bytes > maxFrameBytes {
			return .rejectOversize(bytes: bytes, max: maxFrameBytes)
		}
		return .accept
	}

	public func evaluateBinary() -> InboundFrameDecision {
		.rejectBinary
	}
}
