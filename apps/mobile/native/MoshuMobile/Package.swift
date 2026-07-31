// swift-tools-version: 5.9
import PackageDescription

// Pure-Swift core of the Moshu Mobile native transport. It has NO Capacitor dependency so it can be
// exercised with `swift test` on a Mac. The Capacitor `CAPPlugin` wrapper (MoshuMobileTransport)
// lives in the iOS app target and imports this library; keeping the security-critical logic here
// makes it unit-testable in isolation (Keychain, canonical payloads, Ed25519, framing, binding).
let package = Package(
	name: "MoshuMobile",
	platforms: [
		.iOS(.v15),
		.macOS(.v12),
	],
	products: [
		.library(name: "MoshuMobileCore", targets: ["MoshuMobileCore"]),
	],
	targets: [
		.target(
			name: "MoshuMobileCore",
			path: "Sources/MoshuMobileCore"
		),
		.testTarget(
			name: "MoshuMobileCoreTests",
			dependencies: ["MoshuMobileCore"],
			path: "Tests/MoshuMobileCoreTests",
			resources: [.copy("Fixtures")]
		),
	]
)
