import type {
	ApprovalDecisionKind,
	ApprovalRequest,
	DecideApprovalOutput,
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
import { desktopClient } from "../lib/rpc";

interface ApprovalsContextValue {
	/** Every pending approval across all visible sessions, newest first. */
	pending: ApprovalRequest[];
	isLoading: boolean;
	errorMessage: string | undefined;
	approvalsForSession(sessionId: string): ApprovalRequest[];
	policyForSession(sessionId: string): SessionApprovalPolicy | undefined;
	refresh(): Promise<void>;
	decide(request: ApprovalRequest, decision: ApprovalDecisionKind): Promise<DecideApprovalOutput>;
	setAllowAll(sessionId: string, allowAll: boolean): Promise<void>;
}

const emptyContext: ApprovalsContextValue = {
	pending: [],
	isLoading: false,
	errorMessage: undefined,
	approvalsForSession: () => [],
	policyForSession: () => undefined,
	refresh: () => Promise.resolve(),
	decide: () => Promise.reject(new Error("Approvals are unavailable outside the desktop runtime.")),
	setAllowAll: () => Promise.resolve(),
};

const ApprovalsContext = createContext<ApprovalsContextValue>(emptyContext);

function newerRequest(current: ApprovalRequest | undefined, next: ApprovalRequest): boolean {
	return current === undefined || next.revision >= current.revision;
}

function newerPolicy(
	current: SessionApprovalPolicy | undefined,
	next: SessionApprovalPolicy,
): boolean {
	return current === undefined || next.revision >= current.revision;
}

export function ApprovalsProvider({ children }: { children: ReactNode }) {
	const desktopRuntime = typeof window !== "undefined" && "__electrobun" in window;
	const [requests, setRequests] = useState<Map<string, ApprovalRequest>>(() => new Map());
	const [policies, setPolicies] = useState<Map<string, SessionApprovalPolicy>>(() => new Map());
	const [isLoading, setIsLoading] = useState(desktopRuntime);
	const [errorMessage, setErrorMessage] = useState<string>();
	const mountedRef = useRef(true);

	const upsertRequest = useCallback((next: ApprovalRequest) => {
		setRequests((current) => {
			if (!newerRequest(current.get(next.id), next)) {
				return current;
			}
			const updated = new Map(current);
			updated.set(next.id, next);
			return updated;
		});
	}, []);

	const upsertPolicy = useCallback((next: SessionApprovalPolicy) => {
		setPolicies((current) => {
			if (!newerPolicy(current.get(next.sessionId), next)) {
				return current;
			}
			const updated = new Map(current);
			updated.set(next.sessionId, next);
			return updated;
		});
	}, []);

	const refresh = useCallback(async () => {
		if (!desktopRuntime) {
			return;
		}
		setIsLoading(true);
		setErrorMessage(undefined);
		try {
			const snapshot = await desktopClient.listApprovals({ states: ["pending"] });
			if (!mountedRef.current) {
				return;
			}
			setRequests((current) => {
				const updated = new Map(current);
				// Drop stale pending rows that the server no longer reports.
				const seen = new Set(snapshot.items.map((item) => item.id));
				for (const [id, request] of current) {
					if (request.state === "pending" && !seen.has(id)) {
						updated.delete(id);
					}
				}
				for (const item of snapshot.items) {
					if (newerRequest(updated.get(item.id), item)) {
						updated.set(item.id, item);
					}
				}
				return updated;
			});
			for (const policy of snapshot.policies) {
				upsertPolicy(policy);
			}
		} catch (error) {
			if (mountedRef.current) {
				setErrorMessage(error instanceof Error ? error.message : "Unable to load approvals.");
			}
		} finally {
			if (mountedRef.current) {
				setIsLoading(false);
			}
		}
	}, [desktopRuntime, upsertPolicy]);

	useEffect(() => {
		mountedRef.current = true;
		if (!desktopRuntime) {
			return () => {
				mountedRef.current = false;
			};
		}
		const unsubscribeEvents = desktopClient.subscribeApprovalEvents((delivery) => {
			upsertRequest(delivery.request);
		});
		const unsubscribePolicy = desktopClient.subscribeSessionApprovalPolicyChanged((event) => {
			upsertPolicy(event.policy);
		});
		const unsubscribeActivity = desktopClient.subscribeApprovalActivityChanged(() => {
			void refresh();
		});
		const unsubscribeReady = desktopClient.subscribeAgentsReady(() => void refresh());
		void refresh();
		return () => {
			mountedRef.current = false;
			unsubscribeEvents();
			unsubscribePolicy();
			unsubscribeActivity();
			unsubscribeReady();
		};
	}, [desktopRuntime, refresh, upsertPolicy, upsertRequest]);

	const decide = useCallback(
		async (request: ApprovalRequest, decision: ApprovalDecisionKind) => {
			const output = await desktopClient.decideApproval({
				approvalId: request.id,
				expectedRevision: request.revision,
				decision,
				idempotencyKey: crypto.randomUUID(),
			});
			if (mountedRef.current) {
				upsertRequest(output.request);
			}
			return output;
		},
		[upsertRequest],
	);

	const setAllowAll = useCallback(
		async (sessionId: string, allowAll: boolean) => {
			const current = policies.get(sessionId);
			const output = await desktopClient.updateSessionApprovalPolicy({
				sessionId,
				allowAll,
				expectedRevision: current?.revision ?? 0,
				idempotencyKey: crypto.randomUUID(),
			});
			if (mountedRef.current) {
				upsertPolicy(output.policy);
			}
		},
		[policies, upsertPolicy],
	);

	const value = useMemo<ApprovalsContextValue>(() => {
		const pending = [...requests.values()]
			.filter((request) => request.state === "pending")
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
		return {
			pending,
			isLoading,
			errorMessage,
			approvalsForSession: (sessionId) =>
				pending.filter((request) => request.sessionId === sessionId),
			policyForSession: (sessionId) => policies.get(sessionId),
			refresh,
			decide,
			setAllowAll,
		};
	}, [decide, errorMessage, isLoading, policies, refresh, requests, setAllowAll]);

	return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

export function useApprovals(): ApprovalsContextValue {
	return useContext(ApprovalsContext);
}
