import type { ApprovalRequest } from "@moshu/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const decideApproval = vi.fn();
const updateSessionApprovalPolicy = vi.fn();
const refreshApprovals = vi.fn(async () => {});

vi.mock("../src/app/connection", () => ({
	useConnectedSession: () => ({ client: { decideApproval, updateSessionApprovalPolicy } }),
}));
vi.mock("../src/app/workspace", () => ({
	useWorkspace: () => ({ refreshApprovals }),
}));

import { I18nProvider } from "../src/app/i18n";
import { ApprovalCard } from "../src/components/approval-card";

const RAW_COMMAND = "rm -rf / --secret-token=SUPERSECRET";

function bashApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		schemaVersion: 1,
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "00000000-0000-7000-8000-000000000001",
		runId: "00000000-0000-7000-8000-000000000002",
		actionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		toolCallId: "call-1",
		action: {
			tool: "bash",
			operation: "bash",
			target: { kind: "command", id: "cmd-1" },
			command: RAW_COMMAND,
			redactedParams: {},
		},
		risk: { tier: "high", overridable: true, reasons: [] },
		state: "pending",
		revision: 3,
		createdAt: "2025-01-01T00:00:00.000Z",
		expiresAt: "2025-01-01T00:05:00.000Z",
		...overrides,
	} as ApprovalRequest;
}

function renderCard(request: ApprovalRequest) {
	return render(
		<I18nProvider>
			<ApprovalCard request={request} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	decideApproval.mockReset();
	updateSessionApprovalPolicy.mockReset();
	refreshApprovals.mockClear();
});

describe("ApprovalCard security", () => {
	it("never renders a raw shell command, only the fixed redacted label", () => {
		renderCard(bashApproval());
		expect(screen.getByText("shell [arguments hidden]")).toBeInTheDocument();
		expect(screen.queryByText(/SUPERSECRET/)).toBeNull();
		expect(screen.queryByText(/rm -rf/)).toBeNull();
	});

	it("decides with the observed revision and a fresh idempotency key (CAS)", async () => {
		decideApproval.mockResolvedValue({ outcome: "applied", request: bashApproval({ state: "approved" }) });
		renderCard(bashApproval());
		await userEvent.click(screen.getByRole("button", { name: "Approve once" }));

		expect(decideApproval).toHaveBeenCalledTimes(1);
		const args = decideApproval.mock.calls[0]?.[0] as {
			approvalId: string;
			expectedRevision: number;
			decision: string;
			idempotencyKey: string;
		};
		expect(args.approvalId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		expect(args.expectedRevision).toBe(3);
		expect(args.decision).toBe("approve_once");
		expect(typeof args.idempotencyKey).toBe("string");
		expect(args.idempotencyKey.length).toBeGreaterThan(10);
		await waitFor(() => expect(refreshApprovals).toHaveBeenCalled());
	});

	it("shows the authoritative final state when another device already decided (superseded)", async () => {
		decideApproval.mockResolvedValue({
			outcome: "superseded",
			request: bashApproval({ state: "approved" }),
		});
		renderCard(bashApproval());
		await userEvent.click(screen.getByRole("button", { name: "Approve once" }));
		await waitFor(() =>
			expect(screen.getByText(/Another device already decided/)).toBeInTheDocument(),
		);
	});

	it("surfaces a conflict (no blind retry) when the revision is stale", async () => {
		decideApproval.mockRejectedValue(new Error("revision conflict"));
		renderCard(bashApproval());
		await userEvent.click(screen.getByRole("button", { name: "Reject" }));
		await waitFor(() => expect(screen.getByText(/This approval changed/)).toBeInTheDocument());
		expect(refreshApprovals).toHaveBeenCalled();
	});

	it("enables Session Allow-all via the policy update with its own revision", async () => {
		updateSessionApprovalPolicy.mockResolvedValue({});
		renderCard(bashApproval());
		await userEvent.click(screen.getByRole("button", { name: "Allow all for this session" }));
		expect(updateSessionApprovalPolicy).toHaveBeenCalledTimes(1);
		const args = updateSessionApprovalPolicy.mock.calls[0]?.[0] as {
			allowAll: boolean;
			expectedRevision: number;
			sessionId: string;
		};
		expect(args.allowAll).toBe(true);
		expect(args.expectedRevision).toBe(0);
		expect(args.sessionId).toBe("00000000-0000-7000-8000-000000000001");
	});
});
