import type { AckMobileAttentionOutput, ListMobileAttentionOutput } from "@moshu/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AttentionController, type AttentionFeedClient } from "../src/rpc/attention-controller";
import type { LocalNotificationScheduler } from "../src/native/notifications";
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
	const scheduled: { id: number; title: string; body: string }[] = [];
	const badges: number[] = [];
	const scheduler: LocalNotificationScheduler = {
		async getPermission() {
			return "granted";
		},
		async requestPermission() {
			return "granted";
		},
		async schedule(request) {
			scheduled.push({ id: request.id, title: request.title, body: request.body });
		},
		async setBadge(count) {
			badges.push(count);
		},
	};
	return { scheduler, scheduled, badges };
}

const TEXT = { title: "Moshu", body: "New activity" };

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
