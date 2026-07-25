import type { EmptyParams, RuntimeInfo } from "@moshu/contracts";
import type { RPCSchema } from "electrobun/bun";

type EmptyRpcMap = Record<never, never>;

export type DesktopRpc = {
	bun: RPCSchema<{
		requests: {
			getRuntimeInfo: {
				params: EmptyParams;
				response: RuntimeInfo;
			};
		};
		messages: EmptyRpcMap;
	}>;
	webview: RPCSchema<{
		requests: EmptyRpcMap;
		messages: EmptyRpcMap;
	}>;
};
