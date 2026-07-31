import UIKit
import Capacitor
import MoshuMobileCore

/// Bridges `UIApplication`'s background-task API to the pure-logic ``BackgroundActivityCoordinator``.
/// This is a plain, finite background task — NOT a declared `UIBackgroundMode`, remote/silent push,
/// or VoIP keep-alive. It only extends the App's runtime briefly after backgrounding so an already
/// open socket can still receive a live attention event; when it ends (or the OS expires it) the web
/// layer's lifecycle handling tears the socket down.
final class UIApplicationBackgroundTaskHost: BackgroundTaskHost {
	func beginTask(expirationHandler: @escaping () -> Void) -> Int {
		let identifier = UIApplication.shared.beginBackgroundTask(
			withName: "dev.moshu.mobile.attention-window",
			expirationHandler: expirationHandler
		)
		return Int(identifier.rawValue)
	}

	func endTask(_ id: Int) {
		UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: UInt(id)))
	}
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Owns the single bounded background task. Created lazily so the coordinator's cleanup callback
    /// captures a stable instance.
    private lazy var backgroundActivity = BackgroundActivityCoordinator(
        host: UIApplicationBackgroundTaskHost(),
        // On OS expiration there is nothing native to tear down here: the web layer closes the socket
        // via `@capacitor/app` lifecycle. The coordinator itself guarantees the task is ended.
        onExpire: {}
    )

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Begin the single, bounded background task so an already-open socket can survive the OS's
        // short background window and still receive a live attention event. Idempotent.
        backgroundActivity.begin()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Back in the foreground: end the background task promptly (idempotent). The web layer
        // reconnects and re-snapshots the durable attention feed.
        backgroundActivity.end()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Ensure the background task is released if the app is terminating.
        backgroundActivity.end()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
