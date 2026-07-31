import Foundation
import MoshuMobileCore

/// The versioned pairing QR payload (`mobilePairingQrPayloadSchema` in the contracts). Only ephemeral
/// single-use material plus the pinned Agent Server identity. Never logged or persisted.
struct MobilePairingQr: Decodable {
	let v: Int
	let kind: String
	let mobileUrl: String
	let pairingId: String
	let code: String
	let agentServerId: String
	let agentServerPublicKey: String
	let agentServerPublicKeyFingerprint: String
	let expiresAt: String
	let protocolMinVersion: Int
	let protocolMaxVersion: Int

	/// A human-readable label derived from the tunnel host (safe to display; not a secret).
	var serverLabel: String {
		URL(string: mobileUrl)?.host ?? "Agent Server"
	}

	static func parse(_ qr: String) throws -> MobilePairingQr {
		guard let data = qr.data(using: .utf8) else {
			throw MobileTransportError.urlInvalid
		}
		let payload: MobilePairingQr
		do {
			payload = try JSONDecoder().decode(MobilePairingQr.self, from: data)
		} catch {
			throw MobileTransportError.urlInvalid
		}
		guard payload.v == 1, payload.kind == "moshu-mobile-pairing" else {
			throw MobileTransportError.urlInvalid
		}
		guard let url = URL(string: payload.mobileUrl),
			let scheme = url.scheme?.lowercased(),
			scheme == "https" || scheme == "wss"
		else {
			throw MobileTransportError.urlInvalid
		}
		// The one supported protocol version must fall within the QR's advertised range.
		guard payload.protocolMinVersion <= 1, payload.protocolMaxVersion >= 1 else {
			throw MobileTransportError.protocolMismatch
		}
		if let expiry = ISO8601DateFormatter.moshu.date(from: payload.expiresAt), expiry <= Date() {
			throw MobileTransportError.pairingExpired
		}
		return payload
	}
}

/// The in-memory state of a pairing attempt between `beginPairing` and an approved/rejected poll.
/// Holds the ephemeral device key, the claim token, and the pinned QR payload. Discarded on success,
/// rejection, expiry, or cancel; never written to disk.
struct PendingPairing {
	let payload: MobilePairingQr
	let deviceKey: Ed25519DeviceKey
	let deviceKeyId: String
	let pairingId: String
	let claimToken: String
	let displayName: String
}

struct ClaimResult {
	let pairingId: String
	let claimToken: String
}

enum PairingStatusResult {
	case pending
	case rejected
	case expired
	case approved(mobileClientId: String, agentServerId: String, agentServerPublicKey: String)
}

/// The `/mobile-auth/challenge` response: the full challenge plus the server's Ed25519 signature over
/// the canonical server-challenge payload.
struct ChallengeResponse {
	let challenge: MobileServerChallenge
	let signature: String
}

/// Derives the concrete Mobile ingress endpoints from the pinned base URL. HTTP pre-auth endpoints use
/// https; the authenticated socket uses wss at `/mobile` (the dedicated Mobile ingress path).
enum MobileEndpoints {
	static func httpURL(base: String, path: String) -> URL? {
		guard var components = URLComponents(string: base) else { return nil }
		components.scheme = "https"
		components.path = path
		components.query = nil
		components.fragment = nil
		return components.url
	}

	static func webSocketURL(from base: String) -> URL? {
		guard var components = URLComponents(string: base) else { return nil }
		components.scheme = "wss"
		if components.path.isEmpty || components.path == "/" {
			components.path = "/mobile"
		}
		components.query = nil
		components.fragment = nil
		return components.url
	}
}

extension ISO8601DateFormatter {
	static let moshu: ISO8601DateFormatter = {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter
	}()
}
