import Foundation
import MoshuMobileCore

/// Emits transport events back to the Capacitor plugin (which forwards them to JS as `frame` /
/// `connectionState` listener events).
protocol MobileTransportEngineDelegate: AnyObject {
	func transportDidReceiveFrame(connectionId: String, seq: Int, text: String)
	func transportDidChangeState(
		connectionId: String,
		state: String,
		code: Int?,
		reason: String?
	)
}

/// Orchestrates the entire authenticated mobile transport on the native side. It owns the device
/// identity (via `DeviceIdentityRepository` → Keychain), performs the pairing claim/poll over
/// URLSession, verifies the Agent Server's signed challenge, signs the device upgrade proof, and
/// runs the authenticated WSS connection with frame sequencing and limits.
///
/// Everything secret (private key, claim token, pairing code, signatures) stays here — the plugin
/// only ever hands JS opaque identifiers, fingerprints, and raw RPC text frames.
final class MobileTransportEngine: NSObject {
	weak var delegate: MobileTransportEngineDelegate?

	private let repository: DeviceIdentityRepository
	private let queue = DispatchQueue(label: "dev.moshu.mobile.transport")
	let urlSession: URLSession

	// In-flight pairing session (in memory only — never persisted until an approved, verified bind).
	private var pendingPairing: PendingPairing?

	// Active connection state.
	private var webSocketTask: URLSessionWebSocketTask?
	private var activeConnectionId: String?
	private let inboundSequencer = InboundFrameSequencer()
	private let outboundQueue = OutboundFrameQueue()

	init(service: String = "dev.moshu.mobile") {
		repository = DeviceIdentityRepository(store: KeychainSecretStore(service: service))
		let config = URLSessionConfiguration.ephemeral
		config.timeoutIntervalForRequest = 20
		config.waitsForConnectivity = false
		config.httpShouldSetCookies = false
		config.urlCache = nil
		// System (Microsoft-issued Dev Tunnel) TLS trust only — no custom relay-cert pinning. The real
		// server-identity guarantee is the app-layer Ed25519 challenge signature, verified below.
		urlSession = URLSession(configuration: config)
		super.init()
	}

	// MARK: Status

	func status() throws -> [String: Any] {
		guard let binding = try repository.loadBinding(), let deviceKey = try repository.loadDeviceKey()
		else {
			return ["state": "unpaired"]
		}
		return [
			"state": "paired",
			"binding": bindingPayload(binding, deviceKey: deviceKey),
		]
	}

	private func bindingPayload(_ binding: MobileBinding, deviceKey: Ed25519DeviceKey) -> [String: Any] {
		[
			"agentServerId": binding.agentServerId,
			"mobileClientId": binding.mobileClientId,
			"deviceKeyId": binding.deviceKeyId,
			"serverPublicKeyFingerprint": binding.serverPublicKeyFingerprint,
			"devicePublicKeyFingerprint": Fingerprint.of(deviceKey.spkiDER),
			"protocolVersion": binding.protocolVersion,
			"transportSecurity": binding.transportSecurity,
			"serverLabel": binding.serverLabel,
		]
	}

	// MARK: Pairing

	func beginPairing(qr: String, displayName: String) throws -> [String: Any] {
		if try repository.hasBinding() {
			throw MobileTransportError.alreadyPaired
		}
		let payload = try MobilePairingQr.parse(qr)
		// Fresh, ephemeral device key for this pairing attempt.
		let deviceKey = Ed25519DeviceKey()
		let deviceKeyId = "dk-" + Base64URL.encode(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))

		let claim = try postClaim(
			payload: payload,
			deviceKey: deviceKey,
			deviceKeyId: deviceKeyId,
			displayName: displayName
		)

