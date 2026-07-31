import type { AppError, ChatMessage, ChatRun, ChatRunEvent, ChatRunStatus } from "@moshu/contracts";

/**
 * Browser-safe projection of chat run events onto an in-memory conversation. It intentionally does
 * NOT reuse the strict contract message schemas for the streaming projection (those require fields
 * an event stream doesn't carry mid-stream); instead it keeps a lightweight view keyed by message
 * id with a stable display order. All of this lives only in memory for the life of a connection —
 * nothing here is persisted.
 */

export type ChatMessageViewStatus = "streaming" | "complete" | "failed" | "cancelled";

export interface ChatMessageView {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly status: ChatMessageViewStatus;
	readonly content: string;
	readonly order: number;
	readonly error?: AppError;
}

export interface ChatConversationState {
	readonly sessionId: string;
	order: Map<string, number>;
	messages: Map<string, ChatMessageView>;
	runStatus: Map<string, ChatRunStatus>;
	nextOrder: number;
	revision: number;
}

export function createChatConversationState(sessionId: string): ChatConversationState {
	return {
		sessionId,
		order: new Map(),
		messages: new Map(),
		runStatus: new Map(),
		nextOrder: 0,
		revision: 0,
	};
}

function assignOrder(state: ChatConversationState, id: string): number {
	const existing = state.order.get(id);
	if (existing !== undefined) {
		return existing;
	}
	const next = state.nextOrder;
	state.nextOrder += 1;
	state.order.set(id, next);
	return next;
}

function upsert(state: ChatConversationState, view: ChatMessageView): void {
	state.messages.set(view.id, view);
	state.revision += 1;
}

/** Seeds the conversation from a session-page snapshot (already validated by the product client). */
export function ingestSnapshotMessages(
	state: ChatConversationState,
	messages: readonly ChatMessage[],
): void {
	const sorted = [...messages].sort((left, right) => left.sequence - right.sequence);
	for (const message of sorted) {
		const order = assignOrder(state, message.id);
		const status: ChatMessageViewStatus = message.status;
		upsert(state, {
			id: message.id,
			role: message.role,
			status,
			content: message.content,
			order,
			...("error" in message && message.error ? { error: message.error } : {}),
		});
	}
}

export function ingestSnapshotRuns(
	state: ChatConversationState,
	runs: readonly ChatRun[],
): void {
	for (const run of runs) {
		state.runStatus.set(run.id, run.status);
	}
	state.revision += 1;
}

/**
 * Applies one chat run event. Returns true when it changed the conversation. Callers are
 * responsible for per-run sequence dedupe (see the recovery drain); this function assumes the event
 * is in-order for its run.
 */
export function applyChatRunEvent(state: ChatConversationState, event: ChatRunEvent): boolean {
	switch (event.type) {
		case "run.status": {
			state.runStatus.set(event.runId, event.payload.status);
			state.revision += 1;
			return true;
		}
		case "message.started": {
			const id = event.payload.messageId;
			if (state.messages.has(id)) {
				return false;
			}
			const order = assignOrder(state, id);
			upsert(state, { id, role: "assistant", status: "streaming", content: "", order });
			return true;
		}
		case "message.delta": {
			const id = event.payload.messageId;
			const current = state.messages.get(id);
			const order = current?.order ?? assignOrder(state, id);
			upsert(state, {
				id,
				role: "assistant",
				status: "streaming",
				content: (current?.content ?? "") + event.payload.delta,
				order,
			});
			return true;
		}
		case "message.completed": {
			const id = event.payload.messageId;
			const current = state.messages.get(id);
			const order = current?.order ?? assignOrder(state, id);
			upsert(state, {
				id,
				role: "assistant",
				status: event.payload.status,
				content: event.payload.content,
				order,
				...(event.payload.status === "failed" ? { error: event.payload.error } : {}),
			});
			return true;
		}
		case "run.error": {
			state.runStatus.set(event.runId, "failed");
			state.revision += 1;
			return true;
		}
		case "run.warning": {
			return false;
		}
		default: {
			return false;
		}
	}
}

export function selectChatMessages(state: ChatConversationState): ChatMessageView[] {
	return [...state.messages.values()].sort((left, right) => left.order - right.order);
}

const activeRunStatuses = new Set<ChatRunStatus>(["queued", "running", "cancelling"]);

export function isConversationResponding(state: ChatConversationState): boolean {
	for (const status of state.runStatus.values()) {
		if (activeRunStatuses.has(status)) {
			return true;
		}
	}
	return false;
}

export function isConversationStopping(state: ChatConversationState): boolean {
	for (const status of state.runStatus.values()) {
		if (status === "cancelling") {
			return true;
		}
	}
	return false;
}

export function latestRunId(state: ChatConversationState): string | undefined {
	let latest: string | undefined;
	for (const [runId, status] of state.runStatus) {
		if (activeRunStatuses.has(status)) {
			latest = runId;
		}
	}
	return latest;
}
