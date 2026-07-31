import type { AppendMobileAttentionInput } from "./mobile-attention-repository";

// Localization keys are static, generic strings resolved on the device. They never embed business
// content, so they are safe to render on a lock screen. The Agent Server only ever stores these keys
// (plus opaque ids) in the durable attention feed and its transactional outbox. This map is the single
// source of truth shared by the outbox producers (approval / Run repositories) and the feed projection.
export const mobileAttentionCopy = {
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

// Build the desensitized outbox payload for a newly-pending approval. The dedupe key is the stable
// approval id, so the same approval can never enqueue twice (transactional idempotency) even across a
// restart or a duplicated event.
export function buildApprovalPendingAttentionInput(input: {
	approvalId: string;
	sessionId: string;
	runId?: string | undefined;
	createdAtMs?: number | undefined;
}): AppendMobileAttentionInput {
	const copy = mobileAttentionCopy.approval_required;
	return {
		type: "approval_required",
		dedupeKey: `approval:${input.approvalId}`,
		sessionId: input.sessionId,
		...(input.runId === undefined ? {} : { runId: input.runId }),
		approvalId: input.approvalId,
		titleKey: copy.titleKey,
		bodyKey: copy.bodyKey,
		...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
	};
}

// Build the desensitized outbox payload for a Run reaching a terminal status. A Run has exactly one
// terminal transition and the dedupe key is the Run id (not the status), so a duplicate terminal
// delivery is idempotent. Non-terminal statuses produce nothing.
export function buildRunTerminalAttentionInput(input: {
	status: string;
	runId: string;
	sessionId: string;
	createdAtMs?: number | undefined;
}): AppendMobileAttentionInput | undefined {
	const type =
		input.status === "completed"
			? "run_completed"
			: input.status === "failed"
				? "run_failed"
				: input.status === "cancelled"
					? "run_cancelled"
					: undefined;
	if (type === undefined) {
		return undefined;
	}
	const copy = mobileAttentionCopy[type];
	return {
		type,
		dedupeKey: `run:${input.runId}`,
		sessionId: input.sessionId,
		runId: input.runId,
		titleKey: copy.titleKey,
		bodyKey: copy.bodyKey,
		...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
	};
}
