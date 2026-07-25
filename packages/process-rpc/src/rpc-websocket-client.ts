import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type WebSocket from "ws";

export type RpcWebSocketRawData = WebSocket.RawData;

export interface RpcWebSocketClient extends WebSocket {
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

interface RpcWebSocketClientConstructor {
	new (
		address: null,
		protocols?: undefined,
		options?: {
			autoPong?: boolean;
			closeTimeout?: number;
		},
	): RpcWebSocketClient;
	readonly CLOSED: typeof WebSocket.CLOSED;
	readonly CLOSING: typeof WebSocket.CLOSING;
	readonly CONNECTING: typeof WebSocket.CONNECTING;
	readonly OPEN: typeof WebSocket.OPEN;
}

const require = createRequire(import.meta.url);

export const RpcWebSocketClient: RpcWebSocketClientConstructor = require("rpc-websocket-client");
