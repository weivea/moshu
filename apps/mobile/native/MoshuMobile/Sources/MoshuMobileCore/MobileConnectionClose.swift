import Foundation

/// The stable, non-secret reason a connection closed, derived purely from the WebSocket close code
/// and/or the HTTP upgrade status — never from a localized error string. JS maps these tokens to
/// un-retriable fatal UI states (or a transient reconnect for `.transient`).
///
/// Source of truth (Layer 3 Mobile ingress):
///   - a live authenticated peer revoked by the Desktop is closed with WS code 1008
///     (`peer.close(1008, "Mobile device revoked.")`) → `.authRevoked`;
///   - a failed device authentication on the WSS upgrade returns HTTP 401/403 → `.authFailed`;
///   - a protocol-version mismatch on the upgrade returns HTTP 426 → `.protocolMismatch`;
///   - anything else (network drop, 1006, transient 429) is `.transient` and may be retried.
public enum MobileConnectionCloseReason: String, Equatable {
	case authRevoked = "AUTH_REVOKED"
	case authFailed = "AUTH_FAILED"
	case protocolMismatch = "PROTOCOL_MISMATCH"
	case transient = "TRANSIENT"

	/// Whether the reason is a permanent authorization/protocol failure the user cannot fix by
	/// waiting — the controller must stop reconnecting and clear business state.
	public var isFatal: Bool { self != .transient }
}

public enum MobileConnectionCloseClassifier {
	/// WebSocket close code the Layer 3 server uses when the Desktop revokes an active device.
	public static let revokedCloseCode = 1008

	/// Classifies a connection failure from the numeric signals only.
	/// - Parameters:
	///   - closeCode: the `URLSessionWebSocketTask.closeCode` raw value, if a close frame was seen.
	///   - httpStatus: the HTTP upgrade response status, if the upgrade itself failed (non-101).
	public static func classify(closeCode: Int?, httpStatus: Int?) -> MobileConnectionCloseReason {
		// A failed HTTP upgrade never reaches an open WebSocket, so its status is authoritative.
		if let httpStatus, httpStatus != 101 {
			if httpStatus == 401 || httpStatus == 403 {
				return .authFailed
			}
			if httpStatus == 426 {
				return .protocolMismatch
			}
		}
		if let closeCode, closeCode == revokedCloseCode {
			return .authRevoked
		}
		return .transient
	}
}

/// Turns the numeric close code the transport wants to send into a value the OS can actually put on
/// the wire, and bounds the close reason to the WebSocket control-frame budget.
///
/// The teardown path deliberately closes with a *specific* code so the peer learns why: an oversized
/// inbound frame closes with `messageTooBig` (1009) and a binary frame with `unsupportedData` (1003).
/// `URLSessionWebSocketTask.cancel(with:reason:)` only accepts the enumerated `CloseCode` cases;
/// blindly passing `.goingAway` for every teardown (as the first cut did) makes the peer always see
/// 1001 and lose that signal. Reserved/local-only codes (1005/1006/1015), application codes
/// (3000–4999) that the enum can't represent, and anything unknown fall back to a safe, sendable
/// code rather than crashing or sending an illegal value.
public enum WebSocketClose {
	/// RFC 6455 §5.5: a control frame payload is at most 125 bytes; 2 are the status code, leaving 123
	/// bytes for the UTF-8 reason.
	public static let maxReasonBytes = 123

	/// Maps a provided numeric close code to a `URLSessionWebSocketTask.CloseCode` that is legal to
	/// SEND. `nil` means "no specific code" and closes with a normal `goingAway`.
	public static func sendableCode(_ code: Int?) -> URLSessionWebSocketTask.CloseCode {
		guard let code else { return .goingAway }
		switch code {
		case 1000: return .normalClosure
		case 1001: return .goingAway
		case 1002: return .protocolError
		case 1003: return .unsupportedData
		case 1007: return .invalidFramePayloadData
		case 1008: return .policyViolation
		case 1009: return .messageTooBig
		case 1010: return .mandatoryExtensionMissing
		case 1011: return .internalServerError
		default:
			// Reserved/local-only (1004/1005/1006/1015), un-modeled application codes (3000–4999) or
			// anything out of range: never send an illegal code — fall back to a safe, sendable one.
			return .internalServerError
		}
	}

	/// Encodes the close reason as UTF-8, truncated to at most `maxBytes` bytes without splitting a
	/// multi-byte scalar. Returns nil for a nil/empty reason so `cancel(with:reason:)` omits it.
	public static func boundedReasonData(_ reason: String?, maxBytes: Int = maxReasonBytes) -> Data? {
		guard let reason, !reason.isEmpty, maxBytes > 0 else { return nil }
		if reason.utf8.count <= maxBytes {
			return Data(reason.utf8)
		}
		var truncated = ""
		var count = 0
		for character in reason {
			let width = String(character).utf8.count
			if count + width > maxBytes { break }
			truncated.append(character)
			count += width
		}
		return truncated.isEmpty ? nil : Data(truncated.utf8)
	}
}
