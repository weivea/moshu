import { describe, expect, it } from "vitest";
import { noopNotificationScheduler, notificationIdForSeq } from "../src/native/notifications";

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
});
