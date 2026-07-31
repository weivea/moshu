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
import {
	CapacitorNotificationScheduler,
	type LocalNotificationScheduler,
	type NotificationPermissionState,
} from "../native/notifications";
import { AttentionController, type AttentionSnapshot } from "../rpc/attention-controller";
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

export interface AttentionProviderProps {
	readonly scheduler?: LocalNotificationScheduler;
	readonly children: ReactNode;
}

export function AttentionProvider({ scheduler, children }: AttentionProviderProps) {
	const { state } = useConnection();
	const { t } = useI18n();

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
