import { runtimeInfoSchema } from "@moshu/contracts";
import Electrobun, { Electroview } from "electrobun/view";
import type { DesktopRpc } from "../../../shared/rpc";

const rpc = Electroview.defineRPC<DesktopRpc>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electroview = new Electrobun.Electroview({ rpc });

if (!electroview.rpc) {
	throw new Error("Electrobun RPC was not initialized.");
}

const request = electroview.rpc.request;

export const desktopClient = {
	async getRuntimeInfo() {
		return runtimeInfoSchema.parse(await request.getRuntimeInfo({}));
	},
};
