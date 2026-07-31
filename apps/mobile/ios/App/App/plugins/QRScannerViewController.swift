import AVFoundation
import UIKit

/// A minimal AVFoundation QR scanner presented modally for pairing. The scanned payload is delivered
/// via `completion` and held only in memory by the caller — it is never logged or persisted. Returns
/// `nil` when the user cancels; the caller distinguishes "unavailable" via `isCameraAvailable`.
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
	/// Called exactly once with the scanned string, or nil if the user cancelled.
	var completion: ((String?) -> Void)?

	private let captureSession = AVCaptureSession()
	private var previewLayer: AVCaptureVideoPreviewLayer?
	private var didFinish = false

	static var isCameraAvailable: Bool {
		AVCaptureDevice.default(for: .video) != nil
	}

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .black
		configureSession()
		addCancelButton()
	}

	override func viewWillAppear(_ animated: Bool) {
		super.viewWillAppear(animated)
		if !captureSession.isRunning {
			DispatchQueue.global(qos: .userInitiated).async { [weak self] in
				self?.captureSession.startRunning()
			}
		}
	}

	override func viewWillDisappear(_ animated: Bool) {
		super.viewWillDisappear(animated)
		if captureSession.isRunning {
			captureSession.stopRunning()
		}
	}

	private func configureSession() {
		guard let device = AVCaptureDevice.default(for: .video),
			let input = try? AVCaptureDeviceInput(device: device),
			captureSession.canAddInput(input)
		else {
			return
		}
		captureSession.addInput(input)

		let output = AVCaptureMetadataOutput()
		guard captureSession.canAddOutput(output) else { return }
		captureSession.addOutput(output)
		output.setMetadataObjectsDelegate(self, queue: .main)
		output.metadataObjectTypes = [.qr]

		let preview = AVCaptureVideoPreviewLayer(session: captureSession)
		preview.videoGravity = .resizeAspectFill
		preview.frame = view.layer.bounds
		view.layer.addSublayer(preview)
		previewLayer = preview
	}

	private func addCancelButton() {
		let button = UIButton(type: .system)
		button.setTitle(NSLocalizedString("Cancel", comment: "Cancel QR scan"), for: .normal)
		button.setTitleColor(.white, for: .normal)
		button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
		button.translatesAutoresizingMaskIntoConstraints = false
		button.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
		view.addSubview(button)
		NSLayoutConstraint.activate([
			button.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
			button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
		])
	}

	override func viewDidLayoutSubviews() {
		super.viewDidLayoutSubviews()
		previewLayer?.frame = view.layer.bounds
	}

	@objc private func cancelTapped() {
		finish(with: nil)
	}

	func metadataOutput(
		_ output: AVCaptureMetadataOutput,
		didOutput metadataObjects: [AVMetadataObject],
		from connection: AVCaptureConnection
	) {
		guard
			let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
			object.type == .qr,
			let value = object.stringValue
		else {
			return
		}
		finish(with: value)
	}

	private func finish(with value: String?) {
		guard !didFinish else { return }
		didFinish = true
		if captureSession.isRunning {
			captureSession.stopRunning()
		}
		let callback = completion
		completion = nil
		dismiss(animated: true) {
			callback?(value)
		}
	}
}
