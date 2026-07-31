import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
	CapacitorNotificationScheduler,
	type LocalNotificationScheduler,
	type NotificationPermissionState,
	type NotificationRoute,
} from "../native/notifications";
import { AttentionController, type AttentionSnapshot } from "../rpc/attention-controller";
import type { ConnectionController, ConnectionState } from "../rpc/connection-controller";
import { NotificationTapCoordinator, type NotificationTapReadiness } from "../rpc/notification-tap";
import { useConnection } from "./connection";
import { useI18n } from "./i18n";
import { readNotificationsEnabled, writeNotificationsEnabled } from "./preferences";

interface AttentionContextValue {
	readonly snapshot: AttentionSnapshot;
	readonly permission: NotificationPermissionState;
	readonly notificationsEnabled: boolean;
	/** User-initiated enable: prompts for permission (if needed) and persists the opt-in. */
	enableNotifications(): Promise<void>;
	/** User-initiated disable: stops scheduling notifications (does not revoke OS permission). */
	disableNotifications(): void;
	/** Acknowledge the whole feed (mark all read). */
	markAllRead(): Promise<void>;
}

const AttentionContext = createContext<AttentionContextValue | undefined>(undefined);

const EMPTY_SNAPSHOT: AttentionSnapshot = {
	unreadCount: 0,
	ackSeq: 0,
	latestSeq: 0,
	resyncRequired: false,
};

// Upper bound on how long a notification tap waits for an authenticated connection + fresh snapshot
// before falling back to a safe state. Tapping foregrounds the app (which triggers reconnect), so a
// healthy session resolves well under this; the cap just guarantees we never hang on a dead network.
const NOTIFICATION_READY_TIMEOUT_MS = 15_000;

/** Map the connection state machine to the coarse readiness the tap coordinator gates on. */
function mapReadiness(state: ConnectionState): NotificationTapReadiness {
	switch (state.kind) {
		case "connected":
			return "ready";
		case "unpaired":
			return "unpaired";
		case "error":
			return "fatal";
		default:
			return "connecting";
	}
}

// Neutral in-app hub a notification tap falls back to whenever it cannot safely deep-link (unpaired,
// fatal, timed out, or a route carrying no navigable id). Activity re-snapshots the durable server
// feed, so we never surface a stale/opaque business id — the connection-state root still shows
// onboarding/offline/fatal as appropriate underneath.
const NOTIFICATION_SAFE_PATH = "/activity";

/**
 * Map an opaque, validated {@link NotificationRoute} to the in-app path a tap navigates to AFTER the
 * session is authenticated and freshly snapshotted. Approvals live on the Activity screen; a
 * session-scoped event deep-links to that chat. A Moshu-owned safe-activity marker (retention gap /
 * route lookup exhausted) and any route carrying only an opaque `attentionEventId` (or nothing
 * navigable) fall back to the safe Activity hub. Never derives a path from business content — only
 * server-issued ids.
 */
export function notificationRouteToPath(route: NotificationRoute): string {
	if (route.safeActivity) {
		return NOTIFICATION_SAFE_PATH;
	}
	if (route.approvalId) {
		return NOTIFICATION_SAFE_PATH;
	}
	if (route.sessionId) {
		return `/chats/${route.sessionId}`;
	}
	return NOTIFICATION_SAFE_PATH;
}

/**
 * Resolve once the connection is authenticated AND a fresh attention snapshot has been taken, so a
 * notification tap never navigates into stale content. Resolves `false` if the session drops to
 * unpaired/fatal or the wait times out.
 */
function waitUntilReady(
	connection: ConnectionController,
	attention: AttentionController,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe = () => {};
		const timer = setTimeout(() => finish(false), NOTIFICATION_READY_TIMEOUT_MS);

		function cleanup() {
			clearTimeout(timer);
			unsubscribe();
		}
		function finish(ready: boolean) {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(ready);
		}
		function evaluate(state: ConnectionState) {
			if (settled) {
				return;
			}
			const readiness = mapReadiness(state);
			if (readiness === "unpaired" || readiness === "fatal") {
				finish(false);
				return;
			}
			if (readiness === "ready") {
				settled = true;
				cleanup();
				// A fresh snapshot MUST land before navigation so we never surface cached business data.
				attention.refresh().then(
					() => resolve(true),
					() => resolve(false),
				);
			}
		}

		unsubscribe = connection.subscribe(evaluate);
		evaluate(connection.getState());
	});
}

export interface AttentionProviderProps {
	readonly scheduler?: LocalNotificationScheduler;
	/** Navigate to an opaque route after a notification tap resolves to a ready, refreshed session. */
	readonly onNotificationNavigate?: (route: NotificationRoute) => void;
	/** Surface a safe (non-navigating) state when a tap lands while unpaired/fatal or before ready. */
	readonly onNotificationSafeState?: (route: NotificationRoute) => void;
	readonly children: ReactNode;
}

