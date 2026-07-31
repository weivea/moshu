import Foundation

/// The desensitized attention event kinds mirrored from the wire contract
/// (`mobileAttentionEventTypeSchema`). Used only to select a generic localization key — never to
/// render business content.
public enum MobileAttentionKind: String, Equatable, CaseIterable {
	case approvalRequired = "approval_required"
	case runCompleted = "run_completed"
	case runFailed = "run_failed"
	case runCancelled = "run_cancelled"
}

/// The minimal, desensitized descriptor the app hands to the notification builder. It carries only a
/// stable sequence, the event kind, and OPAQUE reference ids — never a prompt, message, tool
/// arguments, path, or shell command.
public struct MobileAttentionDescriptor: Equatable {
	public let kind: MobileAttentionKind
	public let seq: Int
	public let sessionId: String?
	public let approvalId: String?
	public let runId: String?

	public init(
		kind: MobileAttentionKind,
		seq: Int,
		sessionId: String? = nil,
		approvalId: String? = nil,
		runId: String? = nil
	) {
		self.kind = kind
		self.seq = seq
		self.sessionId = sessionId
		self.approvalId = approvalId
		self.runId = runId
	}
}

/// A ready-to-schedule notification described by generic localization KEYS (not resolved text) plus a
/// stable id and an opaque routing payload. The JS/UI layer resolves the keys to localized copy; the
/// content here is guaranteed free of business data.
public struct LocalNotificationContent: Equatable {
	public let id: Int
	public let titleKey: String
	public let bodyKey: String
	/// Opaque ids delivered on tap. The app re-authenticates + re-snapshots before navigating.
	public let routeUserInfo: [String: String]

	public init(id: Int, titleKey: String, bodyKey: String, routeUserInfo: [String: String]) {
		self.id = id
		self.titleKey = titleKey
		self.bodyKey = bodyKey
		self.routeUserInfo = routeUserInfo
	}
}

/// Builds desensitized local-notification content from an attention descriptor. Pure and testable:
/// it selects a generic localization key by kind, derives a stable numeric id from the sequence
/// (so duplicate deliveries of the same event coalesce), and packs ONLY opaque ids into the tap
/// payload.
public enum NotificationContentBuilder {
	/// Notification ids must fit in a native 32-bit int; the monotonic seq is folded into this range.
	public static let maxNotificationId = 2_147_483_647

	/// Derives a stable, positive 31-bit notification id from an attention sequence number.
	public static func stableId(forSeq seq: Int) -> Int {
		let normalized = abs(seq) % maxNotificationId
		return normalized == 0 ? maxNotificationId : normalized
	}

	/// The generic localization keys (title, body) for a given kind. These match the wire contract's
	/// `titleKey`/`bodyKey` values and never contain business content.
	public static func localizationKeys(for kind: MobileAttentionKind) -> (title: String, body: String) {
		switch kind {
		case .approvalRequired:
			return ("attention.approvalRequired.title", "attention.approvalRequired.body")
		case .runCompleted:
			return ("attention.runCompleted.title", "attention.runCompleted.body")
		case .runFailed:
			return ("attention.runFailed.title", "attention.runFailed.body")
		case .runCancelled:
			return ("attention.runCancelled.title", "attention.runCancelled.body")
		}
	}

	/// Builds the notification content for a descriptor.
	public static func build(_ descriptor: MobileAttentionDescriptor) -> LocalNotificationContent {
		let keys = localizationKeys(for: descriptor.kind)
		var route: [String: String] = [:]
		if let sessionId = descriptor.sessionId {
			route["sessionId"] = sessionId
		}
		if let approvalId = descriptor.approvalId {
			route["approvalId"] = approvalId
		}
		if let runId = descriptor.runId {
			route["runId"] = runId
		}
		return LocalNotificationContent(
			id: stableId(forSeq: descriptor.seq),
			titleKey: keys.title,
			bodyKey: keys.body,
			routeUserInfo: route
		)
	}
}
