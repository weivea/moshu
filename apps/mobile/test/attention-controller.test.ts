import type { AckMobileAttentionOutput, ListMobileAttentionOutput } from "@moshu/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { LocalNotificationScheduler, NotificationRoute } from "../src/native/notifications";
import { AttentionController, type AttentionFeedClient } from "../src/rpc/attention-controller";
import { MobileEventBus } from "../src/rpc/events";

function listOutput(overrides: Partial<ListMobileAttentionOutput> = {}): ListMobileAttentionOutput {
	return {
		schemaVersion: 1,
		items: [],
		unreadCount: 0,
		ackSeq: 0,
		latestSeq: 0,
		resyncRequired: false,
		...overrides,
	};
}

/** A scriptable fake feed client + a queue of list responses. */
function makeFeedClient() {
	const queue: ListMobileAttentionOutput[] = [];
	const listCalls: unknown[] = [];
	const ackCalls: { seq: number }[] = [];
	let ackResult: AckMobileAttentionOutput = {
		schemaVersion: 1,
		ackSeq: 0,
		unreadCount: 0,
		latestSeq: 0,
	};
	const client: AttentionFeedClient = {
		async listAttention(input) {
			listCalls.push(input);
			return queue.shift() ?? listOutput();
		},
		async ackAttention(input) {
			ackCalls.push(input);
			return ackResult;
		},
	};
	return {
		client,
		listCalls,
		ackCalls,
		enqueue(output: ListMobileAttentionOutput) {
			queue.push(output);
		},
		setAckResult(result: AckMobileAttentionOutput) {
			ackResult = result;
		},
	};
}

function makeScheduler() {
	const scheduled: {
		id: number;
		title: string;
		body: string;
		route?: NotificationRoute;
	}[] = [];
	const badges: number[] = [];
	const tapHandlers: ((route: NotificationRoute) => void)[] = [];
	let disposeCount = 0;
	const scheduler: LocalNotificationScheduler = {
		async getPermission() {
			return "granted";
		},
		async requestPermission() {
			return "granted";
		},
		async schedule(request) {
			scheduled.push({
				id: request.id,
				title: request.title,
				body: request.body,
				route: request.route,
			});
		},
		async setBadge(count) {
			badges.push(count);
		},
		onTap(handler) {
			tapHandlers.push(handler);
			return () => {
				disposeCount += 1;
			};
		},
	};
	return {
		scheduler,
		scheduled,
		badges,
		tapHandlers,
		disposeCount: () => disposeCount,
	};
}

const TEXT = { title: "Moshu", body: "New activity" };

/** Build a minimal, valid desensitized attention event for a given sequence. */
function makeEvent(
	seq: number,
	overrides: Partial<ListMobileAttentionOutput["items"][number]> = {},
): ListMobileAttentionOutput["items"][number] {
	return {
		schemaVersion: 1,
		eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
		seq,
		type: "approval_required",
		visibility: "mobile-clients",
		createdAt: "2024-01-01T00:00:00.000Z",
		titleKey: "attention.approval_required.title",
		bodyKey: "attention.approval_required.body",
		...overrides,
	};
}

