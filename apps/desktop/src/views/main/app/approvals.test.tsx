import type { ApprovalEventDelivery, ApprovalRequest } from "@moshu/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ActivityPage } from "./activity-page";
import { ApprovalsProvider, useApprovals } from "./approvals";
import { SessionApprovalCards } from "./chat/approval-card";
import { I18nProvider } from "./i18n";

let approvalEventListener: ((delivery: ApprovalEventDelivery) => void) | undefined;
const listApprovals = vi.fn();
const getApproval = vi.fn();
const updateSessionApprovalPolicy = vi.fn();

vi.mock("../lib/rpc", () => ({
	desktopClient: {
		listApprovals: (input: unknown) => listApprovals(input),
		getApproval: (input: unknown) => getApproval(input),
		subscribeApprovalEvents: (listener: (delivery: ApprovalEventDelivery) => void) => {
			approvalEventListener = listener;
			return () => {
				approvalEventListener = undefined;
			};
		},
		subscribeSessionApprovalPolicyChanged: () => () => {},
		subscribeApprovalActivityChanged: () => () => {},
		subscribeAgentsReady: () => () => {},
		decideApproval: vi.fn(),
		updateSessionApprovalPolicy: (input: unknown) => updateSessionApprovalPolicy(input),
	},
}));

const sessionId = "018f2c60-0000-7000-8000-000000000001";

function buildRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		schemaVersion: 1,
		id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
		sessionId,
		runId: "018f2c60-0000-7000-8000-000000000002",
		actionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
		toolCallId: "call-1",
		action: {
			tool: "edit",
			operation: "edit",
			target: { kind: "runtime-box", id: "local" },
			path: "src/index.ts",
			redactedParams: {},
		},
		risk: { tier: "medium", overridable: true, reasons: ["Writes to the workspace"] },
		state: "pending",
		revision: 1,
		createdAt: "2024-05-01T10:00:00.000Z",
		expiresAt: "2024-05-01T10:10:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
	(window as unknown as { __electrobun?: unknown }).__electrobun = {};
	approvalEventListener = undefined;
	listApprovals.mockReset();
	listApprovals.mockResolvedValue({ schemaVersion: 1, items: [], policies: [] });
	getApproval.mockReset();
	updateSessionApprovalPolicy.mockReset();
});

afterEach(() => {
	(window as unknown as { __electrobun?: unknown }).__electrobun = undefined;
});

