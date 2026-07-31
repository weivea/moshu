import Foundation
import MoshuMobileCore
#if canImport(UIKit)
import UIKit
#endif

/// The URLSession pre-auth calls to the Mobile ingress (`/mobile-pair/claim`, `/mobile-pair/status`,
/// `/mobile-auth/challenge`). All run synchronously on the engine's serial queue; the pairing code,
/// claim token, and signatures never leave native memory and are never logged.
extension MobileTransportEngine {
	private struct ClaimRequestBody: Encodable {
		let code: String
		let deviceKeyId: String
		let publicKey: String
		let displayName: String
		let model: String
		let platform: String
		let appVersion: String
	}

	private struct ClaimResponseBody: Decodable {
		let pairingId: String
		let claimToken: String
		let status: String
	}

	private struct StatusRequestBody: Encodable {
		let pairingId: String
		let claimToken: String
	}

	private struct StatusResponseBody: Decodable {
		let status: String
		let mobileClientId: String?
		let agentServerId: String?
		let agentServerPublicKey: String?
	}

	private struct ChallengeRequestBody: Encodable {
		let mobileClientId: String
		let deviceKeyId: String
		let instanceId: String
		let generation: Int
		let protocolVersion: Int
	}

	private struct SignatureEnvelope: Decodable {
		let signature: String
	}

	func postClaim(
		payload: MobilePairingQr,
		deviceKey: Ed25519DeviceKey,
		deviceKeyId: String,
		displayName: String
	) throws -> ClaimResult {
		guard let url = MobileEndpoints.httpURL(base: payload.mobileUrl, path: "/mobile-pair/claim") else {
			throw MobileTransportError.urlInvalid
		}
		let body = ClaimRequestBody(
			code: payload.code,
			deviceKeyId: deviceKeyId,
			publicKey: deviceKey.publicKeyBase64URL,
			displayName: displayName,
			model: Self.deviceModel,
			platform: "ios",
			appVersion: Self.appVersion
		)
		let data = try performPOST(url: url, body: body)
		let decoded = try JSONDecoder().decode(ClaimResponseBody.self, from: data)
		return ClaimResult(pairingId: decoded.pairingId, claimToken: decoded.claimToken)
	}

	func postStatus(pending: PendingPairing) throws -> PairingStatusResult {
		guard let url = MobileEndpoints.httpURL(base: pending.payload.mobileUrl, path: "/mobile-pair/status")
		else {
			throw MobileTransportError.urlInvalid
		}
		let data = try performPOST(
			url: url,
			body: StatusRequestBody(pairingId: pending.pairingId, claimToken: pending.claimToken)
		)
		let decoded = try JSONDecoder().decode(StatusResponseBody.self, from: data)
		switch decoded.status {
		case "approved":
			guard let mobileClientId = decoded.mobileClientId,
				let agentServerId = decoded.agentServerId,
				let agentServerPublicKey = decoded.agentServerPublicKey
			else {
				throw MobileTransportError.network
			}
			return .approved(
				mobileClientId: mobileClientId,
				agentServerId: agentServerId,
				agentServerPublicKey: agentServerPublicKey
			)
		case "rejected":
			return .rejected
		case "expired":
			return .expired
		default:
			return .pending
		}
	}

	func postChallenge(binding: MobileBinding, input: MobileChallengeInput) throws -> ChallengeResponse {
		guard let url = MobileEndpoints.httpURL(base: binding.mobileURL, path: "/mobile-auth/challenge")
		else {
			throw MobileTransportError.urlInvalid
		}
		let body = ChallengeRequestBody(
			mobileClientId: input.mobileClientId,
			deviceKeyId: input.deviceKeyId,
			instanceId: input.instanceId,
			generation: input.generation,
			protocolVersion: input.protocolVersion
		)
		let data = try performPOST(url: url, body: body)
		let challenge = try JSONDecoder().decode(MobileServerChallenge.self, from: data)
		let envelope = try JSONDecoder().decode(SignatureEnvelope.self, from: data)
		return ChallengeResponse(challenge: challenge, signature: envelope.signature)
	}

	// MARK: - HTTP

	private func performPOST<Body: Encodable>(url: URL, body: Body) throws -> Data {
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.httpBody = try JSONEncoder().encode(body)

		let semaphore = DispatchSemaphore(value: 0)
		var result: Result<Data, Error> = .failure(MobileTransportError.network)
		let task = urlSession.dataTask(with: request) { data, response, error in
			defer { semaphore.signal() }
			if error != nil {
				result = .failure(MobileTransportError.network)
				return
			}
			guard let http = response as? HTTPURLResponse else {
				result = .failure(MobileTransportError.network)
				return
			}
			if http.statusCode == 426 {
				result = .failure(MobileTransportError.protocolMismatch)
				return
			}
			if http.statusCode == 400 {
				result = .failure(MobileTransportError.pairingRejected)
				return
			}
			guard (200..<300).contains(http.statusCode), let data else {
				result = .failure(MobileTransportError.network)
				return
			}
			result = .success(data)
		}
		task.resume()
		_ = semaphore.wait(timeout: .now() + 25)
		return try result.get()
	}

	// MARK: - Device metadata

	static var deviceModel: String {
		#if canImport(UIKit)
		return UIDevice.current.model
		#else
		return "iPhone"
		#endif
	}

	static var appVersion: String {
		(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.1"
	}
}
