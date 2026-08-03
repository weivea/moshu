import type { ChatEventDelivery } from "@moshu/contracts";
import { RpcRemoteError } from "@moshu/process-rpc-core";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionController } from "../src/rpc/chat-session-controller";
import { MobileEventBus } from "../src/rpc/events";
import {
	makeAssistantMessage,
	makeFakeChatClient,
	makePagedSnapshot,
	makeRun,
	makeSessionPage,
	messageCompletedEvent,
	messageDeltaEvent,
	messageStartedEvent,
	v7,
} from "./helpers";

function remoteError(code: string): RpcRemoteError {
	return new RpcRemoteError("req", { code, message: `${code} rejected` });
}

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
		const assistant = view.messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toBe("ABCDE");
		expect(assistant?.status).toBe("complete");
		expect(changes).toBeGreaterThan(0);
	});

	it("resnapshots instead of applying a live event when gap replay fails", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const initial = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "AB", "streaming")],
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 2 }],
		});
		const recovered = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "ABCDE", "complete")],
			runs: [makeRun(runId, sessionId, "completed")],
			eventCursors: [{ runId, lastSeq: 5 }],
		});
		let snapshotReads = 0;
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot: initial,
			getPage: () => {
				snapshotReads += 1;
				return snapshotReads === 1 ? initial : recovered;
			},
			replay: () => {
				throw new Error("Replay unavailable.");
			},
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });

		const started = controller.start();
		emitChat(bus, messageCompletedEvent(runId, sessionId, 5, msgId, "ABCDE"));
		await started;

		expect(script.replayCalls).toEqual([{ runId, lastSeq: 2 }]);
		expect(snapshotReads).toBe(2);
		expect(controller.getView().phase).toBe("ready");
		expect(
			controller.getView().messages.find((message) => message.role === "assistant")?.content,
		).toBe("ABCDE");
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

		emitChat(bus, messageStartedEvent(runId, sessionId, 1, msgId));
		emitChat(bus, messageDeltaEvent(runId, sessionId, 2, msgId, "live"));
		expect(
			controller.getView().messages.find((message) => message.role === "assistant")?.content,
		).toBe("live");
	});

	it("resnapshots before applying an event for a Run created by another client", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const initial = makeSessionPage(sessionId);
		const recovered = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "A", "streaming")],
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 1 }],
		});
		let reads = 0;
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot: initial,
			getPage: () => {
				reads += 1;
				return reads === 1 ? initial : recovered;
			},
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		emitChat(bus, messageDeltaEvent(runId, sessionId, 2, msgId, "B"));
		await vi.waitFor(() => {
			expect(
				controller.getView().messages.find((message) => message.role === "assistant")?.content,
			).toBe("AB");
		});
		expect(script.replayCalls).toEqual([]);
		expect(reads).toBe(2);
	});

	it("follows replay pagination until the live event gap is fully recovered", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const snapshot = makeSessionPage(sessionId, {
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 0 }],
		});
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot,
			replay: (_id, lastSeq) =>
				lastSeq === 0
					? {
							events: [
								messageStartedEvent(runId, sessionId, 1, msgId),
								messageDeltaEvent(runId, sessionId, 2, msgId, "A"),
							],
							hasMore: true,
						}
					: {
							events: [messageDeltaEvent(runId, sessionId, 3, msgId, "B")],
							hasMore: false,
						},
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		emitChat(bus, messageCompletedEvent(runId, sessionId, 4, msgId, "ABC"));
		await vi.waitFor(() => {
			expect(
				controller.getView().messages.find((message) => message.role === "assistant")?.content,
			).toBe("ABC");
		});
		expect(script.replayCalls).toEqual([
			{ runId, lastSeq: 0 },
			{ runId, lastSeq: 2 },
		]);
	});

	it("obeys a replay resnapshot instruction instead of applying an incomplete page", async () => {
		const sessionId = v7();
		const runId = v7();
		const msgId = v7();
		const initial = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "A", "streaming")],
			runs: [makeRun(runId, sessionId, "running")],
			eventCursors: [{ runId, lastSeq: 1 }],
		});
		const recovered = makeSessionPage(sessionId, {
			messages: [makeAssistantMessage(msgId, sessionId, 1, "ABC", "complete")],
			runs: [makeRun(runId, sessionId, "completed")],
			eventCursors: [{ runId, lastSeq: 3 }],
		});
		let reads = 0;
		const { client } = makeFakeChatClient({
			sessionId,
			snapshot: initial,
			getPage: () => {
				reads += 1;
				return reads === 1 ? initial : recovered;
			},
			replay: () => ({ resnapshotSessionIds: [sessionId] }),
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		emitChat(bus, messageCompletedEvent(runId, sessionId, 3, msgId, "ABC"));
		await vi.waitFor(() => {
			expect(
				controller.getView().messages.find((message) => message.role === "assistant")?.content,
			).toBe("ABC");
		});
		expect(reads).toBe(2);
	});

	it("owns a generated requestId for idempotent sends and unsubscribes on dispose", async () => {
		const sessionId = v7();
		const snapshot = makeSessionPage(sessionId);
		const { client, script } = makeFakeChatClient({ sessionId, snapshot });
		const bus = new MobileEventBus();
		let seq = 0;
		const controller = new ChatSessionController({
			client,
			bus,
			sessionId,
			onChange: () => {},
			generateRequestId: () => `req-${++seq}`,
		});
		await controller.start();

		await controller.send("hello there");
		expect(script.sendCalls).toEqual([{ requestId: "req-1", content: "hello there" }]);
		// The user message is seeded immediately without waiting for an event.
		expect(controller.getView().messages.some((m) => m.role === "user")).toBe(true);
		// A definitive success releases the reservation, so the next distinct send uses a fresh id.
		expect(controller.hasPendingSend()).toBe(false);

		await controller.dispose();
		expect(script.unsubscribes).toEqual([sessionId]);
	});

	it("does not replace live-advanced content with a stale send acknowledgement", async () => {
		const sessionId = v7();
		const runId = v7();
		const messageId = v7();
		const acceptedRun = makeRun(runId, sessionId, "running", "hello");
		const snapshot = makeSessionPage(sessionId, {
			runs: [acceptedRun],
			eventCursors: [{ runId, lastSeq: 0 }],
		});
		let acceptSend: ((result: { run: typeof acceptedRun }) => void) | undefined;
		const sendResult = new Promise<{ run: typeof acceptedRun }>((resolve) => {
			acceptSend = resolve;
		});
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot,
			send: () => sendResult,
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		const sending = controller.send("hello");
		await vi.waitFor(() => expect(script.sendCalls).toHaveLength(1));
		emitChat(bus, messageStartedEvent(runId, sessionId, 1, messageId));
		emitChat(bus, messageDeltaEvent(runId, sessionId, 2, messageId, "live"));
		acceptSend?.({ run: acceptedRun });
		await sending;

		emitChat(bus, messageDeltaEvent(runId, sessionId, 3, messageId, "!"));
		expect(
			controller.getView().messages.find((message) => message.role === "assistant")?.content,
		).toBe("live!");
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

describe("ChatSessionController history pagination (f6)", () => {
	it("drains every page so more than 2 runs — including the active run on the last page — load", async () => {
		const sessionId = v7();
		// Layer 3 caps a page at 2 runs and orders oldest→newest, so the active run is on the LAST
		// page. Three pages here would be invisible if the controller only fetched the first page.
		const oldRun1 = v7();
		const oldRun2 = v7();
		const oldRun3 = v7();
		const activeRun = v7();
		const msgOld = v7();
		const msgActive = v7();
		const getPage = makePagedSnapshot(sessionId, [
			{
				runs: [makeRun(oldRun1, sessionId, "completed"), makeRun(oldRun2, sessionId, "completed")],
				messages: [makeAssistantMessage(msgOld, sessionId, 1, "oldest", "complete")],
				eventCursors: [{ runId: oldRun1, lastSeq: 3 }],
			},
			{
				runs: [makeRun(oldRun3, sessionId, "completed"), makeRun(activeRun, sessionId, "running")],
				messages: [makeAssistantMessage(msgActive, sessionId, 2, "live", "streaming")],
				eventCursors: [{ runId: activeRun, lastSeq: 5 }],
			},
		]);
		const { client, script } = makeFakeChatClient({
			sessionId,
			snapshot: makeSessionPage(sessionId),
			getPage,
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		const view = controller.getView();
		expect(view.phase).toBe("ready");
		// It followed nextCursor: first page with no cursor, then "p1".
		expect(script.pageCalls).toEqual([undefined, "p1"]);
		// The active run is present (responding true only if the streaming run was ingested).
		expect(view.responding).toBe(true);
		expect(view.messages.map((m) => m.content)).toContain("live");
	});

	it("fails closed when the pagination cursor does not advance (loops)", async () => {
		const sessionId = v7();
		const runId = v7();
		// A broken server that always echoes the same nextCursor must not loop forever.
		const getPage = (): ReturnType<typeof makeSessionPage> =>
			makeSessionPage(sessionId, {
				runs: [makeRun(runId, sessionId, "running")],
				nextCursor: "stuck",
			});
		const { client } = makeFakeChatClient({
			sessionId,
			snapshot: makeSessionPage(sessionId),
			getPage,
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({ client, bus, sessionId, onChange: () => {} });
		await controller.start();

		expect(controller.getView().phase).toBe("error");
	});
});

describe("ChatSessionController send reservation (f7)", () => {
	function makeController(options: {
		sessionId: string;
		ids: string[];
		send?: (content: string, requestId: string) => never | ReturnType<typeof successResult>;
	}) {
		const idQueue = [...options.ids];
		const { client, script } = makeFakeChatClient({
			sessionId: options.sessionId,
			snapshot: makeSessionPage(options.sessionId),
			...(options.send ? { send: options.send } : {}),
		});
		const bus = new MobileEventBus();
		const controller = new ChatSessionController({
			client,
			bus,
			sessionId: options.sessionId,
			onChange: () => {},
			generateRequestId: () => idQueue.shift() ?? "exhausted",
		});
		return { controller, script };
	}

	function successResult(sessionId: string, content: string) {
		return {
			run: makeRun(v7(), sessionId, "running", content),
		};
	}

	it("reuses the same requestId when retrying after an ambiguous (lost) response", async () => {
		const sessionId = v7();
		let attempt = 0;
		const { controller, script } = makeController({
			sessionId,
			ids: ["req-A", "req-B"],
			send: (content) => {
				attempt += 1;
				if (attempt === 1) {
					// First attempt: the server may have accepted it, but the response was lost.
					throw new Error("socket dropped");
				}
				return successResult(sessionId, content);
			},
		});
		await controller.start();

		await expect(controller.send("hello")).rejects.toThrow();
		expect(controller.hasPendingSend()).toBe(true);
		expect(controller.getView().pendingSendAmbiguous).toBe(true);

		// Retry of the SAME content must reuse req-A so the server dedupes to one run.
		await controller.send("hello");
		expect(script.sendCalls).toEqual([
			{ requestId: "req-A", content: "hello" },
			{ requestId: "req-A", content: "hello" },
		]);
		expect(controller.hasPendingSend()).toBe(false);
	});

	it("mints a new requestId after a definitive rejection", async () => {
		const sessionId = v7();
		let attempt = 0;
		const { controller, script } = makeController({
			sessionId,
			ids: ["req-A", "req-B"],
			send: (content) => {
				attempt += 1;
				if (attempt === 1) {
					// INVALID_ARGUMENT definitively proves no run was created.
					throw remoteError("INVALID_ARGUMENT");
				}
				return successResult(sessionId, content);
			},
		});
		await controller.start();

		await expect(controller.send("hello")).rejects.toBeInstanceOf(RpcRemoteError);
		expect(controller.hasPendingSend()).toBe(false);

		await controller.send("hello");
		expect(script.sendCalls).toEqual([
			{ requestId: "req-A", content: "hello" },
			{ requestId: "req-B", content: "hello" },
		]);
	});

	it("mints a new requestId when the user edits the draft after an ambiguous send", async () => {
		const sessionId = v7();
		let attempt = 0;
		const { controller, script } = makeController({
			sessionId,
			ids: ["req-A", "req-B"],
			send: (content) => {
				attempt += 1;
				if (attempt === 1) {
					throw new Error("timeout");
				}
				return successResult(sessionId, content);
			},
		});
		await controller.start();

		await expect(controller.send("hello")).rejects.toThrow();
		expect(controller.hasPendingSend()).toBe(true);

		// The user edited the content — a new request, since the old one's result is unknown.
		await controller.send("hello world");
		expect(script.sendCalls).toEqual([
			{ requestId: "req-A", content: "hello" },
			{ requestId: "req-B", content: "hello world" },
		]);
	});
});
