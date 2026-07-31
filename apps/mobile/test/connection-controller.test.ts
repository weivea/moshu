import type { RpcPeer } from "@moshu/process-rpc-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionController } from "../src/rpc/connection-controller";
import { FakeTransport, makeBinding } from "./helpers";

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
});
