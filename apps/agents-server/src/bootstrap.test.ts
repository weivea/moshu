import { describe, expect, test } from "bun:test";

import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	MAX_CONTROL_RECORD_BYTES,
	openBootstrapControlChannel,
	parseAgentsServerBootstrapRecord,
} from "./bootstrap";

describe("agents-server bootstrap control", () => {
	test("parses one valid START record", () => {
		expect(
			parseAgentsServerBootstrapRecord(
				`${JSON.stringify({
					channel: BOOTSTRAP_CHANNEL,
					controlVersion: BOOTSTRAP_CONTROL_VERSION,
					type: "START",
					role: "agents-server",
					nonce: "server-generation-1",
				})}\n`,
			),
		).toEqual({
			channel: BOOTSTRAP_CHANNEL,
			controlVersion: BOOTSTRAP_CONTROL_VERSION,
			type: "START",
			role: "agents-server",
			nonce: "server-generation-1",
		});
	});

	test.each([
		["invalid JSON", "not-json\n"],
		["multiple records", "{}\n{}\n"],
		[
			"wrong role",
			JSON.stringify({
				channel: BOOTSTRAP_CHANNEL,
				controlVersion: BOOTSTRAP_CONTROL_VERSION,
				type: "START",
				role: "executor",
				nonce: "server-generation-1",
			}),
		],
		[
			"short nonce",
			JSON.stringify({
				channel: BOOTSTRAP_CHANNEL,
				controlVersion: BOOTSTRAP_CONTROL_VERSION,
				type: "START",
				role: "agents-server",
				nonce: "short",
			}),
		],
	])("rejects %s", (_name, input) => {
		expect(() => parseAgentsServerBootstrapRecord(input)).toThrow();
	});

	test("rejects an oversized piped record before decoding it", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_CONTROL_RECORD_BYTES + 1));
				controller.close();
			},
		});

		await expect(openBootstrapControlChannel(stream)).rejects.toThrow("byte limit");
	});

	test("parses before EOF and reports parent channel closure", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		controller?.enqueue(
			new TextEncoder().encode(
				`${JSON.stringify({
					channel: BOOTSTRAP_CHANNEL,
					controlVersion: BOOTSTRAP_CONTROL_VERSION,
					type: "START",
					role: "agents-server",
					nonce: "server-generation-1",
				})}\n`,
			),
		);

		const channel = await openBootstrapControlChannel(stream);
		expect(parseAgentsServerBootstrapRecord(channel.input).nonce).toBe("server-generation-1");
		controller?.close();
		await expect(channel.parentClosed).resolves.toBeUndefined();
	});
});
