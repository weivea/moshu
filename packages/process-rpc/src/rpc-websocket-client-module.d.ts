declare module "rpc-websocket-client" {
	import type { Duplex } from "node:stream";
	import WebSocket from "ws";

	export default class RpcWebSocketImplementation extends WebSocket {
		_isServer: boolean;
		setSocket(
			socket: Duplex,
			head: Buffer,
			options: {
				allowSynchronousEvents: boolean;
				generateMask?: undefined;
				maxBufferedChunks: number;
				maxFragments: number;
				maxPayload: number;
				skipUTF8Validation: boolean;
			},
		): void;
	}
}
