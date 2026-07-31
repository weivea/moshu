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
