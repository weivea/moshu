import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	PROCESS_RPC_SCHEMA_VERSION,
	resolveRpcLimits,
	type RpcPeerIdentity,
} from "@moshu/process-rpc-core";
import { describe, expect, it } from "vitest";
import { completeMobileHandshake } from "../src/rpc/handshake";
import { NativeRpcConnection } from "../src/rpc/native-transport";
import { FakeTransport } from "./helpers";

const limits = resolveRpcLimits({ maxFrameBytes: 1_048_576, maxBufferedOutboundBytes: 1_048_576 });

const serverIdentity: RpcPeerIdentity = {
	role: "agents",
	peerId: "agents-1",
	instanceId: "ai-1",
	generation: 3,
};

function ackFrame(peer: RpcPeerIdentity, acceptedPeer: RpcPeerIdentity): string {
	return JSON.stringify({
		schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
		protocol: CURRENT_PROCESS_RPC_PROTOCOL,
		type: "hello-ack",
		connectionId: "conn-1",
		peer,
		acceptedPeer,
	});
}

describe("completeMobileHandshake identity (f1)", () => {
	it("sends a hello whose peer carries the deviceKeyId, and is accepted when the server echoes it", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.bind("conn-1");

		// The authenticated mobile identity MUST include deviceKeyId — the Layer 3 server compares it
		// against the WSS-upgrade identity and rejects the hello otherwise.
		const localIdentity: RpcPeerIdentity = {
			role: "mobile-client",
			peerId: "mobile-client-01",
			instanceId: "i-1",
			generation: 1,
			deviceKeyId: "device-key-01",
		};

		const promise = completeMobileHandshake({
			connection,
			localIdentity,
			expectedServerIdentity: serverIdentity,
			limits,
		});

		// The hello is sent synchronously inside the handshake; assert it carries deviceKeyId.
		const helloText = transport.sent.at(-1);
		expect(helloText).toBeDefined();
		const hello = JSON.parse(helloText as string) as { peer: RpcPeerIdentity };
		expect(hello.peer.deviceKeyId).toBe("device-key-01");

		// Server echoes the authenticated identity (with deviceKeyId) → handshake completes.
		transport.pushFrame({ connectionId: "conn-1", seq: 1, text: ackFrame(serverIdentity, localIdentity) });
		const peer = await promise;
		expect(peer).toBeTruthy();
	});

	it("rejects when the local identity omits deviceKeyId but the server accepted one (regression guard)", async () => {
		const transport = new FakeTransport();
		const connection = await NativeRpcConnection.create(transport);
		connection.bind("conn-1");

		// Simulate the pre-fix bug: hello without deviceKeyId. The server authenticated the device and
		// echoes acceptedPeer WITH deviceKeyId, so the ack no longer matches → identity mismatch.
		const localIdentity: RpcPeerIdentity = {
			role: "mobile-client",
			peerId: "mobile-client-01",
			instanceId: "i-1",
			generation: 1,
		};
		const authenticated: RpcPeerIdentity = { ...localIdentity, deviceKeyId: "device-key-01" };

		const promise = completeMobileHandshake({
			connection,
			localIdentity,
			expectedServerIdentity: serverIdentity,
			limits,
		});
		transport.pushFrame({ connectionId: "conn-1", seq: 1, text: ackFrame(serverIdentity, authenticated) });

		await expect(promise).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
	});
});
