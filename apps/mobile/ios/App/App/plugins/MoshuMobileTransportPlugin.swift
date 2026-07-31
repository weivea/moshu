import AVFoundation
import Capacitor
import Foundation
import MoshuMobileCore
import UIKit

/// Bridges `UIApplication`'s background-task API to the pure-logic ``BackgroundActivityCoordinator``.
/// This is a plain, finite background task — NOT a declared `UIBackgroundMode`, remote/silent push,
/// or VoIP keep-alive. It only extends the App's runtime briefly after backgrounding so an already
/// open socket can still receive a live attention event; when it ends (or the OS expires it) the
/// engine closes the socket and the web layer goes offline.
final class UIApplicationBackgroundTaskHost: BackgroundTaskHost {
	func beginTask(expirationHandler: @escaping () -> Void) -> Int {
		let identifier = UIApplication.shared.beginBackgroundTask(
			withName: "dev.moshu.mobile.attention-window",
			expirationHandler: expirationHandler
		)
		return Int(identifier.rawValue)
	}

	func endTask(_ id: Int) {
		UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
	}
}

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

	/// Owns the single bounded background task. Its expiration handler closes the *exact* active socket
	/// via the engine so the OS reclaiming the short background window reliably tears the connection
	/// down (the web layer then observes the emitted `closed` state and goes offline). This co-owns the
	/// task with the engine so there is no cross-object wiring between the AppDelegate and the plugin.
	private lazy var backgroundActivity = BackgroundActivityCoordinator(
		host: UIApplicationBackgroundTaskHost(),
		onExpire: { [weak self] in
			self?.engine.closeActiveConnection(reason: "background-expired")
		}
	)

	/// Registers lifecycle observers so the bounded background task begins when the App backgrounds and
	/// ends when it returns to the foreground (or terminates). Idempotent via the coordinator.
	override public func load() {
		let center = NotificationCenter.default
		center.addObserver(
			self,
			selector: #selector(handleDidEnterBackground),
			name: UIApplication.didEnterBackgroundNotification,
			object: nil
		)
		center.addObserver(
			self,
			selector: #selector(handleDidBecomeActive),
			name: UIApplication.didBecomeActiveNotification,
			object: nil
		)
		center.addObserver(
			self,
			selector: #selector(handleWillTerminate),
			name: UIApplication.willTerminateNotification,
			object: nil
		)
	}

	deinit {
		NotificationCenter.default.removeObserver(self)
	}

	@objc private func handleDidEnterBackground() {
		// Begin the single, bounded background task so an already-open socket can survive the OS's short
		// background window and still receive a live attention event. Idempotent.
		backgroundActivity.begin()
	}

	@objc private func handleDidBecomeActive() {
		// Back in the foreground: end the task promptly (idempotent). The web layer reconnects and
		// re-snapshots the durable attention feed.
		backgroundActivity.end()
	}

	@objc private func handleWillTerminate() {
		backgroundActivity.end()
	}

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

	func transportDidChangeState(connectionId: String, state: String, code: Int?, reason: String?, fatalReason: String?) {
		var data: [String: Any] = ["connectionId": connectionId, "state": state]
		if let code = code { data["code"] = code }
		if let reason = reason { data["reason"] = reason }
		if let fatalReason = fatalReason { data["fatalReason"] = fatalReason }
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
