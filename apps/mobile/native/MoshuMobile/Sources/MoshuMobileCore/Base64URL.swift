import Foundation

/// URL-safe base64 (RFC 4648 §5) with padding stripped — the encoding the Mobile contracts use for
/// public keys, signatures, and nonces. `+`→`-`, `/`→`_`, trailing `=` removed.
public enum Base64URL {
	public static func encode(_ data: Data) -> String {
		var text = data.base64EncodedString()
		text = text.replacingOccurrences(of: "+", with: "-")
		text = text.replacingOccurrences(of: "/", with: "_")
		while text.hasSuffix("=") {
			text.removeLast()
		}
		return text
	}

	public static func decode(_ text: String) -> Data? {
		var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
		let remainder = base64.count % 4
		if remainder > 0 {
			base64 += String(repeating: "=", count: 4 - remainder)
		}
		return Data(base64Encoded: base64)
	}
}
