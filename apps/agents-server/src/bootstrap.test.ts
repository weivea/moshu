import { describe, expect, test } from "bun:test";
import type { AgentsServerBootstrapRecord } from "@moshu/contracts";

import {
	BOOTSTRAP_CHANNEL,
	BOOTSTRAP_CONTROL_VERSION,
	MAX_CONTROL_RECORD_BYTES,
	openBootstrapControlChannel,
	parseAgentsServerBootstrapRecord,
} from "./bootstrap";

const credential = Buffer.alloc(32, 7).toString("base64url");
const validRecord: AgentsServerBootstrapRecord = {
	channel: BOOTSTRAP_CHANNEL,
	controlVersion: BOOTSTRAP_CONTROL_VERSION,
	type: "START",
	role: "agents-server",
	nonce: "server-generation-1",
	serverIdentity: {
		role: "agents",
		peerId: "moshu-local-agents",
		instanceId: "agents-1",
		generation: 1,
	},
	peerBindings: [
		{
			credential,
			identity: {
				role: "client",
				peerId: "moshu-desktop-client",
				instanceId: "client-1",
				generation: 1,
			},
		},
		{
			credential: Buffer.alloc(32, 8).toString("base64url"),
			identity: {
				role: "executor",
				peerId: "moshu-local-executor",
				instanceId: "executor-1",
				generation: 1,
			},
		},
	],
	paths: {
		productDatabase: "/tmp/moshu.db",
		checkpointDatabase: "/tmp/moshu-checkpoints.db",
		providerConfig: "/tmp/provider.json",
	},
};

describe("agents-server bootstrap control", () => {
	test("parses a bounded authenticated START record", () => {
		expect(parseAgentsServerBootstrapRecord(`${JSON.stringify(validRecord)}\n`)).toEqual(
			validRecord,
		);
	});

	test.each([
		["invalid JSON", "not-json\n"],
		["multiple records", "{}\n{}\n"],
		["wrong role", JSON.stringify({ ...validRecord, role: "executor" })],
		["missing peer bindings", JSON.stringify({ ...validRecord, peerBindings: [] })],
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

	test("reports parent channel closure after bootstrap", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(validRecord)}\n`));
		const channel = await openBootstrapControlChannel(stream);
		expect(parseAgentsServerBootstrapRecord(channel.input)).toEqual(validRecord);
		controller?.close();
		await expect(channel.parentClosed).resolves.toBeUndefined();
	});
});
