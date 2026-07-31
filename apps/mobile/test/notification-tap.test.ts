import { describe, expect, it, vi } from "vitest";
import type { LocalNotificationScheduler, NotificationRoute } from "../src/native/notifications";
import {
	NotificationTapCoordinator,
	type NotificationTapReadiness,
} from "../src/rpc/notification-tap";

/** A scheduler stub that captures the tap handler and reports dispose calls. */
function makeTapScheduler() {
	let handler: ((route: NotificationRoute) => void) | null = null;
	let disposed = 0;
	const scheduler: LocalNotificationScheduler = {
		async getPermission() {
			return "granted";
		},
		async requestPermission() {
			return "granted";
		},
		async schedule() {},
		async setBadge() {},
		onTap(next) {
			handler = next;
			return () => {
				disposed += 1;
			};
		},
	};
	return {
		scheduler,
		tap(route: NotificationRoute) {
			handler?.(route);
		},
		hasHandler: () => handler !== null,
		disposed: () => disposed,
	};
}

const ROUTE: NotificationRoute = { sessionId: "s-1", approvalId: "a-1", attentionEventId: "e-1" };

describe("NotificationTapCoordinator", () => {
	it("waits for a ready+refreshed session before navigating (offline → connect → refresh → navigate)", async () => {
		const sched = makeTapScheduler();
		let readiness: NotificationTapReadiness = "connecting";
		const order: string[] = [];
		let resolveReady: (ok: boolean) => void = () => {};

		const navigate = vi.fn<(route: NotificationRoute) => void>(() => order.push("navigate"));
		const safe = vi.fn();
		const coordinator = new NotificationTapCoordinator({
			scheduler: sched.scheduler,
			readiness: () => readiness,
			waitUntilReady: () =>
				new Promise<boolean>((resolve) => {
					order.push("wait");
					resolveReady = resolve;
				}),
			navigate,
			showSafeState: safe,
		});
		coordinator.start();

		// Tap arrives while paired-but-offline: no immediate navigation, we start waiting.
		sched.tap(ROUTE);
		await Promise.resolve();
		expect(order).toEqual(["wait"]);
		expect(navigate).not.toHaveBeenCalled();
		expect(safe).not.toHaveBeenCalled();

		// The session becomes ready and the fresh snapshot lands → navigate exactly once, with the route.
		readiness = "ready";
		resolveReady(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith(ROUTE);
		expect(safe).not.toHaveBeenCalled();
		expect(order).toEqual(["wait", "navigate"]);
	});

	it("shows a safe state and never navigates when unpaired at tap time", async () => {
		const sched = makeTapScheduler();
		const navigate = vi.fn();
		const safe = vi.fn();
		const waitUntilReady = vi.fn(async () => true);
		const coordinator = new NotificationTapCoordinator({
			scheduler: sched.scheduler,
			readiness: () => "unpaired",
			waitUntilReady,
			navigate,
			showSafeState: safe,
		});
		coordinator.start();

		sched.tap(ROUTE);
		await Promise.resolve();
		expect(safe).toHaveBeenCalledWith(ROUTE);
		expect(navigate).not.toHaveBeenCalled();
		// We short-circuit before ever waiting on a connection.
		expect(waitUntilReady).not.toHaveBeenCalled();
	});

	it("shows a safe state and never navigates when fatal at tap time", async () => {
		const sched = makeTapScheduler();
		const navigate = vi.fn();
		const safe = vi.fn();
		const coordinator = new NotificationTapCoordinator({
			scheduler: sched.scheduler,
			readiness: () => "fatal",
			waitUntilReady: async () => true,
			navigate,
			showSafeState: safe,
		});
		coordinator.start();

		sched.tap(ROUTE);
		await Promise.resolve();
		expect(safe).toHaveBeenCalledWith(ROUTE);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("shows a safe state (not stale content) when readiness never arrives", async () => {
		const sched = makeTapScheduler();
		const navigate = vi.fn();
		const safe = vi.fn();
		const coordinator = new NotificationTapCoordinator({
			scheduler: sched.scheduler,
			readiness: () => "connecting",
			// The session dropped to unpaired/fatal or timed out before becoming ready.
			waitUntilReady: async () => false,
			navigate,
			showSafeState: safe,
		});
		coordinator.start();

		sched.tap(ROUTE);
		await Promise.resolve();
		await Promise.resolve();
		expect(navigate).not.toHaveBeenCalled();
		expect(safe).toHaveBeenCalledWith(ROUTE);
	});

	it("registers exactly one listener and disposes it on teardown (no leak)", () => {
		const sched = makeTapScheduler();
		const coordinator = new NotificationTapCoordinator({
			scheduler: sched.scheduler,
			readiness: () => "ready",
			waitUntilReady: async () => true,
			navigate: () => {},
			showSafeState: () => {},
		});
		coordinator.start();
		coordinator.start(); // idempotent: still a single listener
		expect(sched.hasHandler()).toBe(true);

		coordinator.dispose();
		expect(sched.disposed()).toBe(1);
		coordinator.dispose(); // idempotent
		expect(sched.disposed()).toBe(1);
	});
});
