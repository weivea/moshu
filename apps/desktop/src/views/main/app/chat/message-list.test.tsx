import type { ApprovalRequest, ChatRunSnapshot, ChatRunToolPart } from "@moshu/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { MessageList } from "./message-list";

const approvalState = vi.hoisted(() => ({
	requests: [] as ApprovalRequest[],
	ensureApproval: vi.fn<(approvalId: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../approvals", () => ({
	useApprovals: () => ({
		pending: approvalState.requests,
		isLoading: false,
		errorMessage: undefined,
		approvalsForSession: () => approvalState.requests,
		policyForSession: () => undefined,
		refresh: () => Promise.resolve(),
		ensureApproval: approvalState.ensureApproval,
		decide: () => Promise.reject(new Error("Not used in this test.")),
		setAllowAll: () => Promise.reject(new Error("Not used in this test.")),
	}),
}));

const sessionId = "018f2c60-0000-7000-8000-000000000001";
const runId = "018f2c60-0000-7000-8000-000000000002";
const approvalId = "018f2c60-0000-7000-8000-000000000006";
const timestamp = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
	approvalState.requests = [];
	approvalState.ensureApproval.mockClear();
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("MessageList", () => {
	test("renders one pending approval inside its matching ToolCard", () => {
		approvalState.requests = [buildApproval()];
		renderMessageList([buildRun([buildToolPart()])]);

		const approval = screen.getByLabelText("Approval required");
		expect(approval).toHaveClass("approval-card--embedded");
		expect(approval.closest(".chat-tool-card")).not.toBeNull();
		expect(approval.closest("details")).toHaveAttribute("open");
		expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
		expect(screen.getAllByLabelText("Approval required")).toHaveLength(1);
	});

	test("fetches a missing ApprovalRequest for a waiting ToolCard", () => {
		const rendered = renderMessageList([buildRun([buildToolPart()])]);
		const card = rendered.container.querySelector<HTMLDetailsElement>(".chat-tool-card");

		expect(card).toHaveAttribute("open");
		expect(screen.getByText("Loading approval actions…")).toBeInTheDocument();
		expect(approvalState.ensureApproval).toHaveBeenCalledWith(approvalId);
	});

	test("keeps completed Tool calls compact until the user expands them", () => {
		const rendered = renderMessageList([
			buildRun([
				buildToolPart({
					status: "completed",
					approvalId: undefined,
					input: {
						format: "json",
						value: { command: "echo hello" },
						truncated: false,
						redactionCount: 0,
					},
					output: {
						format: "text",
						value: "hello",
						truncated: false,
						redactionCount: 0,
					},
				}),
			]),
		]);
		const card = rendered.container.querySelector<HTMLDetailsElement>(".chat-tool-card");
		const summary = card?.querySelector<HTMLElement>("summary");
		if (card === null || summary === null || summary === undefined) {
			throw new Error("Expected a compact Tool card.");
		}

		expect(card).not.toHaveAttribute("open");
		expect(summary.querySelector(".chat-tool-card__chevron")).not.toBeNull();

		fireEvent.click(summary);
		expect(card).toHaveAttribute("open");

		fireEvent.click(summary);
		expect(card).not.toHaveAttribute("open");
	});

	test("does not force auto-follow after the user scrolls away from the bottom", () => {
		const initialRun = buildRun([]);
		const rendered = renderMessageList([initialRun]);
		const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		const transcript = rendered.container.querySelector<HTMLElement>(".chat-transcript");
		if (transcript === null) {
			throw new Error("Expected the transcript container.");
		}
		Object.defineProperties(transcript, {
			scrollHeight: { configurable: true, value: 1_000 },
			clientHeight: { configurable: true, value: 200 },
			scrollTop: { configurable: true, writable: true, value: 100 },
		});
		fireEvent.scroll(transcript);
		rendered.rerender(
			<I18nProvider>
				<MessageList isLoading={false} runs={[buildRun([buildToolPart()])]} sessionId={sessionId} />
			</I18nProvider>,
		);

		expect(scrollIntoView).toHaveBeenCalledTimes(1);
	});
});

function renderMessageList(runs: ChatRunSnapshot[]) {
	return render(
		<I18nProvider>
			<MessageList isLoading={false} runs={runs} sessionId={sessionId} />
		</I18nProvider>,
	);
}

function buildRun(timeline: ChatRunSnapshot["timeline"]): ChatRunSnapshot {
	return {
		schemaVersion: 1,
		id: runId,
		sessionId,
		runtimeBoxId: "local",
		mode: "agent",
		status: "running",
		provider: {
			schemaVersion: 1,
			providerId: "018f2c60-0000-7000-8000-000000000007",
			name: "Test Provider",
			source: "custom",
			api: "openai-responses",
			model: "deterministic",
			status: "ready",
		},
		userMessageId: "018f2c60-0000-7000-8000-000000000003",
		createdAt: timestamp,
		updatedAt: timestamp,
		userMessage: {
			schemaVersion: 1,
			id: "018f2c60-0000-7000-8000-000000000003",
			sessionId,
			runId,
			role: "user",
			content: "Run the command.",
			createdAt: timestamp,
		},
		timeline,
		lastEventSeq: timeline.length,
	};
}

function buildToolPart(overrides: Partial<ChatRunToolPart> = {}): ChatRunToolPart {
	return {
		schemaVersion: 1,
		id: "018f2c60-0000-7000-8000-000000000005",
		runId,
		position: 1,
		assistantTurnId: "018f2c60-0000-7000-8000-000000000004",
		revision: 2,
		kind: "tool",
		toolCallId: "call-1",
		tool: { kind: "builtin", name: "bash" },
		status: "waiting_approval",
		summary: "Run command",
		approvalId,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}

function buildApproval(): ApprovalRequest {
	return {
		schemaVersion: 1,
		id: approvalId,
		sessionId,
		runId,
		actionId: "018f2c60-0000-7000-8000-000000000008",
		toolCallId: "call-1",
		action: {
			tool: "bash",
			operation: "bash",
			target: { kind: "runtime-box", id: "local" },
			command: "echo hello",
			redactedParams: {},
		},
		risk: {
			tier: "high",
			overridable: false,
			reasons: ["Runs a shell command"],
		},
		state: "pending",
		revision: 1,
		createdAt: timestamp,
		expiresAt: "2026-01-01T00:10:00.000Z",
	};
}
