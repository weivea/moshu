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
});
