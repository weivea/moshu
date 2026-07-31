import type { ApprovalEventDelivery, ApprovalRequest } from "@moshu/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ActivityPage } from "./activity-page";
import { ApprovalsProvider } from "./approvals";
import { SessionApprovalCards } from "./chat/approval-card";
import { I18nProvider } from "./i18n";

let approvalEventListener: ((delivery: ApprovalEventDelivery) => void) | undefined;
const listApprovals = vi.fn();

vi.mock("../lib/rpc", () => ({
	desktopClient: {
		listApprovals: (input: unknown) => listApprovals(input),
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
		updateSessionApprovalPolicy: vi.fn(),
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
