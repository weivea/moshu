import AVFoundation
import Capacitor
import Foundation
import MoshuMobileCore

/// The `MoshuMobileTransport` Capacitor plugin — the sole bridge between the Web layer and the
/// device's secret material. It is a thin dispatcher: every method forwards to `MobileTransportEngine`
/// on a background queue and resolves/rejects the Capacitor call with the engine's opaque result, and
/// it forwards the engine's frame/state events to JS as listener events.
///
/// Rejections carry the `MobileTransportError` raw code (e.g. `AUTH_REVOKED`, `PROTOCOL_MISMATCH`) so
/// the JS `ConnectionController.fatalCodeMap` can route to the correct un-retriable UI state. No
/// secret (private key, claim token, pairing code, signature) is ever passed to JS or logged.
@objc(MoshuMobileTransportPlugin)
public class MoshuMobileTransportPlugin: CAPPlugin, CAPBridgedPlugin, MobileTransportEngineDelegate {
	public let identifier = "MoshuMobileTransportPlugin"
	public let jsName = "MoshuMobileTransport"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "scanPairingQr", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "beginPairing", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "pollPairing", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "cancelPairing", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "unpair", returnType: CAPPluginReturnPromise),
	]

	private let workQueue = DispatchQueue(label: "dev.moshu.mobile.plugin", qos: .userInitiated)
	private lazy var engine: MobileTransportEngine = {
		let engine = MobileTransportEngine()
		engine.delegate = self
		return engine
	}()

	// MARK: Status / lifecycle

	@objc func getStatus(_ call: CAPPluginCall) {
		dispatch(call) { try self.engine.status() }
	}

	@objc func connect(_ call: CAPPluginCall) {
		dispatch(call) { try self.engine.connect() }
	}

	@objc func pollPairing(_ call: CAPPluginCall) {
		dispatch(call) { try self.engine.pollPairing() }
	}

	@objc func cancelPairing(_ call: CAPPluginCall) {
		dispatch(call) {
			self.engine.cancelPairing()
			return [:]
		}
	}

	@objc func unpair(_ call: CAPPluginCall) {
		dispatch(call) {
			try self.engine.unpair()
			return [:]
		}
	}

	@objc func beginPairing(_ call: CAPPluginCall) {
		guard let qr = call.getString("qr"), let displayName = call.getString("displayName") else {
			call.reject("Missing pairing arguments", MobileTransportError.network.rawValue)
			return
		}
		dispatch(call) { try self.engine.beginPairing(qr: qr, displayName: displayName) }
	}

	@objc func send(_ call: CAPPluginCall) {
		guard let connectionId = call.getString("connectionId"), let text = call.getString("text") else {
			call.reject("Missing send arguments", MobileTransportError.network.rawValue)
			return
		}
		dispatch(call) {
			try self.engine.send(connectionId: connectionId, text: text)
			return [:]
		}
	}

	@objc func close(_ call: CAPPluginCall) {
		guard let connectionId = call.getString("connectionId") else {
			call.reject("Missing connectionId", MobileTransportError.network.rawValue)
			return
		}
		let code = call.getInt("code")
		let reason = call.getString("reason")
		dispatch(call) {
			self.engine.close(connectionId: connectionId, code: code, reason: reason)
			return [:]
		}
	}

	// MARK: QR scanning (main-thread UI + camera permission)

	@objc func scanPairingQr(_ call: CAPPluginCall) {
		DispatchQueue.main.async {
			guard QRScannerViewController.isCameraAvailable else {
				call.resolve(["status": "unavailable"])
				return
			}
			AVCaptureDevice.requestAccess(for: .video) { granted in
				DispatchQueue.main.async {
					guard granted, let presenter = self.bridge?.viewController else {
						call.resolve(["status": granted ? "unavailable" : "unavailable"])
						return
					}
					let scanner = QRScannerViewController()
					scanner.modalPresentationStyle = .fullScreen
					scanner.completion = { value in
						if let value = value {
							// The scanned payload stays in memory and is passed straight to beginPairing.
							call.resolve(["status": "scanned", "qr": value])
						} else {
							call.resolve(["status": "cancelled"])
						}
					}
					presenter.present(scanner, animated: true)
				}
			}
		}
	}

	// MARK: Engine event forwarding

	func transportDidReceiveFrame(connectionId: String, seq: Int, text: String) {
		notifyListeners("frame", data: ["connectionId": connectionId, "seq": seq, "text": text])
	}

	func transportDidChangeState(connectionId: String, state: String, code: Int?, reason: String?) {
		var data: [String: Any] = ["connectionId": connectionId, "state": state]
		if let code = code { data["code"] = code }
		if let reason = reason { data["reason"] = reason }
		notifyListeners("connectionState", data: data)
	}

	// MARK: Dispatch helper

	/// Runs an engine operation off the main thread, serialized on the engine queue, and resolves or
	/// rejects the Capacitor call. `MobileTransportError` is surfaced with its stable raw code.
	private func dispatch(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]) {
		workQueue.async {
			do {
				let result = try self.engine.run(work)
				call.resolve(result)
			} catch let error as MobileTransportError {
				call.reject(error.safeMessage, error.rawValue)
			} catch {
				call.reject(MobileTransportError.network.safeMessage, MobileTransportError.network.rawValue)
			}
		}
	}
}
