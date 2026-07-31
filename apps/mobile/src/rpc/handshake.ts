import {
	CURRENT_PROCESS_RPC_PROTOCOL,
	isSameRpcPeerIdentity,
	PROCESS_RPC_SCHEMA_VERSION,
	type ResolvedRpcLimits,
	RpcHandshakeError,
	type RpcHandlers,
	type RpcHelloEnvelope,
	type RpcMethodAllowlist,
	RpcPeer,
	type RpcPeerIdentity,
	type RpcProtocolErrorCode,
	rpcHelloAckEnvelopeSchema,
	rpcProtocolErrorEnvelopeSchema,
} from "@moshu/process-rpc-core";
import type { NativeRpcConnection } from "./native-transport";

export interface MobileHandshakeOptions {
	readonly connection: NativeRpcConnection;
	readonly localIdentity: RpcPeerIdentity;
	readonly expectedServerIdentity: RpcPeerIdentity;
	readonly limits: ResolvedRpcLimits;
	readonly handlers?: RpcHandlers;
	readonly methodAllowlist?: RpcMethodAllowlist;
	readonly onClose?: (info: { code: number; reason: string }) => void;
}

/**
 * Browser-safe re-implementation of the process-rpc hello/hello-ack handshake for the Mobile
 * client. The native transport already carries an *authenticated* socket (device-signed WSS
 * upgrade); this JS layer only negotiates the process-rpc session and pins the Agent Server
 * identity the native challenge already verified. Any mismatch rejects and closes — never a silent
 * downgrade or auto re-pin.
 */
export function completeMobileHandshake(options: MobileHandshakeOptions): Promise<RpcPeer> {
	const { connection, localIdentity, expectedServerIdentity, limits } = options;
	const protocol = CURRENT_PROCESS_RPC_PROTOCOL;

	return new Promise<RpcPeer>((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			fail("HANDSHAKE_TIMEOUT", "Timed out waiting for the hello acknowledgement.");
		}, limits.handshakeTimeoutMs);

		const cleanup = (): void => {
			clearTimeout(timer);
			connection.setFrameSink(null);
			connection.setCloseSink(null);
		};

		function fail(code: RpcProtocolErrorCode, message: string): void {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			connection.close(1002, "Handshake failed.");
			reject(new RpcHandshakeError(code, message));
		}

		connection.setCloseSink((code, reason) => {
			fail("INTERNAL_ERROR", `Connection closed during handshake (${code}): ${reason}`);
		});

		connection.setFrameSink((text) => {
			if (settled) {
				return;
			}
			let decoded: unknown;
			try {
				decoded = JSON.parse(text);
			} catch {
				fail("MALFORMED_FRAME", "Handshake response was not valid JSON.");
				return;
			}

			const protocolError = rpcProtocolErrorEnvelopeSchema.safeParse(decoded);
			if (protocolError.success) {
				fail(protocolError.data.code, protocolError.data.message);
				return;
			}

			const ack = rpcHelloAckEnvelopeSchema.safeParse(decoded);
			if (!ack.success) {
				fail("MALFORMED_FRAME", "Handshake response was not a valid hello-ack envelope.");
				return;
			}
			if (
				ack.data.protocol.major !== protocol.major ||
				ack.data.protocol.minor > protocol.minor
			) {
				fail("UNSUPPORTED_PROTOCOL", "Server selected an incompatible protocol version.");
				return;
			}
			if (!isSameRpcPeerIdentity(ack.data.acceptedPeer, localIdentity)) {
				fail("IDENTITY_MISMATCH", "Server acknowledgement did not echo the client identity.");
				return;
			}
			if (!isSameRpcPeerIdentity(ack.data.peer, expectedServerIdentity)) {
				fail("IDENTITY_MISMATCH", "Server identity did not match the expected peer.");
				return;
			}

			settled = true;
			clearTimeout(timer);
			const peer = new RpcPeer({
				localIdentity,
				remoteIdentity: ack.data.peer,
				protocol: ack.data.protocol,
				resolvedLimits: limits,
				transport: connection,
				handlers: options.handlers,
				methodAllowlist: options.methodAllowlist,
				onClose: options.onClose ? (info) => options.onClose?.(info) : undefined,
			});
			connection.attachPeer(peer);
			resolve(peer);
		});

		const hello: RpcHelloEnvelope = {
			schemaVersion: PROCESS_RPC_SCHEMA_VERSION,
			protocol,
			type: "hello",
			peer: localIdentity,
		};
		try {
			connection.send(JSON.stringify(hello));
		} catch (error) {
			fail("INTERNAL_ERROR", error instanceof Error ? error.message : "Failed to send hello.");
		}
	});
}
