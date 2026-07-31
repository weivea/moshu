import type { RpcPeer } from "@moshu/process-rpc-core";
import { RpcHandshakeError } from "@moshu/process-rpc-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionController } from "../src/rpc/connection-controller";
import { FakeTransport, makeBinding, makeConnectResult } from "./helpers";

function codedError(code: string): Error {
	const error = new Error(code);
	(error as unknown as { code: string }).code = code;
	return error;
}

/** A fake handshake that resolves a stub peer and captures the controller's onClose callback. */
function fakeHandshake() {
	const captured: { onClose?: (info: { code: number; reason: string }) => void } = {};
	const peer = {
		isClosed: false,
		close: vi.fn(),
		request: vi.fn(async () => ({})),
	} as unknown as RpcPeer;
	const handshake = async (options: {
		onClose?: (info: { code: number; reason: string }) => void;
	}): Promise<RpcPeer> => {
		captured.onClose = options.onClose;
		return peer;
	};
	return { handshake, captured, peer };
}

const controllers: ConnectionController[] = [];
function makeController(transport: FakeTransport, handshake: unknown): ConnectionController {
	const controller = new ConnectionController({
		transport,
		handshake: handshake as never,
		reconnectDelayMs: 1_000_000,
		pollIntervalMs: 1_000_000,
	});
	controllers.push(controller);
	return controller;
}

afterEach(async () => {
	vi.useRealTimers();
	for (const controller of controllers.splice(0)) {
		await controller.dispose();
	}
});

