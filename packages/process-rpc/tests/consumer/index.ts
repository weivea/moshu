import {
	type ConnectRpcClientOptions,
	connectRpcClient,
	createRpcServer,
	MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_TIMER_MS,
	MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES,
	MIN_RPC_FRAME_BYTES,
	type RpcPeer,
	type RpcPeerIdentity,
	type RpcServerOptions,
} from "@moshu/process-rpc";

const clientIdentity: RpcPeerIdentity = {
	role: "client",
	peerId: "consumer-client",
	instanceId: "consumer-instance",
	generation: 1,
};

export const clientOptions = {
	url: "ws://127.0.0.1:1234/rpc",
	identity: clientIdentity,
	getHandshakeHeaders: () => ({
		authorization: "Bearer consumer-fixture-credential",
	}),
	limits: {
		maxFrameBytes: MAX_RPC_FRAME_BYTES,
		maxBufferedOutboundBytes: MAX_RPC_FRAME_BYTES,
		maxConcurrentEvents: 8,
	},
} satisfies ConnectRpcClientOptions;

export const serverOptions = {
	identity: {
		role: "agents",
		peerId: "consumer-agents",
		instanceId: "consumer-agents-instance",
		generation: 1,
	},
	acceptedPeerRoles: ["client"],
	authenticate: () => clientIdentity,
	limits: {
		maxConcurrentEvents: 8,
	},
	handlers: {
		events: {
			"consumer.event": (_payload, context) => {
				void context.signal;
			},
		},
	},
	methodAllowlist: {
		client: { events: ["consumer.event"] },
	},
} satisfies RpcServerOptions;

export function usePublicApi(peer: RpcPeer): void {
	void peer.closed;
	void MIN_RPC_FRAME_BYTES;
	void MIN_RPC_BOOTSTRAP_CREDENTIAL_BYTES;
	void MAX_RPC_BOOTSTRAP_CREDENTIAL_BYTES;
	void MAX_RPC_TIMER_MS;
	void connectRpcClient;
	void createRpcServer;
}