describe("AttentionController", () => {
	let bus: MobileEventBus;

	beforeEach(() => {
		bus = new MobileEventBus();
	});

	it("recovers unread on attach WITHOUT replaying historical events as notifications", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled, badges } = makeScheduler();
		// Server already has 5 unread when the phone reconnects.
		feed.enqueue(listOutput({ unreadCount: 5, latestSeq: 5, ackSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});

		controller.attach(feed.client, bus);
		await controller.whenSettled();

		expect(controller.unreadCount).toBe(5);
		// Badge reflects the recovered unread, but NO backlog notification was posted.
		expect(badges).toContain(5);
		expect(scheduled).toHaveLength(0);
	});

	it("schedules a single generic notification for a LIVE hint while backgrounded", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 0, latestSeq: 0 })); // initial snapshot: baseline 0
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		// A live event arrives (seq 1) and the bus hint fires.
		feed.enqueue(listOutput({ unreadCount: 1, latestSeq: 1 }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.title).toBe(TEXT.title);
		expect(scheduled[0]?.body).toBe(TEXT.body);
		// The body/title carry no business content — only the generic localized copy.
		expect(scheduled[0]?.body).not.toContain("shell");
	});

	it("attaches ONLY the opaque route ids from the newest event to the notification", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 0, latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		const event = makeEvent(1, {
			sessionId: "session-abc",
			approvalId: "approval-xyz",
			runId: "run-should-not-leak",
		});
		feed.enqueue(listOutput({ unreadCount: 1, latestSeq: 1, items: [event] }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		// Route carries only sessionId/approvalId + the stable attention eventId — nothing else, and no
		// business content (runId and any other field are not forwarded across the tap boundary).
		expect(scheduled[0]?.route).toEqual({
			attentionEventId: event.eventId,
			sessionId: "session-abc",
			approvalId: "approval-xyz",
		});
	});

	it("omits a route when the newest event is not present in the page", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 0, latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		// latestSeq advances but the page carries no matching item → never fabricate a route.
		feed.enqueue(listOutput({ unreadCount: 1, latestSeq: 5, items: [] }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.route).toBeUndefined();
	});

	it("resolves the newest-event route by walking pages when the feed exceeds one page (>100 events)", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 0, latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		// A busy feed: the live-hint snapshot is the FIRST page (oldest events, ascending), so the
		// newest event (seq 150) is NOT on it — it is on a later page reached via the opaque cursor.
		const firstPage = listOutput({
			unreadCount: 100,
			latestSeq: 150,
			items: [makeEvent(1), makeEvent(2), makeEvent(50)],
			nextCursor: "cursor-page-2",
		});
		const newest = makeEvent(150, { sessionId: "session-150", approvalId: "approval-150" });
		const secondPage = listOutput({
			unreadCount: 100,
			latestSeq: 150,
			items: [makeEvent(149), newest],
		});
		feed.enqueue(firstPage);
		feed.enqueue(secondPage);
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.id).toBe(150);
		// The route was resolved from the LAST page's newest event, not lost because it was off page 1.
		expect(scheduled[0]?.route).toEqual({
			attentionEventId: newest.eventId,
			sessionId: "session-150",
			approvalId: "approval-150",
		});
		// The walk actually followed the server-issued opaque cursor.
		expect(feed.listCalls).toContainEqual({ cursor: "cursor-page-2" });
	});

	it("omits the route (safe Activity) when a retention gap appears while walking pages", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 0, latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		const firstPage = listOutput({
			unreadCount: 100,
			latestSeq: 150,
			items: [makeEvent(1), makeEvent(2)],
			nextCursor: "cursor-page-2",
		});
		// The next page reports a retention gap: our opaque ids may be stale, so we must NOT guess a
		// route from them. The notification still fires (badge/awareness) but a tap lands on safe state.
		const gapPage = listOutput({ unreadCount: 100, latestSeq: 150, resyncRequired: true });
		feed.enqueue(firstPage);
		feed.enqueue(gapPage);
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.id).toBe(150);
		expect(scheduled[0]?.route).toBeUndefined();
	});

	it("does NOT notify for a live hint while the app is active (badge only)", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled, badges } = makeScheduler();
		feed.enqueue(listOutput({ latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => true,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		feed.enqueue(listOutput({ unreadCount: 1, latestSeq: 1 }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(0);
		expect(badges).toContain(1);
	});

	it("does NOT notify when notifications are disabled", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			isNotificationsEnabled: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		feed.enqueue(listOutput({ unreadCount: 1, latestSeq: 1 }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(0);
	});

	it("uses a stable notification id derived from the newest sequence (coalesces duplicates)", async () => {
		const feed = makeFeedClient();
		const { scheduler, scheduled } = makeScheduler();
		feed.enqueue(listOutput({ latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		feed.enqueue(listOutput({ unreadCount: 2, latestSeq: 7 }));
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.id).toBe(7);
	});

	it("acks monotonically and updates unread/badge from the server result", async () => {
		const feed = makeFeedClient();
		const { scheduler, badges } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 3, latestSeq: 3 }));
		feed.setAckResult({ schemaVersion: 1, ackSeq: 3, unreadCount: 0, latestSeq: 3 });
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => true,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();
		expect(controller.unreadCount).toBe(3);

		await controller.ackAll();
		expect(feed.ackCalls).toEqual([{ seq: 3 }]);
		expect(controller.unreadCount).toBe(0);
		expect(badges).toContain(0);
	});

	it("surfaces resyncRequired from a retention gap (never fakes zero unread)", async () => {
		const feed = makeFeedClient();
		const { scheduler } = makeScheduler();
		feed.enqueue(listOutput({ unreadCount: 42, latestSeq: 90, ackSeq: 10, resyncRequired: true }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => true,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();

		expect(controller.snapshot.resyncRequired).toBe(true);
		expect(controller.snapshot.unreadCount).toBe(42);
	});

	it("stops refreshing after detach (no business state pulled while disconnected)", async () => {
		const feed = makeFeedClient();
		const { scheduler } = makeScheduler();
		feed.enqueue(listOutput({ latestSeq: 0 }));
		const controller = new AttentionController({
			scheduler,
			isAppActive: () => false,
			notificationText: () => TEXT,
		});
		controller.attach(feed.client, bus);
		await controller.whenSettled();
		const callsBefore = feed.listCalls.length;

		controller.detach();
		// A late hint after detach must be ignored (the bus subscription was removed).
		bus.emit("mobileAttentionChanged", { schemaVersion: 1 });
		await controller.whenSettled();

		expect(feed.listCalls.length).toBe(callsBefore);
	});
});
