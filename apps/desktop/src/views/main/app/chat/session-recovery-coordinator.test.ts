import { retiredSessionTombstoneTtlMs } from "@moshu/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import {
	ChatSessionRecoveryCoordinator,
	isRendererSessionRetired,
} from "./session-recovery-coordinator";
import { modelSelectionFor } from "./test-transport-defaults";
import type {
	ChatSession,
	ChatSessionInvalidation,
	ChatSessionInvalidationListener,
	ChatTransport,
} from "./transport";

beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	window.history.replaceState(null, "");
});

describe("ChatSessionRecoveryCoordinator", () => {
	test.each(["chat-home", "settings"] as const)(
		"authoritatively handles history expiry on %s without a ChatPage listener",
		async (routeKey) => {
			const transport = new RecoveryTransport();
			const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
			coordinator.activateRoute(routeKey, null);
			const unmount = coordinator.mountRoot(vi.fn());

			await transport.emitInvalidation({
				sessionId: "inactive-session",
				reason: "history_expired",
			});

			expect(transport.getSessionCalls).toEqual(["inactive-session"]);
			expect(transport.invalidationListenerCount).toBe(1);
			unmount();
			expect(transport.invalidationListenerCount).toBe(0);
		},
	);

	test("globally tombstones an inactive retired Session", async () => {
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("session-b", "session-b");
		const onActiveSessionRetired = vi.fn();
		const unmount = coordinator.mountRoot(onActiveSessionRetired);

		await transport.emitInvalidation({
			sessionId: "session-a",
			reason: "session_retired",
		});

		expect(isRendererSessionRetired("session-a")).toBe(true);
		expect(onActiveSessionRetired).not.toHaveBeenCalled();
		unmount();
	});

	test("coordinates an old A refresh with the new A generation after A to B to A", async () => {
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		const oldRefresh = createDeferred<boolean>();
		const newRefresh = createDeferred<boolean>();
		const oldRoute = coordinator.activateRoute("a-1", "session-a");
		const unregisterOld = coordinator.registerController({
			generation: oldRoute.generation,
			sessionId: "session-a",
			refresh: () => oldRefresh.promise,
			retire: vi.fn(),
		});
		const invalidation = coordinator.handleInvalidation({
			sessionId: "session-a",
			reason: "history_expired",
		});

		coordinator.activateRoute("b", "session-b");
		const newRoute = coordinator.activateRoute("a-2", "session-a");
		const newRefreshCall = vi.fn(() => newRefresh.promise);
		const unregisterNew = coordinator.registerController({
			generation: newRoute.generation,
			sessionId: "session-a",
			refresh: newRefreshCall,
			retire: vi.fn(),
		});
		oldRefresh.reject(new Error("Old A refresh failed."));
		await vi.waitFor(() => expect(newRefreshCall).toHaveBeenCalledOnce());
		newRefresh.resolve(true);

		await expect(invalidation).resolves.toBeUndefined();
		unregisterOld();
		unregisterNew();
	});

	test("rejects when the newly active A generation also fails to refresh", async () => {
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		const oldRefresh = createDeferred<boolean>();
		const oldRoute = coordinator.activateRoute("a-1", "session-a");
		coordinator.registerController({
			generation: oldRoute.generation,
			sessionId: "session-a",
			refresh: () => oldRefresh.promise,
			retire: vi.fn(),
		});
		const invalidation = coordinator.handleInvalidation({
			sessionId: "session-a",
			reason: "history_expired",
		});

		coordinator.activateRoute("b", "session-b");
		const newRoute = coordinator.activateRoute("a-2", "session-a");
		coordinator.registerController({
			generation: newRoute.generation,
			sessionId: "session-a",
			refresh: () => Promise.reject(new Error("New A hydration failed.")),
			retire: vi.fn(),
		});
		oldRefresh.reject(new Error("Old A refresh failed."));

		await expect(invalidation).rejects.toThrow("New A hydration failed.");
	});

	test.each(["chat-home", "settings"] as const)(
		"refreshes Session A when it becomes active during an inactive %s probe",
		async (routeKey) => {
			const transport = new RecoveryTransport();
			const probe = createDeferred<ChatSession>();
			vi.spyOn(transport, "getSession").mockReturnValueOnce(probe.promise);
			const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
			coordinator.activateRoute(routeKey, null);
			const invalidation = coordinator.handleInvalidation({
				sessionId: "session-a",
				reason: "history_expired",
			});
			await vi.waitFor(() => expect(transport.getSession).toHaveBeenCalledOnce());
			const activeRoute = coordinator.activateRoute("session-a", "session-a");
			const refresh = vi.fn(() => Promise.resolve(true));
			coordinator.registerController({
				generation: activeRoute.generation,
				sessionId: "session-a",
				refresh,
				retire: vi.fn(),
			});

			probe.resolve(makeSession("session-a"));
			await expect(invalidation).resolves.toBeUndefined();
			expect(refresh).toHaveBeenCalledOnce();
		},
	);

	test("rejects when Session A becomes active during an inactive probe and its refresh fails", async () => {
		const transport = new RecoveryTransport();
		const probe = createDeferred<ChatSession>();
		vi.spyOn(transport, "getSession").mockReturnValueOnce(probe.promise);
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("settings", null);
		const invalidation = coordinator.handleInvalidation({
			sessionId: "session-a",
			reason: "history_expired",
		});
		await vi.waitFor(() => expect(transport.getSession).toHaveBeenCalledOnce());
		const activeRoute = coordinator.activateRoute("session-a", "session-a");
		coordinator.registerController({
			generation: activeRoute.generation,
			sessionId: "session-a",
			refresh: () => Promise.reject(new Error("Active A refresh failed.")),
			retire: vi.fn(),
		});

		probe.resolve(makeSession("session-a"));
		await expect(invalidation).rejects.toThrow("Active A refresh failed.");
	});

	test("awaits the replacement active generation after its predecessor refresh succeeds", async () => {
		const transport = new RecoveryTransport();
		const probe = createDeferred<ChatSession>();
		vi.spyOn(transport, "getSession").mockReturnValueOnce(probe.promise);
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("settings", null);
		const invalidation = coordinator.handleInvalidation({
			sessionId: "session-a",
			reason: "history_expired",
		});
		await vi.waitFor(() => expect(transport.getSession).toHaveBeenCalledOnce());
		const firstRoute = coordinator.activateRoute("session-a-1", "session-a");
		const firstRefresh = createDeferred<boolean>();
		const firstRefreshCall = vi.fn(() => firstRefresh.promise);
		coordinator.registerController({
			generation: firstRoute.generation,
			sessionId: "session-a",
			refresh: firstRefreshCall,
			retire: vi.fn(),
		});
		probe.resolve(makeSession("session-a"));
		await vi.waitFor(() => expect(firstRefreshCall).toHaveBeenCalledOnce());
		const secondRoute = coordinator.activateRoute("session-a-2", "session-a");
		const secondRefresh = vi.fn(() => Promise.resolve(true));
		coordinator.registerController({
			generation: secondRoute.generation,
			sessionId: "session-a",
			refresh: secondRefresh,
			retire: vi.fn(),
		});
		firstRefresh.resolve(true);

		await expect(invalidation).resolves.toBeUndefined();
		expect(secondRefresh).toHaveBeenCalledOnce();
	});

	test("records conclusive not-found globally and purges only matching renderer caches", async () => {
		const transport = new RecoveryTransport();
		vi.spyOn(transport, "getSession").mockRejectedValueOnce(new ChatSessionNotFoundError());
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("settings", null);
		localStorage.setItem("moshu.lastChatSessionId", "session-a");
		window.history.replaceState(
			{
				usr: {
					hydratedSession: makeSession("session-a"),
					unrelated: "keep",
				},
				key: "route-key",
			},
			"",
		);

		await coordinator.handleInvalidation({
			sessionId: "session-a",
			reason: "history_expired",
		});

		expect(isRendererSessionRetired("session-a")).toBe(true);
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBeNull();
		expect(window.history.state).toEqual({
			usr: { unrelated: "keep" },
			key: "route-key",
		});
	});

	test("explicit global retirement leaves unrelated caches and routes untouched", () => {
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("session-b", "session-b");
		const onActiveSessionRetired = vi.fn();
		const unmount = coordinator.mountRoot(onActiveSessionRetired);
		localStorage.setItem("moshu.lastChatSessionId", "session-b");
		window.history.replaceState({ usr: { hydratedSession: makeSession("session-b") } }, "");

		coordinator.recordSessionRetired("session-a");

		expect(isRendererSessionRetired("session-a")).toBe(true);
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBe("session-b");
		expect(window.history.state.usr.hydratedSession.id).toBe("session-b");
		expect(onActiveSessionRetired).not.toHaveBeenCalled();
		unmount();
	});

	test("handles repeated typed misses once and ignores unrelated errors", () => {
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(transport as unknown as ChatTransport);
		coordinator.activateRoute("session-a", "session-a");
		const onActiveSessionRetired = vi.fn();
		const retirementListener = vi.fn();
		const unmount = coordinator.mountRoot(onActiveSessionRetired);
		const unsubscribe = coordinator.subscribeRetirements(retirementListener);
		localStorage.setItem("moshu.lastChatSessionId", "session-a");

		expect(coordinator.handleSessionMiss("session-a", new ChatSessionNotFoundError())).toBe(true);
		expect(coordinator.handleSessionMiss("session-a", new ChatSessionNotFoundError())).toBe(true);
		expect(coordinator.handleSessionMiss("session-b", new Error("unrelated"))).toBe(false);

		expect(retirementListener).toHaveBeenCalledOnce();
		expect(retirementListener).toHaveBeenCalledWith("session-a");
		expect(onActiveSessionRetired).toHaveBeenCalledOnce();
		expect(isRendererSessionRetired("session-a")).toBe(true);
		expect(isRendererSessionRetired("session-b")).toBe(false);
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBeNull();
		unsubscribe();
		unmount();
	});

	test("reruns retirement cleanup and navigation only after the shared tombstone TTL", () => {
		let nowMs = 1_000;
		const transport = new RecoveryTransport();
		const coordinator = new ChatSessionRecoveryCoordinator(
			transport as unknown as ChatTransport,
			() => nowMs,
		);
		coordinator.activateRoute("session-a", "session-a");
		const onActiveSessionRetired = vi.fn();
		const retirementListener = vi.fn();
		const unmount = coordinator.mountRoot(onActiveSessionRetired);
		const unsubscribe = coordinator.subscribeRetirements(retirementListener);

		coordinator.recordSessionRetired("session-a");
		nowMs += retiredSessionTombstoneTtlMs - 1;
		coordinator.recordSessionRetired("session-a");
		expect(transport.retiredSessionIds).toEqual(["session-a"]);
		expect(retirementListener).toHaveBeenCalledOnce();
		expect(onActiveSessionRetired).toHaveBeenCalledOnce();

		nowMs += 1;
		coordinator.recordSessionRetired("session-a");
		expect(transport.retiredSessionIds).toEqual(["session-a", "session-a"]);
		expect(retirementListener).toHaveBeenCalledTimes(2);
		expect(onActiveSessionRetired).toHaveBeenCalledTimes(2);
		expect(isRendererSessionRetired("session-a", nowMs)).toBe(true);

		unsubscribe();
		unmount();
	});
});

class RecoveryTransport {
	readonly getSessionCalls: string[] = [];
	readonly retiredSessionIds: string[] = [];
	readonly #invalidationListeners = new Set<ChatSessionInvalidationListener>();

	get invalidationListenerCount(): number {
		return this.#invalidationListeners.size;
	}

	async getSession(sessionId: string): Promise<ChatSession> {
		this.getSessionCalls.push(sessionId);
		return makeSession(sessionId);
	}

	retireSession(sessionId: string): void {
		this.retiredSessionIds.push(sessionId);
	}

	subscribeSessionInvalidations(listener: ChatSessionInvalidationListener): () => void {
		this.#invalidationListeners.add(listener);
		return () => {
			this.#invalidationListeners.delete(listener);
		};
	}

	async emitInvalidation(invalidation: ChatSessionInvalidation): Promise<void> {
		for (const listener of [...this.#invalidationListeners]) {
			await listener(invalidation);
		}
	}
}

function makeSession(sessionId: string): ChatSession {
	return {
		id: sessionId,
		title: sessionId,
		updatedAt: "2026-01-01T00:00:00.000Z",
		model: modelSelectionFor("gpt-5.4"),
		askMode: "Ask",
		messages: [],
	};
}

function createDeferred<T>() {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}