describe("ApprovalsProvider real-time sync", () => {
	test("a created event surfaces a chat card and clears when resolved", async () => {
		render(
			<I18nProvider>
				<MemoryRouter>
					<ApprovalsProvider>
						<SessionApprovalCards sessionId={sessionId} />
					</ApprovalsProvider>
				</MemoryRouter>
			</I18nProvider>,
		);

		await waitFor(() => expect(listApprovals).toHaveBeenCalled());
		expect(screen.queryByRole("heading", { name: "edit" })).not.toBeInTheDocument();

		act(() => {
			approvalEventListener?.({ schemaVersion: 1, kind: "created", request: buildRequest() });
		});
		expect(await screen.findByRole("heading", { name: "edit" })).toBeInTheDocument();

		act(() => {
			approvalEventListener?.({
				schemaVersion: 1,
				kind: "updated",
				request: buildRequest({ state: "approved", revision: 2 }),
			});
		});
		await waitFor(() =>
			expect(screen.queryByRole("heading", { name: "edit" })).not.toBeInTheDocument(),
		);
	});

	test("a stale refresh cannot erase a newer live approval event", async () => {
		const staleSnapshot = Promise.withResolvers<{
			schemaVersion: 1;
			items: ApprovalRequest[];
			policies: [];
		}>();
		listApprovals.mockReturnValueOnce(staleSnapshot.promise);
		render(
			<I18nProvider>
				<MemoryRouter>
					<ApprovalsProvider>
						<SessionApprovalCards sessionId={sessionId} />
					</ApprovalsProvider>
				</MemoryRouter>
			</I18nProvider>,
		);

		await waitFor(() => expect(listApprovals).toHaveBeenCalled());
		act(() => {
			approvalEventListener?.({ schemaVersion: 1, kind: "created", request: buildRequest() });
		});
		expect(await screen.findByRole("button", { name: "Approve once" })).toBeInTheDocument();

		await act(async () => {
			staleSnapshot.resolve({ schemaVersion: 1, items: [], policies: [] });
			await staleSnapshot.promise;
		});
		expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
	});

	test("loads a missing approval directly by id", async () => {
		const request = buildRequest();
		listApprovals.mockReturnValueOnce(new Promise(() => {}));
		getApproval.mockResolvedValue({
			schemaVersion: 1,
			request,
			policy: {
				schemaVersion: 1,
				sessionId,
				allowAll: false,
				revision: 0,
				updatedAt: "2024-05-01T09:59:00.000Z",
			},
		});
		render(
			<I18nProvider>
				<MemoryRouter>
					<ApprovalsProvider>
						<EnsureApproval approvalId={request.id} />
						<SessionApprovalCards sessionId={sessionId} />
					</ApprovalsProvider>
				</MemoryRouter>
			</I18nProvider>,
		);

		expect(await screen.findByRole("button", { name: "Approve once" })).toBeInTheDocument();
		expect(getApproval).toHaveBeenCalledWith({ approvalId: request.id });
	});

	test("Allow all atomically resolves the current approval", async () => {
		const request = buildRequest();
		const initialPolicy = {
			schemaVersion: 1 as const,
			sessionId,
			allowAll: false,
			revision: 0,
			updatedAt: "2024-05-01T09:59:00.000Z",
		};
		const enabledPolicy = {
			...initialPolicy,
			allowAll: true,
			revision: 1,
			updatedAt: "2024-05-01T10:01:00.000Z",
		};
		listApprovals.mockResolvedValueOnce({
			schemaVersion: 1,
			items: [request],
			policies: [initialPolicy],
		});
		updateSessionApprovalPolicy.mockResolvedValue({
			schemaVersion: 1,
			policy: enabledPolicy,
			request: buildRequest({
				state: "approved",
				revision: 2,
				decidedAt: "2024-05-01T10:01:00.000Z",
				decision: {
					kind: "approve_once",
					source: { kind: "policy" },
					decidedAt: "2024-05-01T10:01:00.000Z",
				},
				policyEvidence: { allowAllRevision: 1 },
			}),
		});
		render(
			<I18nProvider>
				<MemoryRouter>
					<ApprovalsProvider>
						<SessionApprovalCards sessionId={sessionId} />
					</ApprovalsProvider>
				</MemoryRouter>
			</I18nProvider>,
		);

		const button = await screen.findByRole("button", {
			name: "Allow all for this Session",
		});
		act(() => button.click());
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument(),
		);
		expect(updateSessionApprovalPolicy).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				allowAll: true,
				expectedRevision: 0,
				approveRequest: {
					approvalId: request.id,
					expectedRevision: request.revision,
				},
			}),
		);
	});

	test("the activity list shows pending approvals across sessions", async () => {
		render(
			<I18nProvider>
				<MemoryRouter>
					<ApprovalsProvider>
						<ActivityPage />
					</ApprovalsProvider>
				</MemoryRouter>
			</I18nProvider>,
		);

		await waitFor(() => expect(listApprovals).toHaveBeenCalled());
		expect(screen.getByText("No pending approvals.")).toBeInTheDocument();

		act(() => {
			approvalEventListener?.({ schemaVersion: 1, kind: "created", request: buildRequest() });
		});

		expect(await screen.findByText("edit")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open session" })).toBeInTheDocument();
	});
});

function EnsureApproval({ approvalId }: { approvalId: string }) {
	const { ensureApproval } = useApprovals();
	useEffect(() => {
		void ensureApproval(approvalId);
	}, [approvalId, ensureApproval]);
	return null;
}
