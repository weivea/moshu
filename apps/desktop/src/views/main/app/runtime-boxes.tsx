import {
	defaultLocalRuntimeBoxId,
	type ListRuntimeBoxesOutput,
	type RuntimeBoxConnectionInfo,
} from "@moshu/contracts";
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
import { desktopClient } from "../lib/rpc";

interface RuntimeBoxesContextValue {
	snapshot: ListRuntimeBoxesOutput;
	activeBox: RuntimeBoxConnectionInfo | undefined;
	isActiveReady: boolean;
	isRuntimeBoxReady(runtimeBoxId: string): boolean;
	isLoading: boolean;
	errorMessage: string | undefined;
	refresh(): Promise<void>;
	switchRuntimeBox(runtimeBoxId: string): Promise<void>;
}

const previewSnapshot: ListRuntimeBoxesOutput = {
	active: { runtimeBoxId: defaultLocalRuntimeBoxId, revision: 1 },
	items: [
		{
			runtimeBox: {
				schemaVersion: 1,
				runtimeBoxId: defaultLocalRuntimeBoxId,
				kind: "local",
				displayName: "Local Runtime Box",
				runtimeBoxVersion: "preview",
				platform: "darwin",
				arch: "preview",
				capabilities: [],
			},
			connected: true,
			registered: true,
			deviceKeyIds: [],
			state: "online",
			compatibility: "compatible",
			negotiatedProtocolVersion: 1,
			transportSecurity: "relay-tls",
		},
	],
};

const previewActiveBox = previewSnapshot.items[0];
const previewContext: RuntimeBoxesContextValue = {
	snapshot: previewSnapshot,
	activeBox: previewActiveBox,
	isActiveReady: true,
	isRuntimeBoxReady: () => true,
	isLoading: false,
	errorMessage: undefined,
	refresh: () => Promise.resolve(),
	switchRuntimeBox: () => Promise.resolve(),
};
const RuntimeBoxesContext = createContext<RuntimeBoxesContextValue>(previewContext);

export function RuntimeBoxesProvider({ children }: { children: ReactNode }) {
	const desktopRuntime = typeof window !== "undefined" && "__electrobun" in window;
	const [snapshot, setSnapshot] = useState<ListRuntimeBoxesOutput>(previewSnapshot);
	const [isLoading, setIsLoading] = useState(desktopRuntime);
	const [errorMessage, setErrorMessage] = useState<string>();
	const mountedRef = useRef(true);

	const applySnapshot = useCallback((next: ListRuntimeBoxesOutput) => {
		setSnapshot((current) => (next.active.revision < current.active.revision ? current : next));
	}, []);

	const refresh = useCallback(async () => {
		if (!desktopRuntime) {
			return;
		}
		setIsLoading(true);
		setErrorMessage(undefined);
		try {
			const next = await desktopClient.listRuntimeBoxes();
			if (mountedRef.current) {
				applySnapshot(next);
			}
		} catch (error) {
			if (mountedRef.current) {
				setErrorMessage(error instanceof Error ? error.message : "Unable to load Runtime Boxes.");
			}
		} finally {
			if (mountedRef.current) {
				setIsLoading(false);
			}
		}
	}, [applySnapshot, desktopRuntime]);

	useEffect(() => {
		mountedRef.current = true;
		const unsubscribeChanged = desktopRuntime
			? desktopClient.subscribeRuntimeBoxesChanged(applySnapshot)
			: undefined;
		const unsubscribeReady = desktopRuntime
			? desktopClient.subscribeAgentsReady(() => void refresh())
			: undefined;
		void refresh();
		return () => {
			mountedRef.current = false;
			unsubscribeChanged?.();
			unsubscribeReady?.();
		};
	}, [applySnapshot, desktopRuntime, refresh]);

	const switchRuntimeBox = useCallback(
		async (runtimeBoxId: string) => {
			if (runtimeBoxId === snapshot.active.runtimeBoxId) {
				return;
			}
			setErrorMessage(undefined);
			try {
				const output = await desktopClient.switchRuntimeBox({
					runtimeBoxId,
					expectedRevision: snapshot.active.revision,
				});
				if (mountedRef.current) {
					applySnapshot({ ...snapshot, active: output.active });
					await refresh();
				}
			} catch (error) {
				if (mountedRef.current) {
					setErrorMessage(error instanceof Error ? error.message : "Unable to switch Runtime Box.");
				}
				throw error;
			}
		},
		[applySnapshot, refresh, snapshot],
	);

	const value = useMemo<RuntimeBoxesContextValue>(() => {
		const activeBox = snapshot.items.find(
			(item) => item.runtimeBox.runtimeBoxId === snapshot.active.runtimeBoxId,
		);
		return {
			snapshot,
			activeBox,
			isActiveReady: activeBox?.connected === true && activeBox.registered,
			isRuntimeBoxReady: (runtimeBoxId) => {
				const runtimeBox = snapshot.items.find(
					(item) => item.runtimeBox.runtimeBoxId === runtimeBoxId,
				);
				return runtimeBox?.connected === true && runtimeBox.registered;
			},
			isLoading,
			errorMessage,
			refresh,
			switchRuntimeBox,
		};
	}, [errorMessage, isLoading, refresh, snapshot, switchRuntimeBox]);

	return <RuntimeBoxesContext.Provider value={value}>{children}</RuntimeBoxesContext.Provider>;
}

export function useRuntimeBoxes(): RuntimeBoxesContextValue {
	return useContext(RuntimeBoxesContext);
}