describe("ConnectionController", () => {
	it("reports unpaired when the device has no binding", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "unpaired" };
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("unpaired");
	});

	it("connects to the single existing binding and exposes a client only when connected", async () => {
		const transport = new FakeTransport();
		const binding = makeBinding();
		transport.status = { state: "paired", binding };
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();

		const state = controller.getState();
		expect(state.kind).toBe("connected");
		expect(state.kind === "connected" && state.client).toBeTruthy();
	});

	it("clears the business client on disconnect (no cached state exposed offline)", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		// Simulate the authenticated socket dropping.
		captured.onClose?.({ code: 1006, reason: "socket closed" });
		await Promise.resolve();
		await Promise.resolve();

		const state = controller.getState();
		expect(state.kind).not.toBe("connected");
		// The union guarantees non-connected states carry no client — assert it structurally too.
		expect("client" in state).toBe(false);
	});

	it("treats a server-side revocation (now unpaired) as a fatal auth-revoked state", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();

		// The socket drops AND the binding is gone on re-check → not a transient reconnect.
		transport.status = { state: "unpaired" };
		captured.onClose?.({ code: 4401, reason: "revoked" });
		await Promise.resolve();
		await Promise.resolve();

		const state = controller.getState();
		expect(state.kind).toBe("error");
		expect(state.kind === "error" && state.code).toBe("auth-revoked");
	});

	it("maps a native fatal connect rejection to an un-retriable error state", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		transport.connectResult = codedError("PROTOCOL_MISMATCH");
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();

		const state = controller.getState();
		expect(state.kind).toBe("error");
		expect(state.kind === "error" && state.code).toBe("protocol-mismatch");
	});

	it("treats a real handshake UNSUPPORTED_PROTOCOL error as fatal and never reconnects", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		// The native socket upgrades fine, but the JS process-rpc handshake rejects because the server
		// negotiated an incompatible protocol version — exactly what completeMobileHandshake throws.
		const handshake = async (): Promise<RpcPeer> => {
			throw new RpcHandshakeError(
				"UNSUPPORTED_PROTOCOL",
				"Server selected an incompatible protocol version.",
			);
		};
		const controller = new ConnectionController({
			transport,
			handshake: handshake as never,
			reconnectDelayMs: 100,
			reconnectJitterRatio: 0,
			random: () => 0,
			pollIntervalMs: 1_000_000,
		});
		controllers.push(controller);

		await controller.init();
		const state = controller.getState();
		expect(state.kind).toBe("error");
		expect(state.kind === "error" && state.code).toBe("protocol-mismatch");

		// A protocol mismatch is permanent: no bounded-backoff reconnect may be scheduled, even after
		// the reconnect delay elapses many times over.
		const connectSpy = vi.spyOn(transport, "connect");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connectSpy).not.toHaveBeenCalled();
		expect(controller.getState().kind).toBe("error");
	});

	it("goes offline (not fatal) on a transient connect failure", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		transport.connectResult = new Error("network down");
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("offline");
	});

	it("runs the pairing happy path: claiming → waiting → approved → connected", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "unpaired" };
		const binding = makeBinding();
		transport.pollQueue = [{ status: "approved", binding }];
		const { handshake } = fakeHandshake();
		const controller = new ConnectionController({
			transport,
			handshake: handshake as never,
			reconnectDelayMs: 1_000_000,
			pollIntervalMs: 1,
		});
		controllers.push(controller);

		await controller.beginPairing("moshu://pair?...redacted...");
		expect(controller.getState().kind).toBe("waiting");

		// Let the scheduled poll fire; it reads "approved" and connects.
		await vi.waitFor(() => {
			expect(controller.getState().kind).toBe("connected");
		});
	});

	it("rejects pairing when the server rejects the claim", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "unpaired" };
		transport.pollQueue = [{ status: "rejected" }];
		const { handshake } = fakeHandshake();
		const controller = new ConnectionController({
			transport,
			handshake: handshake as never,
			reconnectDelayMs: 1_000_000,
			pollIntervalMs: 1,
		});
		controllers.push(controller);

		await controller.beginPairing("moshu://pair?...redacted...");
		await vi.waitFor(() => {
			const state = controller.getState();
			expect(state.kind).toBe("error");
			expect(state.kind === "error" && state.code).toBe("pairing-rejected");
		});
	});

	it("unpairs: clears the binding and returns to unpaired", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		await controller.unpair();
		expect(transport.unpairCalls).toBe(1);
		expect(controller.getState().kind).toBe("unpaired");
	});

	it("maps a fatal WS close (AUTH_REVOKED) to auth-revoked without a blind retry, even while still paired", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		// The native layer captured a WS 1008 close and classified it AUTH_REVOKED. The binding is
		// still present (server hasn't been re-polled), so the ONLY signal is the fatalReason.
		transport.pushState({
			connectionId: "conn-1",
			state: "closed",
			code: 1008,
			reason: "revoked",
			fatalReason: "AUTH_REVOKED",
		});
		captured.onClose?.({ code: 1008, reason: "revoked" });
		await Promise.resolve();
		await Promise.resolve();

		const state = controller.getState();
		expect(state.kind).toBe("error");
		expect(state.kind === "error" && state.code).toBe("auth-revoked");
		// No getStatus-driven reconnect was scheduled: the state stays fatal.
		expect("client" in state).toBe(false);
	});

	it("maps a fatal WS close (AUTH_FAILED) to a fatal auth-failed state", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();

		transport.pushState({
			connectionId: "conn-1",
			state: "closed",
			code: 1008,
			reason: "auth failed",
			fatalReason: "AUTH_FAILED",
		});
		captured.onClose?.({ code: 1008, reason: "auth failed" });
		await Promise.resolve();
		await Promise.resolve();

		const state = controller.getState();
		expect(state.kind).toBe("error");
		expect(state.kind === "error" && state.code).toBe("auth-failed");
	});

	it("disposes the provisional connection on every failed attempt so listeners do not leak", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		transport.connectResult = new Error("network down");
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);

		await controller.init();
		expect(controller.getState().kind).toBe("offline");
		// Retry several more times; each failed attempt must remove the frame+state listeners it added.
		for (let i = 0; i < 5; i += 1) {
			await controller.retry();
		}
		expect(transport.activeFrameListenerCount).toBe(0);
		expect(transport.activeStateListenerCount).toBe(0);
	});

	it("re-snapshots a surviving socket on foreground without tearing it down or reconnecting", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, peer } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		// Record every state the UI observes so we can prove a fresh `connected` is re-emitted (which
		// drives the attention/session resnapshot) — not a teardown or reconnect.
		const seen: string[] = [];
		controller.subscribe((state) => seen.push(state.kind));
		const connectSpy = vi.spyOn(transport, "connect");

		// The whole background window elapses with the socket still alive, then we return to foreground.
		controller.onAppBackground();
		await controller.onAppActive();

		// A brand-new `connected` state is emitted (subscribers re-snapshot), but the exact live socket
		// is untouched and no reconnect is attempted.
		expect(seen).toEqual(["connected"]);
		expect(controller.getState().kind).toBe("connected");
		expect(connectSpy).not.toHaveBeenCalled();
		expect(peer.close).not.toHaveBeenCalled();
	});

	it("does not re-snapshot on a spurious foreground that was never preceded by a background", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		const seen: string[] = [];
		controller.subscribe((state) => seen.push(state.kind));
		// No preceding onAppBackground → nothing to resnapshot; avoid a redundant refresh storm.
		await controller.onAppActive();
		expect(seen).toEqual([]);
	});

	// --- Layer 5 lifecycle / reconnect -------------------------------------

	it("does not open or schedule a reconnect while backgrounded (no fake keep-alive)", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		const connectSpy = vi.spyOn(transport, "connect");
		// Enter the background, then the live socket drops. We must NOT start a new connection.
		controller.onAppBackground();
		captured.onClose?.({ code: 1006, reason: "socket closed" });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(connectSpy).not.toHaveBeenCalled();
		expect(controller.getState().kind).not.toBe("connected");
	});

	it("goes offline (no reconnect) when the socket closes while backgrounded, then reconnects on foreground", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, captured } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		// The App is backgrounded; the OS then reclaims the short window and the NATIVE engine closes
		// the exact active socket (surfacing to JS as a plain, non-fatal close). We must transition to
		// offline WITHOUT arming a reconnect — never a misleading "reconnecting" while off-foreground.
		const connectSpy = vi.spyOn(transport, "connect");
		controller.onAppBackground();
		captured.onClose?.({ code: 1001, reason: "background-expired" });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.getState().kind).toBe("offline");
		expect(connectSpy).not.toHaveBeenCalled();

		// Foreground re-entry makes exactly one immediate attempt and reconnects (which re-snapshots the
		// durable attention feed at the layer above).
		await controller.onAppActive();
		expect(connectSpy).toHaveBeenCalledTimes(1);
		expect(controller.getState().kind).toBe("connected");
	});

	it("reconnects with bounded exponential backoff and resets after a stable connection", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		transport.connectResult = new Error("down");
		const { handshake } = fakeHandshake();
		const controller = new ConnectionController({
			transport,
			handshake: handshake as never,
			reconnectDelayMs: 100,
			reconnectMaxDelayMs: 10_000,
			reconnectJitterRatio: 0,
			random: () => 0,
			pollIntervalMs: 1_000_000,
		});
		controllers.push(controller);

		await controller.init(); // fails → offline, schedules first retry at 100ms
		const connectSpy = vi.spyOn(transport, "connect");

		await vi.advanceTimersByTimeAsync(99);
		expect(connectSpy).toHaveBeenCalledTimes(0);
		await vi.advanceTimersByTimeAsync(1); // 100ms: first retry (fails) → next at 200ms
		expect(connectSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(199);
		expect(connectSpy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); // 200ms after: second retry (fails) → next at 400ms
		expect(connectSpy).toHaveBeenCalledTimes(2);

		// Let the next attempt succeed; the backoff must reset so a later drop retries promptly.
		transport.connectResult = makeConnectResult();
		await vi.advanceTimersByTimeAsync(400); // 400ms backoff: third retry succeeds
		expect(connectSpy).toHaveBeenCalledTimes(3);
		expect(controller.getState().kind).toBe("connected");
	});

	it("onAppActive retries immediately (fresh backoff) instead of waiting out the timer", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		transport.connectResult = new Error("down");
		const { handshake } = fakeHandshake();
		const controller = makeController(transport, handshake); // reconnectDelayMs 1_000_000
		await controller.init();
		expect(controller.getState().kind).toBe("offline");

		transport.connectResult = makeConnectResult();
		const connectSpy = vi.spyOn(transport, "connect");
		await controller.onAppActive();

		expect(connectSpy).toHaveBeenCalledTimes(1);
		expect(controller.getState().kind).toBe("connected");
	});

	it("onAppBackgroundExpired tears down the socket and goes offline without reconnecting", async () => {
		const transport = new FakeTransport();
		transport.status = { state: "paired", binding: makeBinding() };
		const { handshake, peer } = fakeHandshake();
		const controller = makeController(transport, handshake);
		await controller.init();
		expect(controller.getState().kind).toBe("connected");

		const connectSpy = vi.spyOn(transport, "connect");
		await controller.onAppBackgroundExpired();

		expect(peer.close).toHaveBeenCalled();
		expect(controller.getState().kind).toBe("offline");
		expect(connectSpy).not.toHaveBeenCalled();
	});
});
