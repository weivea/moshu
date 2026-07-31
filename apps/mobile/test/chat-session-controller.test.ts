import type { ChatEventDelivery } from "@moshu/contracts";
import { describe, expect, it } from "vitest";
import { ChatSessionController } from "../src/rpc/chat-session-controller";
import { MobileEventBus } from "../src/rpc/events";
import {
	makeAssistantMessage,
	makeFakeChatClient,
	makeRun,
	makeSessionPage,
	messageCompletedEvent,
	messageDeltaEvent,
	v7,
} from "./helpers";

function emitChat(bus: MobileEventBus, event: unknown): void {
	bus.emit("chatEvent", { event } as ChatEventDelivery);
}

describe("ChatSessionController recovery drain", () => {
	it("subscribes before snapshotting, fills gaps via replay, dedupes, then flips ready", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const snapshot = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "AB", "streaming")],
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 2 }],
		});
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot,
			// The live event jumps to seq 5; replay must supply the missing seq 3 and 4.
			replay: (id, lastSeq) => {
				expect(lastSeq).toBe(2);
				return [
					messageDeltaEvent(id, sessionId, 3, msgId, "C"),
					messageDeltaEvent(id, sessionId, 4, msgId, "D"),
				];
			},
		});

		const bus = new MobileEventBus();
		let changes = 0;
		const controller = new ChatSessionController({
			client,
			bus,
			sessionId,
			onChange: () => {
				changes += 1;
			},
		});

		// Kick off start(); its synchronous prefix registers the bus listener before any await, so the
		// events we emit now land in the provisional buffer (ready === false).
		const started = controller.start();
		emitChat(bus, messageCompletedEvent(runId, sessionId, 5, msgId, "ABCDE"));
		// A stale duplicate at/under the snapshot cursor must be dropped, not applied twice.
		emitChat(bus, messageDeltaEvent(runId, sessionId, 2, msgId, "XX"));
		await started;

		expect(script.subscribes).toEqual([sessionId]);
		expect(script.replayCalls).toEqual([{ runId, lastSeq: 2 }]);

		const view = controller.getView();
		expect(view.phase).toBe("ready");
		expect(view.messages).toHaveLength(1);
		expect(view.messages[0]?.content).toBe("ABCDE");
		expect(view.messages[0]?.status).toBe("complete");
		expect(changes).toBeGreaterThan(0);
	});

	it("applies live events directly once ready", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const snapshot = makeSessionPage(sessionId, {
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 0 }],
		});
		const { client } = makeFakeChatClient({ sessionId, snapshot });
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		emitChat(bus, messageDeltaEvent(runId, sessionId, 1, msgId, "live"));
		expect(controller.getView().messages[0]?.content).toBe("live");
	});

	it("forwards the caller requestId for idempotent sends and unsubscribes on dispose", async () => {
		const sessionId = v7();
		const snapshot = makeSessionPage(sessionId);
		const { client, script } = makeFakeChatClient({ sessionId, snapshot });
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		await controller.send("hello there", "req-123");
		expect(script.sendCalls).toEqual([{ requestId: "req-123", content: "hello there" }]);
		// The user message is seeded immediately without waiting for an event.
		expect(controller.getView().messages.some((m) => m.role === "user")).toBe(true);

		await controller.dispose();
		expect(script.unsubscribes).toEqual([sessionId]);
	});

	it("cancels the latest active run", async () => {
		const sessionId = v7();
		const runId = v7();
		const snapshot = makeSessionPage(sessionId, {
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 0 }],
		});
		const { client, script } = makeFakeChatClient({ sessionId, snapshot });
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();
		await controller.cancel();
		expect(script.cancelCalls).toEqual([{ runId }]);
	});
});
