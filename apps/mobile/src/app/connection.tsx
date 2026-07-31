import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { MobileTransportBinding } from "../native";
import type { MobileEventBus } from "../rpc/events";
import type { MobileProductClient } from "../rpc/product-client";
import { ConnectionController, type ConnectionState } from "../rpc/connection-controller";
import { type AppLifecycle, CapacitorAppLifecycle } from "../native/lifecycle";

interface ConnectionContextValue {
	readonly state: ConnectionState;
	readonly controller: ConnectionController;
}

const ConnectionContext = createContext<ConnectionContextValue | undefined>(undefined);

export interface ConnectionProviderProps {
	readonly controller?: ConnectionController;
	readonly lifecycle?: AppLifecycle;
	readonly children: ReactNode;
}

export function ConnectionProvider({ controller, lifecycle, children }: ConnectionProviderProps) {
	const controllerRef = useRef<ConnectionController | null>(controller ?? null);
	if (controllerRef.current === null) {
		controllerRef.current = new ConnectionController();
	}
	const activeController = controllerRef.current;
	const lifecycleRef = useRef<AppLifecycle | null>(lifecycle ?? null);
	if (lifecycleRef.current === null) {
		lifecycleRef.current = new CapacitorAppLifecycle();
	}
	const activeLifecycle = lifecycleRef.current;
	const [state, setState] = useState<ConnectionState>(() => activeController.getState());

	useEffect(() => {
		const unsubscribe = activeController.subscribe(setState);
		void activeController.init();
		return unsubscribe;
	}, [activeController]);

	// App foreground/background lifecycle. On foreground we reconnect + resnapshot a paired-but-dropped
	// session; on background we STOP scheduling new reconnects (no fake keep-alive) and let any live
	// socket run out its short OS-granted window. The lifecycle source is native `@capacitor/app` on
	// device and `document.visibilitychange` on web/dev.
	useEffect(() => {
		return activeLifecycle.subscribe({
			onActive() {
				void activeController.onAppActive();
			},
			onBackground() {
				activeController.onAppBackground();
			},
		});
	}, [activeController, activeLifecycle]);

	const value = useMemo<ConnectionContextValue>(
		() => ({ state, controller: activeController }),
		[state, activeController],
	);

	return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
	const context = useContext(ConnectionContext);
	if (!context) {
		throw new Error("useConnection must be used inside ConnectionProvider.");
	}
	return context;
}

export interface ConnectedSession {
	readonly client: MobileProductClient;
	readonly bus: MobileEventBus;
	readonly binding: MobileTransportBinding;
}

/** Returns the live session handles; only valid inside a subtree rendered while `connected`. */
export function useConnectedSession(): ConnectedSession {
	const { state } = useConnection();
	if (state.kind !== "connected") {
		throw new Error("useConnectedSession requires an active connection.");
	}
	return { client: state.client, bus: state.bus, binding: state.binding };
}
