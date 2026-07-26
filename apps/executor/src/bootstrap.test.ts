import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	openBootstrapControlChannel,
	parseExecutorBootstrapRecord,
} from "./bootstrap";

const validRecord = {
	channel: BOOTSTRAP_CHANNEL,
	controlVersion: BOOTSTRAP_CONTROL_VERSION,
	type: "START",
	role: "executor",
	nonce: "executor-generation-1",
	identity: {
		role: "executor",
		peerId: "moshu-local-executor",
		instanceId: "executor-1",
		generation: 1,
	},
	credential: Buffer.alloc(32, 8).toString("base64url"),
	agentsServer: {
		identity: {
			role: "agents",
			peerId: "moshu-local-agents",
			instanceId: "agents-1",
			generation: 1,
		},
		endpoint: {
			host: "127.0.0.1",
			port: 42_101,
			path: "/rpc",
		},
	},
} as const;

describe("executor bootstrap control", () => {
	test("parses the authenticated agents-server binding", () => {
		expect(parseExecutorBootstrapRecord(`${JSON.stringify(validRecord)}\n`)).toEqual(validRecord);
	});

	test.each([
		["missing server bootstrap", { ...validRecord, agentsServer: undefined }],
		[
			"non-loopback host",
			{
				...validRecord,
				agentsServer: {
					...validRecord.agentsServer,
					endpoint: { ...validRecord.agentsServer.endpoint, host: "0.0.0.0" },
				},
			},
		],
		["invalid credential", { ...validRecord, credential: "not-a-credential" }],
	])("rejects %s", (_name, record) => {
		expect(() => parseExecutorBootstrapRecord(JSON.stringify(record))).toThrow();
	});

	test("keeps the parent channel open after parsing bootstrap", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(validRecord)}\n`));
		const channel = await openBootstrapControlChannel(stream);
		expect(parseExecutorBootstrapRecord(channel.input)).toEqual(validRecord);
		controller?.close();
		await expect(channel.parentClosed).resolves.toBeUndefined();
	});

	test("cancels the pending parent reader and releases the monitor", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let cancelCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
			cancel() {
				cancelCalls += 1;
			},
		});
		controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(validRecord)}\n`));
		const channel = await openBootstrapControlChannel(stream);

		await channel.cancelParentMonitor();
		await channel.cancelParentMonitor();
		await expect(channel.parentClosed).resolves.toBeUndefined();
		expect(cancelCalls).toBe(1);
	});

	test("aborts a pending bootstrap read and removes its signal listener", async () => {
		let cancelCalls = 0;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelCalls += 1;
			},
		});
		const controller = new AbortController();
		const opening = openBootstrapControlChannel(stream, controller.signal);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

		controller.abort(new Error("SIGTERM"));
		await expect(opening).rejects.toThrow("SIGTERM");
		expect(cancelCalls).toBe(1);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
