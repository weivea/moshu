import { describe, expect, test } from "bun:test";

import { type BeforeQuitEvent, createDesktopShutdownCoordinator } from "./desktop-lifecycle";

describe("createDesktopShutdownCoordinator", () => {
	test("vetoes quit until cleanup completes, then explicitly allows quit", async () => {
		const cleanup = createDeferred();
		const events: string[] = [];
		let coordinator: ReturnType<typeof createDesktopShutdownCoordinator>;
		coordinator = createDesktopShutdownCoordinator({
			async cleanup() {
				events.push("cleanup:start");
				await cleanup.promise;
				events.push("cleanup:end");
			},
			quit() {
				events.push("quit");
				const retry = createBeforeQuitEvent();
				coordinator.handleBeforeQuit(retry);
				events.push(`retry:${String(retry.response.allow)}`);
			},
			reportError(error) {
				throw error;
			},
		});
		const initial = createBeforeQuitEvent();

		coordinator.handleBeforeQuit(initial);

		expect(initial.response.allow).toBe(false);
		expect(events).toEqual(["cleanup:start"]);
		cleanup.resolve();
		await coordinator.shutdown();
		expect(events).toEqual(["cleanup:start", "cleanup:end", "quit", "retry:true"]);
	});

	test("starts one cleanup when the window closes repeatedly", async () => {
		let cleanupCount = 0;
		let quitCount = 0;
		const coordinator = createDesktopShutdownCoordinator({
			async cleanup() {
				cleanupCount += 1;
			},
			quit() {
				quitCount += 1;
			},
			reportError(error) {
				throw error;
			},
		});

		coordinator.handleWindowClose();
		coordinator.handleWindowClose();
		await coordinator.shutdown();

		expect(cleanupCount).toBe(1);
		expect(quitCount).toBe(1);
	});

	test("reports a cleanup deadline and explicitly quits instead of vetoing forever", async () => {
		const cleanup = createDeferred();
		const errors: unknown[] = [];
		let quitCount = 0;
		let fireTimeout: (() => void) | undefined;
		const coordinator = createDesktopShutdownCoordinator({
			async cleanup() {
				await cleanup.promise;
			},
			quit() {
				quitCount += 1;
			},
			reportError(error) {
				errors.push(error);
			},
			cleanupTimeoutMs: 50,
			timers: {
				setTimer(callback) {
					fireTimeout = callback;
					return setTimeout(() => undefined, 0);
				},
				clearTimer(handle) {
					clearTimeout(handle);
				},
			},
		});
		const event = createBeforeQuitEvent();

		coordinator.handleBeforeQuit(event);
		expect(event.response.allow).toBe(false);
		fireTimeout?.();
		await coordinator.shutdown();

		expect(errors).toHaveLength(1);
		expect(errors[0]).toEqual(new Error("Desktop cleanup did not complete within 50ms."));
		expect(quitCount).toBe(1);

		cleanup.resolve();
		await Promise.resolve();
		expect(quitCount).toBe(1);
	});
});

function createBeforeQuitEvent(): BeforeQuitEvent {
	return {
		response: {
			allow: true,
		},
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve(): void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.();
		},
	};
}
