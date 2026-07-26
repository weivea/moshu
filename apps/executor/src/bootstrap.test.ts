import { describe, expect, test } from "bun:test";

import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	openBootstrapControlChannel,
	parseExecutorBootstrapRecord,
} from "./bootstrap";

const serverReady = {
	channel: BOOTSTRAP_CHANNEL,
	controlVersion: BOOTSTRAP_CONTROL_VERSION,
	type: "READY",
	role: "agents-server",
	pid: 101,
	processVersion: "0.0.1",
	nonce: "server-generation-1",
	endpoint: {
		host: "127.0.0.1",
		port: 42_101,
	},
} as const;

describe("executor bootstrap control", () => {
	test("consumes the agents-server READY record", () => {
		expect(
			parseExecutorBootstrapRecord(
				`${JSON.stringify({
					channel: BOOTSTRAP_CHANNEL,
					controlVersion: BOOTSTRAP_CONTROL_VERSION,
					type: "START",
					role: "executor",
					nonce: "executor-generation-1",
					agentsServer: serverReady,
				})}\n`,
			),
		).toEqual({
			channel: BOOTSTRAP_CHANNEL,
			controlVersion: BOOTSTRAP_CONTROL_VERSION,
			type: "START",
			role: "executor",
			nonce: "executor-generation-1",
			agentsServer: serverReady,
		});
	});

	test.each([
		["missing server bootstrap", undefined],
		["non-loopback host", { ...serverReady, endpoint: { host: "0.0.0.0", port: 42_101 } }],
		["invalid port", { ...serverReady, endpoint: { host: "127.0.0.1", port: 0 } }],
		["wrong record type", { ...serverReady, type: "START" }],
	])("rejects %s", (_name, agentsServer) => {
		expect(() =>
			parseExecutorBootstrapRecord(
				JSON.stringify({
					channel: BOOTSTRAP_CHANNEL,
					controlVersion: BOOTSTRAP_CONTROL_VERSION,
					type: "START",
					role: "executor",
					nonce: "executor-generation-1",
					agentsServer,
				}),
			),
		).toThrow("Invalid executor bootstrap");
	});

	test("keeps the parent channel open after parsing bootstrap", async () => {
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
					role: "executor",
					nonce: "executor-generation-1",
					agentsServer: serverReady,
				})}\n`,
			),
		);

		const channel = await openBootstrapControlChannel(stream);
		expect(parseExecutorBootstrapRecord(channel.input).nonce).toBe("executor-generation-1");
		controller?.close();
		await expect(channel.parentClosed).resolves.toBeUndefined();
	});
});
