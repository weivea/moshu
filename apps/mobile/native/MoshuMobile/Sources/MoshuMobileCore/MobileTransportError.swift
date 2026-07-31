import Foundation

/// Error codes the native plugin rejects with. The string `rawValue`s are a hard contract with the
/// JS `fatalCodeMap` in `connection-controller.ts`: the five fatal codes map to un-retriable UI
/// states, while everything else is treated by JS as a transient network failure (offline/reconnect).
/// The plugin must NEVER surface a secret (code, claim token, key, signature) in an error.
public enum MobileTransportError: String, Error {
	// Fatal (mapped to a dedicated, un-retriable UI state by JS):
	case authRevoked = "AUTH_REVOKED"
	case protocolMismatch = "PROTOCOL_MISMATCH"
	case identityMismatch = "IDENTITY_MISMATCH"
	case urlInvalid = "URL_INVALID"
	case pairingRejected = "PAIRING_REJECTED"

	// Non-fatal / operational (JS treats these as transient unless otherwise handled):
	case notPaired = "NOT_PAIRED"
	case alreadyPaired = "ALREADY_PAIRED"
	case pairingExpired = "PAIRING_EXPIRED"
	case fingerprintMismatch = "FINGERPRINT_MISMATCH"
	case keychainFailure = "KEYCHAIN_FAILURE"
	case frameTooLarge = "FRAME_TOO_LARGE"
	case backpressure = "BACKPRESSURE"
	case notConnected = "NOT_CONNECTED"
	case network = "NETWORK"

	/// A safe, non-secret message for logs/telemetry. Deliberately generic.
	public var safeMessage: String {
		switch self {
		case .authRevoked: return "The device authorization was revoked."
		case .protocolMismatch: return "The Agent Server protocol version is not supported."
		case .identityMismatch: return "The Agent Server identity did not match the pinned key."
		case .urlInvalid: return "The pairing URL was invalid."
		case .pairingRejected: return "The pairing request was rejected."
		case .notPaired: return "This device is not paired."
		case .alreadyPaired: return "This device is already paired to a server."
		case .pairingExpired: return "The pairing request expired."
		case .fingerprintMismatch: return "The server fingerprint did not match the QR code."
		case .keychainFailure: return "A secure storage operation failed."
		case .frameTooLarge: return "A message exceeded the maximum frame size."
		case .backpressure: return "Too many messages are queued."
		case .notConnected: return "There is no active connection."
		case .network: return "A network error occurred."
		}
	}
}
