import { describe, expect, it } from "vitest";
import { NativeRpcConnection } from "../src/rpc/native-transport";
import { FakeTransport } from "./helpers";

describe("NativeRpcConnection frame discipline", () => {
	it("buffers frames received before bind, then flushes them in order", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		const frames: string[] = [];
		connection.setFrameSink((text) => frames.push(text));

		// Frames can arrive between connect() resolving natively and JS calling bind().
		transport.pushFrame({ connectionId: "conn-1", seq: 1, text: "a" });
		transport.pushFrame({ connectionId: "conn-1", seq: 2, text: "b" });
		expect(frames).toEqual([]);

		connection.bind("conn-1");
		expect(frames).toEqual(["a", "b"]);
	});

	it("drops frames from a stale connection id and non-monotonic sequences", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		const frames: string[] = [];
		connection.setFrameSink((text) => frames.push(text));
		connection.bind("conn-2");

		transport.pushFrame({ connectionId: "conn-2", seq: 1, text: "keep" });
		transport.pushFrame({ connectionId: "conn-OLD", seq: 2, text: "stale-connection" });
		transport.pushFrame({ connectionId: "conn-2", seq: 1, text: "replayed-seq" });
		transport.pushFrame({ connectionId: "conn-2", seq: 2, text: "next" });

		expect(frames).toEqual(["keep", "next"]);
	});

	it("routes a close for the bound connection to the close sink exactly once", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		const closes: { code: number; reason: string }[] = [];
		connection.setCloseSink((code, reason) => closes.push({ code, reason }));
		connection.bind("conn-3");

		transport.pushState({ connectionId: "conn-OLD", state: "closed", code: 1000, reason: "old" });
		expect(closes).toEqual([]);

		transport.pushState({ connectionId: "conn-3", state: "closed", code: 1006, reason: "gone" });
		transport.pushState({ connectionId: "conn-3", state: "closed", code: 1006, reason: "again" });
		expect(closes).toEqual([{ code: 1006, reason: "gone" }]);
		expect(connection.isOpen()).toBe(false);
	});

	it("holds a pre-bind close until the matching connection id is bound", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		const closes: number[] = [];
		connection.setCloseSink((code) => closes.push(code));

		transport.pushState({ connectionId: "conn-4", state: "closed", code: 1011, reason: "early" });
		expect(closes).toEqual([]);
		connection.bind("conn-4");
		expect(closes).toEqual([1011]);
	});

	it("fails closed when the pre-bind frame buffer overflows its count bound", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.setFrameSink(() => {});

		// Flood frames before bind(); after the 64-frame bound is exceeded the socket is closed 1009.
		for (let seq = 1; seq <= 65; seq += 1) {
			transport.pushFrame({ connectionId: "conn-1", seq, text: "x" });
		}

		expect(connection.isOpen()).toBe(false);
		expect(transport.closeArgs.some((c) => c.code === 1009)).toBe(true);
	});

	it("buffers a legal large frame (1 MiB < size <= 4 MiB) that the old 1 MiB bound wrongly dropped", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		const frames: string[] = [];
		connection.setFrameSink((text) => frames.push(text));

		// 1.5 MiB frame: over the previous 1 MiB pre-bind cap but well within the 4 MiB Product-RPC
		// limit, so it must be buffered (not fail-closed) until bind() flushes it.
		const bigFrame = "x".repeat(1_572_864);
		transport.pushFrame({ connectionId: "conn-1", seq: 1, text: bigFrame });
		// Not fail-closed: no close was issued and nothing was dropped.
		expect(transport.closeArgs).toEqual([]);
		expect(frames).toEqual([]);

		connection.bind("conn-1");
		expect(connection.isOpen()).toBe(true);
		expect(frames).toEqual([bigFrame]);
	});

	it("fails closed when a single pre-bind frame exceeds the 4 MiB per-frame cap", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.setFrameSink(() => {});

		// One frame just over the 4 MiB Product-RPC per-frame limit → protocol-close, don't buffer.
		transport.pushFrame({ connectionId: "conn-1", seq: 1, text: "x".repeat(4 * 1024 * 1024 + 1) });

		expect(transport.closeArgs.some((c) => c.code === 1009)).toBe(true);
		// Even once the id is bound the connection stays closed.
		connection.bind("conn-1");
		expect(connection.isOpen()).toBe(false);
	});

	it("captures a fatal close reason so the controller can stop retrying", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.setCloseSink(() => {});
		connection.bind("conn-1");

		transport.pushState({
			connectionId: "conn-1",
			state: "closed",
			code: 1008,
			reason: "revoked",
			fatalReason: "AUTH_REVOKED",
		});
		expect(connection.fatalReason).toBe("AUTH_REVOKED");
	});

	it("closes the native socket and removes listeners on dispose", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.bind("conn-1");
		expect(transport.activeFrameListenerCount).toBe(1);
		expect(transport.activeStateListenerCount).toBe(1);

		await connection.dispose();

		expect(transport.activeFrameListenerCount).toBe(0);
		expect(transport.activeStateListenerCount).toBe(0);
		expect(transport.closeArgs.some((c) => c.connectionId === "conn-1")).toBe(true);
	});
});
