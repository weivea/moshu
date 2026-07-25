import { probeAgentRuntime } from "@moshu/agent-runtime";
import { emptyParamsSchema, runtimeInfoSchema } from "@moshu/contracts";
import { BrowserView, Updater } from "electrobun/bun";
import type { DesktopRpc } from "../shared/rpc";

export const desktopRpc = BrowserView.defineRPC<DesktopRpc>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			getRuntimeInfo: async (params) => {
				emptyParamsSchema.parse(params);

				return runtimeInfoSchema.parse({
					apiVersion: 1,
					appName: "墨枢",
					appVersion: "0.0.1",
					channel: await Updater.localInfo.channel(),
					electrobunVersion: "1.18.1",
					bunVersion: Bun.version,
					platform: process.platform,
					arch: process.arch,
					deepAgents: probeAgentRuntime(),
				});
			},
		},
		messages: {},
	},
});
