import { BunSqliteSaver, createAskChatRuntime } from "@moshu/agent-runtime";
import { openAppDatabase } from "@moshu/database";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Updater, Utils } from "electrobun/bun";
import { logChatRpcDiagnostic } from "../shared/chat-rpc-diagnostics";
import { DesktopChatService } from "./chat-service";
import { FileAskProviderConfigStore } from "./file-provider-config-store";
import { createDesktopRpc } from "./rpc";

const DEV_SERVER_URL = "http://127.0.0.1:5173";

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();

	if (channel === "dev") {
		try {
			const response = await fetch(DEV_SERVER_URL, { method: "HEAD" });
			if (response.ok) {
				console.info(`Using Vite HMR server at ${DEV_SERVER_URL}`);
				return DEV_SERVER_URL;
			}
			console.info(`Vite HMR probe returned ${response.status}; using bundled assets.`);
		} catch (error) {
			console.info("Vite HMR server is unavailable; using bundled assets.", error);
		}
	}

	return "views://mainview/index.html";
}

mkdirSync(Utils.paths.userData, { recursive: true });
const database = openAppDatabase(join(Utils.paths.userData, "moshu.db"));
const checkpointSaver = new BunSqliteSaver(join(Utils.paths.userData, "moshu-checkpoints.db"));
const providerConfigStore = new FileAskProviderConfigStore(
	join(Utils.paths.userData, "provider.json"),
);
const chatRuntime = createAskChatRuntime({
	providerConfigStore,
	checkpointer: checkpointSaver,
});
const chatService = new DesktopChatService({
	repository: database.chat,
	providerConfigStore,
	runtime: chatRuntime,
});
const desktopRpc = createDesktopRpc({ chatService });
const unsubscribeChatEvents = chatService.subscribe((event) => {
	logChatRpcDiagnostic("bun", "send", "chatEvent", event);
	desktopRpc.send.chatEvent(event);
});

const mainWindow = new BrowserWindow({
	title: "墨枢",
	url: await getMainViewUrl(),
	rpc: desktopRpc,
	frame: {
		width: 1180,
		height: 760,
		x: 120,
		y: 80,
	},
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
	if (shutdownPromise !== undefined) {
		return shutdownPromise;
	}

	shutdownPromise = (async () => {
		unsubscribeChatEvents();
		try {
			await chatService.shutdown();
		} finally {
			try {
				checkpointSaver.close();
			} finally {
				database.close();
			}
		}
	})();
	return shutdownPromise;
}

mainWindow.on("close", () => {
	console.info("墨枢 main window closed.");
	void shutdown().catch((error: unknown) => {
		console.error("Failed to shut down the chat runtime cleanly.", error);
	});
});

console.info(`墨枢 started with Bun ${Bun.version}.`);
