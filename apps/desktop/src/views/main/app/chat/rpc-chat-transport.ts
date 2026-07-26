import { desktopClient } from "../../lib/rpc";
import { createRpcChatTransport } from "./rpc-transport";

export const chatTransport = createRpcChatTransport(desktopClient);
