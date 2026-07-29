import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	openBootstrapControlChannel,
	parseRuntimeBoxBootstrapRecord,
} from "./bootstrap";

const validRecord = {
	channel: BOOTSTRAP_CHANNEL,
	controlVersion: BOOTSTRAP_CONTROL_VERSION,
	type: "START",
	role: "runtime-box",
	nonce: "runtime-box-generation-1",
	identity: {
		role: "runtime-box",
		peerId: "moshu-local-runtime-box",
		instanceId: "runtime-box-1",
		generation: 1,
	},
	credential: Buffer.alloc(32, 8).toString("base64url"),
	dataDirectory: "/tmp/moshu-runtime-box-test",
	actionJournalEpoch: "550e8400-e29b-41d4-a716-446655440099",
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
			path: "/runtime",
		},
	},
} as const;

describe("Runtime Box bootstrap control", () => {
	test("parses the authenticated agents-server binding", () => {
		expect(parseRuntimeBoxBootstrapRecord(`${JSON.stringify(validRecord)}\n`)).toEqual(validRecord);
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
		expect(() => parseRuntimeBoxBootstrapRecord(JSON.stringify(record))).toThrow();
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
		expect(parseRuntimeBoxBootstrapRecord(channel.input)).toEqual(validRecord);
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