		pendingPairing = PendingPairing(
			payload: payload,
			deviceKey: deviceKey,
			deviceKeyId: deviceKeyId,
			pairingId: claim.pairingId,
			claimToken: claim.claimToken,
			displayName: displayName
		)
		return [
			"pairingId": claim.pairingId,
			"deviceDisplayName": displayName,
			"serverPublicKeyFingerprint": payload.agentServerPublicKeyFingerprint,
		]
	}

	func pollPairing() throws -> [String: Any] {
		guard let pending = pendingPairing else {
			throw MobileTransportError.notPaired
		}
		let status = try postStatus(pending: pending)
		switch status {
		case .pending:
			return ["status": "pending_approval"]
		case .rejected:
			pendingPairing = nil
			return ["status": "rejected"]
		case .expired:
			pendingPairing = nil
			return ["status": "expired"]
		case let .approved(mobileClientId, agentServerId, agentServerPublicKey):
			// Pin check: the approved server key MUST match the key advertised in the scanned QR.
			guard agentServerPublicKey == pending.payload.agentServerPublicKey,
				agentServerId == pending.payload.agentServerId
			else {
				pendingPairing = nil
				return ["status": "fingerprint_mismatch"]
			}
			let binding = MobileBinding(
				agentServerId: agentServerId,
				mobileClientId: mobileClientId,
				deviceKeyId: pending.deviceKeyId,
				mobileURL: pending.payload.mobileUrl,
				serverPublicKeySPKIBase64URL: agentServerPublicKey,
				protocolVersion: pending.payload.protocolMaxVersion,
				transportSecurity: "relay-tls",
				serverLabel: pending.payload.serverLabel
			)
			try repository.saveBinding(binding, deviceKey: pending.deviceKey)
			pendingPairing = nil
			return [
				"status": "approved",
				"binding": bindingPayload(binding, deviceKey: pending.deviceKey),
			]
		}
	}

	func cancelPairing() {
		pendingPairing = nil
	}

	// MARK: Connect / send / close

	func connect() throws -> [String: Any] {
		guard let binding = try repository.loadBinding(), let deviceKey = try repository.loadDeviceKey()
		else {
			throw MobileTransportError.notPaired
		}
		let generation = try repository.nextGeneration()
		let instanceId = UUID().uuidString
		let input = MobileChallengeInput(
			mobileClientId: binding.mobileClientId,
			deviceKeyId: binding.deviceKeyId,
			instanceId: instanceId,
			generation: generation,
			protocolVersion: binding.protocolVersion
		)
		let challengeResponse = try postChallenge(binding: binding, input: input)
		let challenge = challengeResponse.challenge

		try ServerChallengeVerifier.verifyServerChallenge(
			input: input,
			challenge: challenge,
			serverSignatureBase64URL: challengeResponse.signature,
			binding: binding
		)
		let proof = try ServerChallengeVerifier.signAuthentication(
			input: input,
			challenge: challenge,
			deviceKey: deviceKey
		)

		let connectionId = UUID().uuidString
		try openWebSocket(
			binding: binding,
			input: input,
			challengeId: challenge.challengeId,
			signature: proof,
			connectionId: connectionId
		)

		return [
			"connectionId": connectionId,
			"localIdentity": [
				"role": "mobile-client",
				"peerId": binding.mobileClientId,
				"instanceId": instanceId,
				"generation": generation,
			],
			"serverIdentity": [
				"role": challenge.rpcIdentity.role,
				"peerId": challenge.rpcIdentity.peerId,
				"instanceId": challenge.rpcIdentity.instanceId,
				"generation": challenge.rpcIdentity.generation,
			],
			"negotiatedProtocolVersion": challenge.negotiatedProtocolVersion,
			"transportSecurity": challenge.transportSecurity,
		]
	}

	func send(connectionId: String, text: String) throws {
		guard connectionId == activeConnectionId, let task = webSocketTask else {
			throw MobileTransportError.notConnected
		}
		let size = try outboundQueue.reserve(text)
		task.send(.string(text)) { [weak self] error in
			self?.queue.async {
				self?.outboundQueue.release(size)
				if error != nil {
					self?.teardown(connectionId: connectionId, code: nil, reason: "send-failed")
				}
			}
		}
	}

	func close(connectionId: String, code: Int?, reason: String?) {
		teardown(connectionId: connectionId, code: code, reason: reason)
	}

	func unpair() throws {
		if let connectionId = activeConnectionId {
			teardown(connectionId: connectionId, code: nil, reason: "unpair")
		}
		pendingPairing = nil
		try repository.unpair()
	}

	// MARK: WebSocket

	private func openWebSocket(
		binding: MobileBinding,
		input: MobileChallengeInput,
		challengeId: String,
		signature: String,
		connectionId: String
	) throws {
		guard let wsURL = MobileEndpoints.webSocketURL(from: binding.mobileURL) else {
			throw MobileTransportError.urlInvalid
		}
		var request = URLRequest(url: wsURL)
		request.setValue(input.mobileClientId, forHTTPHeaderField: "x-moshu-mobile-client-id")
		request.setValue(input.deviceKeyId, forHTTPHeaderField: "x-moshu-device-key-id")
		request.setValue(input.instanceId, forHTTPHeaderField: "x-moshu-instance-id")
		request.setValue(String(input.generation), forHTTPHeaderField: "x-moshu-generation")
		request.setValue(String(input.protocolVersion), forHTTPHeaderField: "x-moshu-protocol-version")
		request.setValue(challengeId, forHTTPHeaderField: "x-moshu-challenge-id")
		request.setValue(signature, forHTTPHeaderField: "x-moshu-signature")

		// Supersede any prior connection: its frames become stale and are dropped.
		if let previous = activeConnectionId {
			teardown(connectionId: previous, code: nil, reason: "superseded")
		}
		let task = urlSession.webSocketTask(with: request)
		webSocketTask = task
		activeConnectionId = connectionId
		inboundSequencer.activate(connectionId: connectionId)
		task.resume()
		delegate?.transportDidChangeState(connectionId: connectionId, state: "open", code: nil, reason: nil)
		receiveNext(connectionId: connectionId)
	}

	private func receiveNext(connectionId: String) {
		guard let task = webSocketTask, connectionId == activeConnectionId else { return }
		task.receive { [weak self] result in
			self?.queue.async {
				guard let self, connectionId == self.activeConnectionId else { return }
				switch result {
				case let .success(message):
					switch message {
					case let .string(text):
						if let seq = self.inboundSequencer.nextSequence(for: connectionId) {
							self.delegate?.transportDidReceiveFrame(connectionId: connectionId, seq: seq, text: text)
						}
					case .data:
						// Binary frames are not part of the text-only RPC transport; drop them.
						break
					@unknown default:
						break
					}
					self.receiveNext(connectionId: connectionId)
				case .failure:
					self.teardown(connectionId: connectionId, code: nil, reason: "receive-failed")
				}
			}
		}
	}

	private func teardown(connectionId: String, code: Int?, reason: String?) {
		guard connectionId == activeConnectionId else { return }
		delegate?.transportDidChangeState(connectionId: connectionId, state: "closing", code: code, reason: reason)
		webSocketTask?.cancel(with: .goingAway, reason: reason?.data(using: .utf8))
		webSocketTask = nil
		activeConnectionId = nil
		inboundSequencer.deactivate(connectionId: connectionId)
		delegate?.transportDidChangeState(connectionId: connectionId, state: "closed", code: code, reason: reason)
	}

	// MARK: Serial execution helper

	/// Runs a throwing block on the transport's serial queue and returns its result synchronously.
	func run<T>(_ block: @escaping () throws -> T) throws -> T {
		var value: Result<T, Error>!
		queue.sync {
			value = Result { try block() }
		}
		return try value.get()
	}
}
