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

interface ConnectionContextValue {
	readonly state: ConnectionState;
	readonly controller: ConnectionController;
}

const ConnectionContext = createContext<ConnectionContextValue | undefined>(undefined);

export interface ConnectionProviderProps {
	readonly controller?: ConnectionController;
	readonly children: ReactNode;
}

export function ConnectionProvider({ controller, children }: ConnectionProviderProps) {
	const controllerRef = useRef<ConnectionController | null>(controller ?? null);
	if (controllerRef.current === null) {
		controllerRef.current = new ConnectionController();
	}
	const activeController = controllerRef.current;
	const [state, setState] = useState<ConnectionState>(() => activeController.getState());

	useEffect(() => {
		const unsubscribe = activeController.subscribe(setState);
		void activeController.init();
		return unsubscribe;
	}, [activeController]);

	// App foreground/active lifecycle: a WKWebView receives `visibilitychange` when the App returns
	// to the foreground. Reconnect a paired-but-dropped session on activation (Layer 4 keeps only the
	// basic active/foreground connect lifecycle; background reliability is Layer 5).
	useEffect(() => {
		function handleVisibility(): void {
			if (document.visibilityState === "visible") {
				void activeController.onAppActive();
			}
		}
		document.addEventListener("visibilitychange", handleVisibility);
		window.addEventListener("focus", handleVisibility);
		return () => {
			document.removeEventListener("visibilitychange", handleVisibility);
			window.removeEventListener("focus", handleVisibility);
		};
	}, [activeController]);

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
