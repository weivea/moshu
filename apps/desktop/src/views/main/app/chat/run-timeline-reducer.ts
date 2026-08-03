import type { ChatRunEvent, ChatRunPart, ChatRunSnapshot } from "@moshu/contracts";

export function applyChatRunEvent(run: ChatRunSnapshot, event: ChatRunEvent): ChatRunSnapshot {
	if (run.id !== event.runId || event.seq <= run.lastEventSeq) {
		return run;
	}

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
			next = {
				...next,
				timeline: upsertPart(next.timeline, event.payload.part),
			};
			break;
		case "timeline.text.delta":
			next = {
				...next,
				timeline: next.timeline.map((part) => {
					if (part.id !== event.payload.partId) {
						return part;
					}
					if (part.kind !== "text") {
						throw new Error(`Text delta targeted non-text Part ${part.id}.`);
					}
					assertNextRevision(part, event.payload.revision);
					return {
						...part,
						content: `${part.content}${event.payload.delta}`,
						revision: event.payload.revision,
						updatedAt: event.createdAt,
					};
				}),
			};
			break;
		case "timeline.text.completed":
			next = { ...next, timeline: replacePart(next.timeline, event.payload.part) };
			break;
		case "timeline.tool.updated":
			next = { ...next, timeline: replacePart(next.timeline, event.payload.part) };
			break;
		case "timeline.tool.progress":
			next = {
				...next,
				timeline: next.timeline.map((part) => {
					if (part.id !== event.payload.partId) {
						return part;
					}
					if (part.kind !== "tool") {
						throw new Error(`Tool progress targeted non-tool Part ${part.id}.`);
					}
					assertNextRevision(part, event.payload.revision);
					return {
						...part,
						progress: event.payload.progress,
						payloadsTruncated: event.payload.payloadsTruncated,
						revision: event.payload.revision,
						updatedAt: event.createdAt,
					};
				}),
			};
			break;
		case "run.warning":
			break;
	}
	return next;
}

export function mergeChatRunSnapshot(
	current: readonly ChatRunSnapshot[],
	accepted: ChatRunSnapshot,
): ChatRunSnapshot[] {
	const existing = current.find((run) => run.id === accepted.id);
	const run =
		existing === undefined || accepted.lastEventSeq >= existing.lastEventSeq ? accepted : existing;
	return [...current.filter((candidate) => candidate.id !== accepted.id), run].sort(compareRuns);
}

function upsertPart(timeline: readonly ChatRunPart[], next: ChatRunPart): ChatRunPart[] {
	const current = timeline.find((part) => part.id === next.id);
	if (current !== undefined && current.revision >= next.revision) {
		return [...timeline];
	}
	return [...timeline.filter((part) => part.id !== next.id), next].sort(
		(left, right) => left.position - right.position,
	);
}

function replacePart(timeline: readonly ChatRunPart[], next: ChatRunPart): ChatRunPart[] {
	const current = timeline.find((part) => part.id === next.id);
	if (current === undefined) {
		throw new Error(`Timeline update targeted unknown Part ${next.id}.`);
	}
	assertNextRevision(current, next.revision);
	return timeline.map((part) => (part.id === next.id ? next : part));
}

function assertNextRevision(current: ChatRunPart, revision: number): void {
	if (revision !== current.revision + 1) {
		throw new Error(
			`Timeline Part ${current.id} revision jumped from ${current.revision} to ${revision}.`,
		);
	}
}

function compareRuns(left: ChatRunSnapshot, right: ChatRunSnapshot): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isTerminalRunStatus(status: ChatRunSnapshot["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
