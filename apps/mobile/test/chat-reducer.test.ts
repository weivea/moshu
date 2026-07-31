import { describe, expect, it } from "vitest";
import {
	applyChatRunEvent,
	createChatConversationState,
	ingestSnapshotMessages,
	ingestSnapshotRuns,
	isConversationResponding,
	isConversationStopping,
	latestRunId,
	selectChatMessages,
} from "../src/rpc/chat-reducer";
import {
	makeAssistantMessage,
	makeRun,
	makeUserMessage,
	messageCompletedEvent,
	messageDeltaEvent,
	messageStartedEvent,
	runStatusEvent,
	v7,
} from "./helpers";

const SESSION = v7();

describe("chat reducer", () => {
	it("orders snapshot messages by sequence", () => {
		const state = createChatConversationState(SESSION);
		const a = v7();
		const b = v7();
		ingestSnapshotMessages(state, [
			makeAssistantMessage(b, SESSION, 2, "second"),
			makeUserMessage(a, SESSION, 1, "first"),
		]);
		const messages = selectChatMessages(state);
		expect(messages.map((m) => m.content)).toEqual(["first", "second"]);
	});

	it("accumulates deltas and finalizes on completion", () => {
		const state = createChatConversationState(SESSION);
		const runId = v7();
		const msgId = v7();
		applyChatRunEvent(state, messageStartedEvent(runId, SESSION, 1, msgId));
		applyChatRunEvent(state, messageDeltaEvent(runId, SESSION, 2, msgId, "Hel"));
		applyChatRunEvent(state, messageDeltaEvent(runId, SESSION, 3, msgId, "lo"));
		expect(selectChatMessages(state)[0]?.content).toBe("Hello");
		expect(selectChatMessages(state)[0]?.status).toBe("streaming");
		applyChatRunEvent(state, messageCompletedEvent(runId, SESSION, 4, msgId, "Hello!"));
		expect(selectChatMessages(state)[0]?.content).toBe("Hello!");
		expect(selectChatMessages(state)[0]?.status).toBe("complete");
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
});
