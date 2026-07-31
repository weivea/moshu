import Foundation

/// Backing for a single, bounded background execution window. The real implementation wraps
/// `UIApplication.beginBackgroundTask`/`endBackgroundTask`; tests inject a fake so the coordinator's
/// idempotency and cleanup guarantees can be verified without UIKit.
public protocol BackgroundTaskHost: AnyObject {
	/// Starts one background task and returns an opaque identifier. The `expirationHandler` MUST be
	/// invoked by the host when the OS is about to reclaim the time (so we can clean up in time).
	func beginTask(expirationHandler: @escaping () -> Void) -> Int
	/// Ends the background task with the given identifier. Safe to call at most once per id.
	func endTask(_ id: Int)
}

/// Coordinates a *single*, idempotent, bounded background task used to let an already-open socket
/// briefly survive after the App leaves the foreground so a live attention event can still arrive.
///
/// Guarantees (per Layer 5 DoD):
///   * **Single task** — `begin()` never starts a second task while one is active.
///   * **Idempotent** — repeated `begin()`/`end()` calls are safe and no-op after the first.
///   * **Bounded** — the task lives only until `end()` or the OS expiration, whichever comes first.
///   * **Guaranteed cleanup** — the expiration handler always ends the task exactly once and invokes
///     `onExpire` (which the app uses to close the socket / end the window) so the process is never
///     killed for overrunning its background time.
///
/// This does NOT declare a `UIBackgroundMode`, register for remote/silent push, or fake keep-alive.
/// It is a plain finite background task; when it ends, the socket is torn down.
public final class BackgroundActivityCoordinator {
	private let host: BackgroundTaskHost
	private let onExpire: () -> Void
	private let lock = NSLock()
	private var taskId: Int?

	public init(host: BackgroundTaskHost, onExpire: @escaping () -> Void) {
		self.host = host
		self.onExpire = onExpire
	}

	/// Whether a background task is currently active.
	public var isActive: Bool {
		lock.lock()
		defer { lock.unlock() }
		return taskId != nil
	}

	/// Begins the single background task if one is not already running. Idempotent.
	public func begin() {
		lock.lock()
		if taskId != nil {
			lock.unlock()
			return
		}
		// Release the lock before calling the host: the host may invoke the expiration handler
		// synchronously in tests, and re-entering the lock there would deadlock.
		lock.unlock()
		let id = host.beginTask { [weak self] in
			self?.handleExpiration()
		}
		lock.lock()
		if taskId == nil {
			taskId = id
			lock.unlock()
		} else {
			// A concurrent begin already recorded a task; end this duplicate to keep exactly one.
			lock.unlock()
			host.endTask(id)
		}
	}

	/// Ends the active background task if any. Idempotent.
	public func end() {
		lock.lock()
		guard let id = taskId else {
			lock.unlock()
			return
		}
		taskId = nil
		lock.unlock()
		host.endTask(id)
	}

	/// OS expiration path: clean up exactly once — run `onExpire` (close the socket) then end the task.
	/// If the task was already ended (e.g. the App returned to the foreground and called `end()`),
	/// a late/stale expiration callback is a strict no-op: it must NOT run `onExpire`, so an expired
	/// task can never tear down a *newer* connection opened by a subsequent foreground session.
	private func handleExpiration() {
		lock.lock()
		guard let id = taskId else {
			lock.unlock()
			return
		}
		taskId = nil
		lock.unlock()
		onExpire()
		host.endTask(id)
	}
}
