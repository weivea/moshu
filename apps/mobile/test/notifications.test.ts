import { describe, expect, it } from "vitest";
import {
	noopNotificationScheduler,
	notificationIdForSeq,
	parseNotificationRoute,
} from "../src/native/notifications";

describe("notificationIdForSeq", () => {
	it("is stable for a given sequence (coalesces duplicates in the OS)", () => {
		expect(notificationIdForSeq(42)).toBe(notificationIdForSeq(42));
	});

	it("is always a positive 31-bit integer", () => {
		for (const seq of [0, 1, 7, 2_147_483_647, 5_000_000_000]) {
			const id = notificationIdForSeq(seq);
			expect(Number.isInteger(id)).toBe(true);
			expect(id).toBeGreaterThan(0);
			expect(id).toBeLessThanOrEqual(2_147_483_647);
		}
	});

	it("maps distinct small sequences to distinct ids", () => {
		expect(notificationIdForSeq(1)).not.toBe(notificationIdForSeq(2));
	});
});

describe("noopNotificationScheduler", () => {
	it("reports unavailable and never throws", async () => {
		await expect(noopNotificationScheduler.getPermission()).resolves.toBe("unavailable");
		await expect(noopNotificationScheduler.requestPermission()).resolves.toBe("unavailable");
		await expect(
			noopNotificationScheduler.schedule({ id: 1, title: "t", body: "b" }),
		).resolves.toBeUndefined();
		await expect(noopNotificationScheduler.setBadge(3)).resolves.toBeUndefined();
	});

	it("returns a disposable tap registration that is a no-op", () => {
		const dispose = noopNotificationScheduler.onTap(() => {
			throw new Error("should never be called on the noop scheduler");
		});
		expect(typeof dispose).toBe("function");
		expect(() => dispose()).not.toThrow();
	});
});

describe("parseNotificationRoute", () => {
	it("keeps only the whitelisted opaque ids and drops everything else", () => {
		const route = parseNotificationRoute({
			sessionId: "s-1",
			approvalId: "a-1",
			attentionEventId: "e-1",
			// Hostile / stray keys and any business content must never survive the tap boundary.
			prompt: "rm -rf /",
			command: "shell",
			path: "/etc/passwd",
		});
		expect(route).toEqual({ sessionId: "s-1", approvalId: "a-1", attentionEventId: "e-1" });
	});

	it("accepts a partial route with just one id", () => {
		expect(parseNotificationRoute({ approvalId: "a-1" })).toEqual({ approvalId: "a-1" });
	});

	it("returns null for missing, empty, or non-string payloads", () => {
		expect(parseNotificationRoute(undefined)).toBeNull();
		expect(parseNotificationRoute(null)).toBeNull();
		expect(parseNotificationRoute("nope")).toBeNull();
		expect(parseNotificationRoute({})).toBeNull();
		expect(parseNotificationRoute({ sessionId: "" })).toBeNull();
		expect(parseNotificationRoute({ sessionId: 42, approvalId: {} })).toBeNull();
		// A payload with only non-whitelisted keys is not actionable.
		expect(parseNotificationRoute({ prompt: "leak" })).toBeNull();
	});
});
