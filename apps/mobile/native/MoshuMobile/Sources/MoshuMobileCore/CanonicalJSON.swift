import Foundation

/// A JSON value restricted to exactly the shapes the Mobile canonical payloads use: strings,
/// non-negative integers, and flat string arrays. It serializes byte-for-byte identically to
/// JavaScript's `JSON.stringify` for these shapes (compact, no spaces, forward slash unescaped,
/// non-ASCII emitted as literal UTF-8), which is what proves Swift/TS parity in the shared vectors.
public enum CanonicalJSONValue {
	case string(String)
	case int(Int)
	case stringArray([String])

	func encoded() -> String {
		switch self {
		case let .string(value):
			return CanonicalJSON.encodeString(value)
		case let .int(value):
			return String(value)
		case let .stringArray(values):
			let inner = values.map(CanonicalJSON.encodeString).joined(separator: ",")
			return "[\(inner)]"
		}
	}
}

public enum CanonicalJSON {
	/// Encodes a top-level array of canonical values, e.g. `["tag","id",0,["relay-tls"]]`.
	public static func encodeArray(_ values: [CanonicalJSONValue]) -> String {
		let inner = values.map { $0.encoded() }.joined(separator: ",")
		return "[\(inner)]"
	}

	/// Mirrors ECMA-262 `JSON.stringify` string quoting: escapes `"` and `\`, uses the short escapes
	/// for the standard control characters, `\u00xx` for other C0 controls, and leaves everything
	/// else (including `/` and non-ASCII) untouched.
	static func encodeString(_ value: String) -> String {
		var out = "\""
		for scalar in value.unicodeScalars {
			switch scalar {
			case "\"":
				out += "\\\""
			case "\\":
				out += "\\\\"
			case "\u{08}":
				out += "\\b"
			case "\u{09}":
				out += "\\t"
			case "\u{0A}":
				out += "\\n"
			case "\u{0C}":
				out += "\\f"
			case "\u{0D}":
				out += "\\r"
			default:
				if scalar.value < 0x20 {
					out += String(format: "\\u%04x", scalar.value)
				} else {
					out.unicodeScalars.append(scalar)
				}
			}
		}
		out += "\""
		return out
	}
}
