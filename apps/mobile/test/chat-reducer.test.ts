import { describe, expect, it } from "vitest";
import {
	applyChatRunEvent,
	createChatConversationState,
	ingestSnapshotRuns,
	isConversationResponding,
	isConversationStopping,
	latestRunId,
	selectChatMessages,
} from "../src/rpc/chat-reducer";
import {
	makeRun,
	messageCompletedEvent,
	messageDeltaEvent,
	messageStartedEvent,
	runStatusEvent,
	v7,
} from "./helpers";

const SESSION = v7();

describe("chat reducer", () => {
	it("orders snapshot runs by creation order", () => {
		const state = createChatConversationState(SESSION);
		const a = v7();
		const b = v7();
		ingestSnapshotRuns(state, [
			makeRun(b, SESSION, "completed", "second"),
			makeRun(a, SESSION, "completed", "first"),
		]);
		const messages = selectChatMessages(state);
		expect(messages.map((m) => m.content)).toEqual(["first", "second"]);
	});

	it("accumulates deltas and finalizes on completion", () => {
		const state = createChatConversationState(SESSION);
		const runId = v7();
		const msgId = v7();
		ingestSnapshotRuns(state, [makeRun(runId, SESSION, "running")]);
		applyChatRunEvent(state, messageStartedEvent(runId, SESSION, 1, msgId));
		applyChatRunEvent(state, messageDeltaEvent(runId, SESSION, 2, msgId, "Hel"));
		applyChatRunEvent(state, messageDeltaEvent(runId, SESSION, 3, msgId, "lo"));
		const streaming = selectChatMessages(state).find((message) => message.role === "assistant");
		expect(streaming?.content).toBe("Hello");
		expect(streaming?.status).toBe("streaming");
		applyChatRunEvent(state, messageCompletedEvent(runId, SESSION, 4, msgId, "Hello!"));
		const completed = selectChatMessages(state).find((message) => message.role === "assistant");
		expect(completed?.content).toBe("Hello!");
		expect(completed?.status).toBe("complete");
	});

	it("derives responding/stopping/latestRun from run status", () => {
		const state = createChatConversationState(SESSION);
		const runId = v7();
		ingestSnapshotRuns(state, [makeRun(runId, SESSION, "running")]);
		expect(isConversationResponding(state)).toBe(true);
		expect(isConversationStopping(state)).toBe(false);
		expect(latestRunId(state)).toBe(runId);

		applyChatRunEvent(state, runStatusEvent(runId, SESSION, 5, "cancelling"));
		expect(isConversationStopping(state)).toBe(true);

		applyChatRunEvent(state, runStatusEvent(runId, SESSION, 6, "completed"));
		expect(isConversationResponding(state)).toBe(false);
		expect(latestRunId(state)).toBeUndefined();
	});

	it("drops Tool payloads while still advancing their durable event cursor", () => {
		const state = createChatConversationState(SESSION);
		const runId = v7();
		const toolPart = {
			schemaVersion: 1 as const,
			id: v7(),
			runId,
			position: 1,
			assistantTurnId: v7(),
			revision: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			kind: "tool" as const,
			toolCallId: "call",
			tool: { kind: "builtin" as const, name: "bash" as const },
			status: "completed" as const,
			summary: "Run command",
			output: {
				format: "json" as const,
				value: { secret: "large tool payload" },
				truncated: false,
				redactionCount: 0,
			},
		};
		const run = makeRun(runId, SESSION, "running");
		ingestSnapshotRuns(state, [{ ...run, timeline: [toolPart] }]);
		expect(state.runs.get(runId)?.timeline).toEqual([]);

		expect(
			applyChatRunEvent(state, {
				schemaVersion: 1,
				id: v7(),
				runId,
				sessionId: SESSION,
				seq: 1,
				type: "timeline.tool.updated",
				source: { kind: "assistant" },
				visibility: "user",
				createdAt: "2026-01-01T00:00:01.000Z",
				payload: { part: { ...toolPart, revision: 2 } },
			}),
		).toBe(true);
		expect(state.runs.get(runId)?.lastEventSeq).toBe(1);
		expect(JSON.stringify(state.runs.get(runId)?.timeline)).not.toContain("large tool payload");
	});
});
