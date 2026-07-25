import { BunSqliteSaver, createAskChatRuntime } from "@moshu/agent-runtime";
import { openAppDatabase } from "@moshu/database";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Electrobun, { BrowserWindow, Updater, Utils } from "electrobun/bun";
import { logChatRpcDiagnostic } from "../shared/chat-rpc-diagnostics";
import { DesktopChatService } from "./chat-service";
import { startCompanionPocIfEnabled } from "./companion-poc";
import { createDesktopShutdownCoordinator } from "./desktop-lifecycle";
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
	sessions: database.sessions,
	runs: database.runs,
	providerConfigStore,
	runtime: chatRuntime,
});
const desktopRpc = createDesktopRpc({ chatService });
const unsubscribeChatEvents = chatService.subscribe((event) => {
	logChatRpcDiagnostic("bun", "send", "chatEvent", event);
	desktopRpc.send.chatEvent(event);
});

let shutdownStarted = false;
let companionSupervisor: Awaited<ReturnType<typeof startCompanionPocIfEnabled>>;
let companionStartupPromise: ReturnType<typeof startCompanionPocIfEnabled> =
	Promise.resolve(undefined);
const shutdownCoordinator = createDesktopShutdownCoordinator({
	async cleanup() {
		shutdownStarted = true;
		unsubscribeChatEvents();
		try {
			await chatService.shutdown();
		} finally {
			try {
				try {
					await companionSupervisor?.shutdown();
				} finally {
					await companionStartupPromise;
				}
			} finally {
				try {
					checkpointSaver.close();
				} finally {
					database.close();
				}
			}
		}
	},
	quit() {
		Utils.quit();
	},
	reportError(error) {
		console.error("Failed to shut down the desktop runtime cleanly.", error);
	},
});
Electrobun.events.on("before-quit", (event) => {
	shutdownCoordinator.handleBeforeQuit(event);
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

mainWindow.on("close", () => {
	console.info("墨枢 main window closed.");
	shutdownCoordinator.handleWindowClose();
});

companionStartupPromise = startCompanionPocIfEnabled({
	onSupervisorCreated(supervisor) {
		companionSupervisor = supervisor;
		if (shutdownStarted) {
			void supervisor.shutdown().catch((error: unknown) => {
				console.error("Failed to cancel companion startup during desktop shutdown.", error);
			});
		}
	},
}).catch((error: unknown) => {
	console.error("Companion POC failed to start; continuing with desktop Chat only.", error);
	return undefined;
});

console.info(`墨枢 started with Bun ${Bun.version}.`);
