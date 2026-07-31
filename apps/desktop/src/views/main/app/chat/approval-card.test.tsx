import type {
	ApprovalRequest,
	DecideApprovalOutput,
	SessionApprovalPolicy,
} from "@moshu/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ApprovalCard } from "./approval-card";

const decide =
	vi.fn<(request: ApprovalRequest, decision: string) => Promise<DecideApprovalOutput>>();
const setAllowAll = vi.fn<(sessionId: string, allowAll: boolean) => Promise<void>>();

vi.mock("../approvals", () => ({
	useApprovals: () => ({
		pending: [],
		isLoading: false,
		errorMessage: undefined,
		approvalsForSession: () => [],
		policyForSession: () => undefined,
		refresh: () => Promise.resolve(),
		decide,
		setAllowAll,
	}),
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
			tool: "bash",
			operation: "bash",
			target: { kind: "runtime-box", id: "local" },
			command: "rm ./tmp/output.log",
			redactedParams: {},
		},
		risk: { tier: "high", overridable: true, reasons: ["Runs a shell command"] },
		state: "pending",
		revision: 1,
		createdAt: "2024-05-01T10:00:00.000Z",
		expiresAt: "2024-05-01T10:10:00.000Z",
		...overrides,
	};
}

function buildPolicy(overrides: Partial<SessionApprovalPolicy> = {}): SessionApprovalPolicy {
	return {
		schemaVersion: 1,
		sessionId,
		allowAll: false,
		revision: 0,
		updatedAt: "2024-05-01T09:59:00.000Z",
		...overrides,
	};
}

function renderCard(request: ApprovalRequest, policy: SessionApprovalPolicy | undefined) {
	return render(
		<I18nProvider>
			<ApprovalCard request={request} policy={policy} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
	decide.mockReset();
	setAllowAll.mockReset();
});

describe("ApprovalCard", () => {
	test("renders tool, command, risk reason, and actions", () => {
		renderCard(buildRequest(), buildPolicy());
		expect(screen.getByRole("heading", { name: "bash" })).toBeInTheDocument();
		expect(screen.getByText("rm ./tmp/output.log")).toBeInTheDocument();
		expect(screen.getByText("Runs a shell command")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Allow all for this Session" })).toBeInTheDocument();
	});

	test("approve once submits an approve_once decision", async () => {
		decide.mockResolvedValue({
			schemaVersion: 1,
			outcome: "applied",
			request: buildRequest({ state: "approved", revision: 2 }),
		});
		renderCard(buildRequest(), buildPolicy());
		fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
		await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
		expect(decide.mock.calls[0]?.[1]).toBe("approve_once");
	});

	test("reject submits a reject decision", async () => {
		decide.mockResolvedValue({
			schemaVersion: 1,
			outcome: "applied",
			request: buildRequest({ state: "rejected", revision: 2 }),
		});
		renderCard(buildRequest(), buildPolicy());
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
		expect(decide.mock.calls[0]?.[1]).toBe("reject");
	});

	test("superseded outcome surfaces a decided-elsewhere notice", async () => {
		decide.mockResolvedValue({
			schemaVersion: 1,
			outcome: "superseded",
			request: buildRequest({ state: "rejected", revision: 2 }),
		});
		renderCard(buildRequest(), buildPolicy());
		fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
		await waitFor(() =>
			expect(screen.getByText("Already decided on another device.")).toBeInTheDocument(),
		);
	});

	test("allow-all toggles the session policy", async () => {
		setAllowAll.mockResolvedValue();
		renderCard(buildRequest(), buildPolicy());
		fireEvent.click(screen.getByRole("button", { name: "Allow all for this Session" }));
		await waitFor(() => expect(setAllowAll).toHaveBeenCalledWith(sessionId, true));
	});

	test("critical actions hide allow-all and show a non-overridable badge", () => {
		renderCard(
			buildRequest({
				risk: { tier: "critical", overridable: false, reasons: ["Deletes files recursively"] },
			}),
			buildPolicy(),
		);
		expect(
			screen.queryByRole("button", { name: "Allow all for this Session" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Always needs explicit approval")).toBeInTheDocument();
	});
});
