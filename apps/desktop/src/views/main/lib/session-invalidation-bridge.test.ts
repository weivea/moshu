import { describe, expect, test, vi } from "vitest";

import type { ChatSessionInvalidation } from "../../../shared/rpc";
import { ChatSessionInvalidationBridge } from "./session-invalidation-bridge";

describe("ChatSessionInvalidationBridge", () => {
	test("awaits delayed coordinator mount and authoritative processing before accepting", async () => {
		const bridge = createBridge();
		const processing = createDeferred<void>();
		const listener = vi.fn(() => processing.promise);
		const handling = bridge.handle(makeInvalidation());
		let settled = false;
		void handling.then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		expect(bridge.pendingCount).toBe(1);
		const observer = vi.fn();
		bridge.subscribe(observer);
		await Promise.resolve();
		expect(observer).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		bridge.subscribe(listener, { authoritative: true });
		await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
		expect(observer).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		processing.resolve();

		await expect(handling).resolves.toBe(true);
		expect(bridge.pendingCount).toBe(0);
	});

	test("rejects the ACK when delayed coordinator replay fails", async () => {
		const bridge = createBridge();
		const handling = bridge.handle(makeInvalidation());
		bridge.subscribe(() => Promise.reject(new Error("authoritative refresh failed")), {
			authoritative: true,
		});

		await expect(handling).resolves.toBe(false);
		expect(bridge.pendingCount).toBe(0);
	});

	test("rejects timed-out, unloaded, and queue-evicted entries without dangling promises", async () => {
		const timedOut = new ChatSessionInvalidationBridge({ timeoutMs: 10, maxPending: 1 });
		await expect(timedOut.handle(makeInvalidation())).resolves.toBe(false);
		expect(timedOut.pendingCount).toBe(0);

		const unloaded = createBridge();
		const unloading = unloaded.handle(makeInvalidation("unload"));
		unloaded.shutdown();
		await expect(unloading).resolves.toBe(false);
		expect(unloaded.pendingCount).toBe(0);

		const bounded = new ChatSessionInvalidationBridge({ timeoutMs: 1_000, maxPending: 1 });
		const oldest = bounded.handle(makeInvalidation("oldest"));
		const newest = bounded.handle(makeInvalidation("newest"));
		await expect(oldest).resolves.toBe(false);
		expect(bounded.pendingCount).toBe(1);
		bounded.shutdown();
		await expect(newest).resolves.toBe(false);
		expect(bounded.pendingCount).toBe(0);
	});

	test("keeps agents-ready delivery independent while ordering ACK after replay", async () => {
		const bridge = createBridge();
		const events: string[] = [];
		const processing = createDeferred<void>();
		const handling = bridge.handle(makeInvalidation()).then((accepted) => {
			events.push(`ack:${accepted}`);
		});

		events.push("agentsReady");
		bridge.subscribe(
			async () => {
				await processing.promise;
				events.push("processed");
			},
			{ authoritative: true },
		);
		expect(events).toEqual(["agentsReady"]);
		processing.resolve();
		await handling;

		expect(events).toEqual(["agentsReady", "processed", "ack:true"]);
	});

	test("acknowledges a retired Session only after authoritative bridge handling", async () => {
		const bridge = createBridge();
		const listener = vi.fn();
		bridge.subscribe(listener, { authoritative: true });
		const invalidation = {
			...makeInvalidation("retired"),
			reason: "session_retired" as const,
		};

		await expect(bridge.handle(invalidation)).resolves.toBe(true);
		expect(listener).toHaveBeenCalledWith(invalidation);
	});
});

function createBridge(): ChatSessionInvalidationBridge {
	return new ChatSessionInvalidationBridge({ timeoutMs: 1_000, maxPending: 4 });
}

function makeInvalidation(id = "invalidation-1"): ChatSessionInvalidation {
	return {
		schemaVersion: 1,
		invalidationId: id,
		sessionId: "session-a",
		reason: "history_expired",
	};
}

function createDeferred<T>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
