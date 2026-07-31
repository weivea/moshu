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
	// Monotonic generation stamped on every begin(). The expiration closure captures the generation it
	// was created for; a callback whose generation is no longer the active one is a strict no-op. This
	// is what stops a late/stale expiration from a previous task (already ended or superseded) from
	// tearing down a NEWER task's socket.
	private var generation: UInt64 = 0
	// The generation of the window the app currently wants alive. `nil` means no active window (never
	// begun, or ended/expired). Only the callback matching this generation may run `onExpire`/end.
	private var activeGeneration: UInt64?
	// Set when the OS fires expiration *synchronously inside* `host.beginTask`, before we have recorded
	// the returned task id. begin() observes this after beginTask returns and completes the expiration
	// (onExpire + endTask) with the now-known id, so a synchronous expiration is never dropped.
	private var pendingExpired = false

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
		generation &+= 1
		let token = generation
		activeGeneration = token
		pendingExpired = false
		// Release the lock before calling the host: the host may invoke the expiration handler
		// synchronously in tests, and re-entering the lock there would deadlock.
		lock.unlock()

		let id = host.beginTask { [weak self] in
			self?.handleExpiration(token)
		}

		lock.lock()
		// A newer begin() (or an end()) superseded this window while beginTask was running: this task id
		// is stale, so end it immediately and record nothing.
		if activeGeneration != token {
			lock.unlock()
			host.endTask(id)
			return
		}
		// Expiration fired synchronously during beginTask, before we could record the id. Complete it
		// now with the known id: clear the active window, run onExpire, and end exactly this task.
		if pendingExpired {
			pendingExpired = false
			activeGeneration = nil
			taskId = nil
			lock.unlock()
			onExpire()
			host.endTask(id)
			return
		}
		taskId = id
		lock.unlock()
	}

	/// Ends the active background task if any. Idempotent.
	public func end() {
		lock.lock()
		// Retire the current window so any in-flight/late expiration callback becomes a no-op.
		activeGeneration = nil
		pendingExpired = false
		guard let id = taskId else {
			lock.unlock()
			return
		}
		taskId = nil
		lock.unlock()
		host.endTask(id)
	}

	/// OS expiration path: clean up exactly once — run `onExpire` (close the socket) then end the task.
	/// The callback carries the `token` of the window it was created for; if that window is no longer
	/// active (the app called `end()` and returned to the foreground, or a newer `begin()` superseded
	/// it) the callback is a strict no-op, so an expired/stale task can never tear down a newer
	/// connection. If expiration races ahead of `begin()` recording the task id, we latch
	/// `pendingExpired` and let `begin()` finish the teardown once it has the id.
	private func handleExpiration(_ token: UInt64) {
		lock.lock()
		guard activeGeneration == token else {
			lock.unlock()
			return
		}
		guard let id = taskId else {
			// Synchronous expiration before begin() recorded the id: defer to begin().
			pendingExpired = true
			lock.unlock()
			return
		}
		activeGeneration = nil
		taskId = nil
		lock.unlock()
		onExpire()
		host.endTask(id)
	}
}
