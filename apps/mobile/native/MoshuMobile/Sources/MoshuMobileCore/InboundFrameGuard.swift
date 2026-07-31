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

	/// The WebSocket close code the transport sends when this decision requires a protocol close, or
	/// nil for `.accept`. Kept in sync with `InboundFrameCloseCode` so the engine and tests agree.
	public var closeCode: Int? {
		switch self {
		case .accept: return nil
		case .rejectOversize: return InboundFrameCloseCode.oversize
		case .rejectBinary: return InboundFrameCloseCode.binary
		}
	}
}

/// The stable WebSocket close codes the inbound guard uses for a protocol close. Named so the engine
/// and its tests reference the same values instead of scattering magic numbers.
public enum InboundFrameCloseCode {
	/// WS 1009 messageTooBig — an inbound text frame exceeded the per-frame byte budget.
	public static let oversize = 1009
	/// WS 1003 unsupportedData — the peer sent a binary frame on this text-only transport.
	public static let binary = 1003
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
