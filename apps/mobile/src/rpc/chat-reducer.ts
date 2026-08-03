import type {
	AppError,
	ChatRunEvent,
	ChatRunPart,
	ChatRunSnapshot,
	ChatRunStatus,
} from "@moshu/contracts";

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
	runs: Map<string, ChatRunSnapshot>;
	messages: Map<string, ChatMessageView>;
	revision: number;
}

export function createChatConversationState(sessionId: string): ChatConversationState {
	return {
		sessionId,
		runs: new Map(),
		messages: new Map(),
		revision: 0,
	};
}

export function ingestSnapshotRuns(
	state: ChatConversationState,
	runs: readonly ChatRunSnapshot[],
): void {
	for (const run of runs) {
		state.runs.set(run.id, {
			...structuredClone(run),
			timeline: run.timeline
				.filter((part) => part.kind === "text")
				.map((part) => structuredClone(part)),
		});
	}
	rebuildMessages(state);
}

export function applyChatRunEvent(state: ChatConversationState, event: ChatRunEvent): boolean {
	const current = state.runs.get(event.runId);
	if (current === undefined || event.seq <= current.lastEventSeq) {
		return false;
	}
	state.runs.set(event.runId, reduceRun(current, event));
	rebuildMessages(state);
	return true;
}

export function selectChatMessages(state: ChatConversationState): ChatMessageView[] {
	return [...state.messages.values()].sort((left, right) => left.order - right.order);
}

const activeRunStatuses = new Set<ChatRunStatus>(["queued", "running", "cancelling"]);

export function isConversationResponding(state: ChatConversationState): boolean {
	return [...state.runs.values()].some((run) => activeRunStatuses.has(run.status));
}

export function isConversationStopping(state: ChatConversationState): boolean {
	return [...state.runs.values()].some((run) => run.status === "cancelling");
}

export function latestRunId(state: ChatConversationState): string | undefined {
	return [...state.runs.values()]
		.filter((run) => activeRunStatuses.has(run.status))
		.sort(compareRuns)
		.at(-1)?.id;
}

function reduceRun(run: ChatRunSnapshot, event: ChatRunEvent): ChatRunSnapshot {
	let next: ChatRunSnapshot = { ...run, lastEventSeq: event.seq };
	switch (event.type) {
		case "run.status":
			next = {
				...next,
				status: event.payload.status,
				updatedAt: event.createdAt,
				...(isTerminalRunStatus(event.payload.status) ? { completedAt: event.createdAt } : {}),
			};
			break;
		case "run.error":
			next = { ...next, lastError: event.payload.error, updatedAt: event.createdAt };
			break;
		case "timeline.part.created":
			if (event.payload.part.kind === "text") {
				next = { ...next, timeline: upsertPart(next.timeline, event.payload.part) };
			}
			break;
		case "timeline.text.delta":
			next = {
				...next,
				timeline: next.timeline.map((part) =>
					part.id === event.payload.partId && part.kind === "text"
						? {
								...part,
								content: `${part.content}${event.payload.delta}`,
								revision: event.payload.revision,
								updatedAt: event.createdAt,
							}
						: part,
				),
			};
			break;
		case "timeline.text.completed":
			next = { ...next, timeline: upsertPart(next.timeline, event.payload.part) };
			break;
		case "timeline.tool.updated":
		case "timeline.tool.progress":
			break;
		case "run.warning":
			break;
	}
	return next;
}

function rebuildMessages(state: ChatConversationState): void {
	const messages = new Map<string, ChatMessageView>();
	let order = 0;
	for (const run of [...state.runs.values()].sort(compareRuns)) {
		messages.set(run.userMessage.id, {
			id: run.userMessage.id,
			role: "user",
			status: "complete",
			content: run.userMessage.content,
			order: order++,
		});
		for (const part of [...run.timeline].sort((left, right) => left.position - right.position)) {
			if (part.kind !== "text") {
				continue;
			}
			messages.set(part.id, {
				id: part.id,
				role: "assistant",
				status: part.status === "streaming" ? "streaming" : "complete",
				content: part.content,
				order: order++,
			});
		}
		if (run.lastError !== undefined) {
			const id = `${run.id}:error`;
			messages.set(id, {
				id,
				role: "assistant",
				status: "failed",
				content: "",
				order: order++,
				error: run.lastError,
			});
		}
	}
	state.messages = messages;
	state.revision += 1;
}

function upsertPart(timeline: readonly ChatRunPart[], next: ChatRunPart): ChatRunPart[] {
	return [...timeline.filter((part) => part.id !== next.id), next].sort(
		(left, right) => left.position - right.position,
	);
}

function compareRuns(left: ChatRunSnapshot, right: ChatRunSnapshot): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isTerminalRunStatus(status: ChatRunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
