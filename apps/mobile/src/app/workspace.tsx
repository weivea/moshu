import type {
	ApprovalRequest,
	ListRuntimeBoxesOutput,
	RuntimeBoxId,
	SessionApprovalPolicy,
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
import { useConnectedSession } from "./connection";

interface WorkspaceValue {
	readonly runtimeBoxes: ListRuntimeBoxesOutput | null;
	readonly activeRuntimeBoxId: RuntimeBoxId | null;
	readonly switchRuntimeBox: (runtimeBoxId: RuntimeBoxId) => Promise<void>;
	readonly pendingApprovals: readonly ApprovalRequest[];
	readonly policies: readonly SessionApprovalPolicy[];
	readonly refreshApprovals: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | undefined>(undefined);

/**
 * Holds the small amount of shared, in-memory workspace state the tabs read: the client-scoped
 * Runtime Box selection and the pending-approval set that drives the Activity badge. It lives inside
 * the connected subtree, so a disconnect unmounts it and every byte of business state is dropped —
 * there is no cache to leak stale content from.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
	const { client, bus } = useConnectedSession();
	const [runtimeBoxes, setRuntimeBoxes] = useState<ListRuntimeBoxesOutput | null>(null);
	const [pendingApprovals, setPendingApprovals] = useState<readonly ApprovalRequest[]>([]);
	const [policies, setPolicies] = useState<readonly SessionApprovalPolicy[]>([]);
	const mounted = useRef(true);

	const refreshRuntimeBoxes = useCallback(async () => {
		const result = await client.listRuntimeBoxes();
		if (mounted.current) {
			setRuntimeBoxes(result);
		}
	}, [client]);

	const refreshApprovals = useCallback(async () => {
		const result = await client.listApprovals({ states: ["pending"], limit: 200 });
		if (mounted.current) {
			setPendingApprovals(result.items);
			setPolicies(result.policies);
		}
	}, [client]);

	useEffect(() => {
		mounted.current = true;
		void refreshRuntimeBoxes();
		void refreshApprovals();
		const offBoxes = bus.on("runtimeBoxesChanged", (payload) => {
			if (mounted.current) {
				setRuntimeBoxes(payload);
			}
		});
		const offApprovalActivity = bus.on("approvalActivityChanged", () => {
			void refreshApprovals();
		});
		const offApprovalEvent = bus.on("approvalEvent", () => {
			void refreshApprovals();
		});
		return () => {
			mounted.current = false;
			offBoxes();
			offApprovalActivity();
			offApprovalEvent();
		};
	}, [bus, refreshRuntimeBoxes, refreshApprovals]);

	const switchRuntimeBox = useCallback(
		async (runtimeBoxId: RuntimeBoxId) => {
			const current = runtimeBoxes?.active;
			if (!current || current.runtimeBoxId === runtimeBoxId) {
				return;
			}
			const result = await client.switchRuntimeBox({
				runtimeBoxId,
				expectedRevision: current.revision,
			});
			if (mounted.current) {
				setRuntimeBoxes((prev) => (prev ? { ...prev, active: result.active } : prev));
			}
			await refreshRuntimeBoxes();
		},
		[client, runtimeBoxes, refreshRuntimeBoxes],
	);

	const value = useMemo<WorkspaceValue>(
		() => ({
			runtimeBoxes,
			activeRuntimeBoxId: runtimeBoxes?.active.runtimeBoxId ?? null,
			switchRuntimeBox,
			pendingApprovals,
			policies,
			refreshApprovals,
		}),
		[runtimeBoxes, switchRuntimeBox, pendingApprovals, policies, refreshApprovals],
	);

	return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
	const context = useContext(WorkspaceContext);
	if (!context) {
		throw new Error("useWorkspace must be used inside WorkspaceProvider.");
	}
	return context;
}