export function AttentionProvider({
	scheduler,
	onNotificationNavigate,
	onNotificationSafeState,
	children,
}: AttentionProviderProps) {
	const { state, controller: connectionController } = useConnection();
	const { t } = useI18n();
	const navigate = useNavigate();

	const [snapshot, setSnapshot] = useState<AttentionSnapshot>(EMPTY_SNAPSHOT);
	const [permission, setPermission] = useState<NotificationPermissionState>("prompt");
	const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() =>
		readNotificationsEnabled(),
	);

	// Refs so the controller (created once) always reads the latest gating inputs without re-binding.
	const enabledRef = useRef(notificationsEnabled);
	const permissionRef = useRef(permission);
	const translateRef = useRef(t);
	enabledRef.current = notificationsEnabled;
	permissionRef.current = permission;
	translateRef.current = t;

	// Production default: a validated tap navigates through the REAL router (this provider is mounted
	// inside the app's router), and a safe-state tap lands on the neutral Activity hub. Callers may
	// override either handler (tests) — but wiring is never an optional no-op in production.
	const defaultNavigate = useCallback(
		(route: NotificationRoute) => {
			navigate(notificationRouteToPath(route));
		},
		[navigate],
	);
	const defaultSafeState = useCallback(() => {
		navigate(NOTIFICATION_SAFE_PATH);
	}, [navigate]);

	// Notification-tap callbacks are read through refs so the coordinator (created once) always calls
	// the latest handler without being torn down and re-registered on every render. Props override the
	// production defaults so a tap is always wired to real navigation.
	const navigateRef = useRef<(route: NotificationRoute) => void>(
		onNotificationNavigate ?? defaultNavigate,
	);
	const safeStateRef = useRef<(route: NotificationRoute) => void>(
		onNotificationSafeState ?? defaultSafeState,
	);
	navigateRef.current = onNotificationNavigate ?? defaultNavigate;
	safeStateRef.current = onNotificationSafeState ?? defaultSafeState;

	const schedulerRef = useRef<LocalNotificationScheduler | null>(scheduler ?? null);
	if (schedulerRef.current === null) {
		schedulerRef.current = new CapacitorNotificationScheduler();
	}
	const activeScheduler = schedulerRef.current;

	const controllerRef = useRef<AttentionController | null>(null);
	if (controllerRef.current === null) {
		controllerRef.current = new AttentionController({
			scheduler: activeScheduler,
			// The app is considered active whenever the connection state machine is not paused for
			// background. We approximate "active" as document visibility here; live notifications are
			// only raised while NOT active.
			isAppActive: () => typeof document === "undefined" || document.visibilityState === "visible",
			isNotificationsEnabled: () => enabledRef.current && permissionRef.current === "granted",
			notificationText: () => ({
				title: translateRef.current("notification.attention.title"),
				body: translateRef.current("notification.attention.body"),
			}),
			onUnreadChange: setSnapshot,
		});
	}
	const controller = controllerRef.current;

	// Query the OS permission once on mount so Settings can render the real status.
	useEffect(() => {
		let cancelled = false;
		void activeScheduler.getPermission().then((value) => {
			if (!cancelled) {
				setPermission(value);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [activeScheduler]);

	// Bind/unbind the controller to the live session. On connect it takes a recovery snapshot (badge
	// only, no historical notification replay); any non-connected state detaches it.
	useEffect(() => {
		if (state.kind === "connected") {
			controller.attach(state.client, state.bus);
			return () => {
				controller.detach();
			};
		}
		controller.detach();
		return undefined;
	}, [controller, state]);

	// Register (and dispose) the single notification-tap listener. A tap only navigates after the
	// session is authenticated and a fresh attention snapshot has landed; unpaired/fatal taps show a
	// safe state instead of stale content. The coordinator is recreated only if a controller identity
	// changes (never on normal renders), so there is exactly one live native listener.
	useEffect(() => {
		const coordinator = new NotificationTapCoordinator({
			scheduler: activeScheduler,
			readiness: () => mapReadiness(connectionController.getState()),
			waitUntilReady: () => waitUntilReady(connectionController, controller),
			navigate: (route) => navigateRef.current(route),
			showSafeState: (route) => safeStateRef.current(route),
		});
		coordinator.start();
		return () => {
			coordinator.dispose();
		};
	}, [activeScheduler, connectionController, controller]);

	const enableNotifications = useCallback(async () => {
		const result = await activeScheduler.requestPermission();
		setPermission(result);
		const enabled = result === "granted";
		setNotificationsEnabled(enabled);
		writeNotificationsEnabled(enabled);
	}, [activeScheduler]);

	const disableNotifications = useCallback(() => {
		setNotificationsEnabled(false);
		writeNotificationsEnabled(false);
	}, []);

	const markAllRead = useCallback(async () => {
		await controller.ackAll();
	}, [controller]);

	const value = useMemo<AttentionContextValue>(
		() => ({
			snapshot,
			permission,
			notificationsEnabled,
			enableNotifications,
			disableNotifications,
			markAllRead,
		}),
		[
			snapshot,
			permission,
			notificationsEnabled,
			enableNotifications,
			disableNotifications,
			markAllRead,
		],
	);

	return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useAttention(): AttentionContextValue {
	const context = useContext(AttentionContext);
	if (!context) {
		throw new Error("useAttention must be used inside AttentionProvider.");
	}
	return context;
}
