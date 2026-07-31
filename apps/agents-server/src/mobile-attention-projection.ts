import type { ApprovalRequest, ChatRunEvent } from "@moshu/contracts";
import type { AppendMobileAttentionInput } from "@moshu/database";

// Localization keys are static, generic strings resolved on the device. They never embed business
// content, so they are safe to render on a lock screen. The Agent Server only ever stores these keys
// plus opaque ids in the durable attention feed.
const attentionCopy = {
	approval_required: {
		titleKey: "attention.approvalRequired.title",
		bodyKey: "attention.approvalRequired.body",
	},
	run_completed: {
		titleKey: "attention.runCompleted.title",
		bodyKey: "attention.runCompleted.body",
	},
	run_failed: {
		titleKey: "attention.runFailed.title",
		bodyKey: "attention.runFailed.body",
	},
	run_cancelled: {
		titleKey: "attention.runCancelled.title",
		bodyKey: "attention.runCancelled.body",
	},
} as const;

// Map a newly-pending approval to a desensitized attention append. Only a pending approval is
// actionable on the phone; any other state (already decided/expired) produces nothing. The dedupe key
// is the stable approval id so the same approval can never append twice, even across a restart.
export function projectApprovalAttention(event: {
	type: string;
	request: ApprovalRequest;
}): AppendMobileAttentionInput | undefined {
	if (event.type !== "approval.created" || event.request.state !== "pending") {
		return undefined;
	}
	const copy = attentionCopy.approval_required;
	return {
		type: "approval_required",
		dedupeKey: `approval:${event.request.id}`,
		sessionId: event.request.sessionId,
		runId: event.request.runId,
		approvalId: event.request.id,
		titleKey: copy.titleKey,
		bodyKey: copy.bodyKey,
	};
}

// Map a Run reaching a terminal status to a desensitized attention append. A Run has exactly one
// terminal transition, and the dedupe key is the Run id (not the status) so a duplicate terminal
// delivery is idempotent. Non-terminal status transitions produce nothing.
export function projectRunTerminalAttention(
	event: ChatRunEvent,
): AppendMobileAttentionInput | undefined {
	if (event.type !== "run.status") {
		return undefined;
	}
	const status = event.payload.status;
	const type =
		status === "completed"
			? "run_completed"
			: status === "failed"
				? "run_failed"
				: status === "cancelled"
					? "run_cancelled"
					: undefined;
	if (type === undefined) {
		return undefined;
	}
	const copy = attentionCopy[type];
	return {
		type,
		dedupeKey: `run:${event.runId}`,
		sessionId: event.sessionId,
		runId: event.runId,
		titleKey: copy.titleKey,
		bodyKey: copy.bodyKey,
	};
}
