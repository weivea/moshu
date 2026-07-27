import { desktopClient } from "../../lib/rpc";
import { createPreviewChatTransport } from "./preview-transport";
import { createRpcChatTransport } from "./rpc-transport";

const isStandaloneBrowserPreview =
	import.meta.env.DEV && typeof window !== "undefined" && !("__electrobun" in window);

export const chatTransport = isStandaloneBrowserPreview
	? createPreviewChatTransport()
	: createRpcChatTransport(desktopClient);
