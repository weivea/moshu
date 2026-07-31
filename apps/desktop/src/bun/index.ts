import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Electrobun, { ApplicationMenu, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { logChatRpcDiagnostic } from "../shared/chat-rpc-diagnostics";
import { macApplicationMenu } from "./application-menu";
import { startCompanionRuntime } from "./companion-poc";
import type { CompanionProcessSupervisor } from "./companion-process-supervisor";
import { DesktopAgentsClient } from "./desktop-agents-client";
import { createDesktopShutdownCoordinator } from "./desktop-lifecycle";
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
const agentsClient = new DesktopAgentsClient();
const desktopRpc = createDesktopRpc({ agentsClient });
const unsubscribeAgentsReady = agentsClient.subscribeReady(() => {
	desktopRpc.send.agentsReady({});
});
const unsubscribeChatEvents = agentsClient.subscribeChatEvents((event) => {
	logChatRpcDiagnostic("bun", "send", "chatEvent", event);
	desktopRpc.send.chatEvent(event);
});
const unsubscribeChatSessionInvalidations = agentsClient.subscribeChatSessionInvalidations(
	(invalidation) => {
		desktopRpc.send.chatSessionInvalidated(invalidation);
	},
);
const unsubscribeRuntimeBoxesChanged = agentsClient.subscribeRuntimeBoxesChanged((snapshot) => {
	desktopRpc.send.runtimeBoxesChanged(snapshot);
});
const unsubscribeApprovalEvents = agentsClient.subscribeApprovalEvents((delivery) => {
	desktopRpc.send.approvalEvent(delivery);
});
const unsubscribeSessionApprovalPolicy = agentsClient.subscribeSessionApprovalPolicyChanged(
	(event) => {
		desktopRpc.send.sessionApprovalPolicyChanged(event);
	},
);
const unsubscribeApprovalActivity = agentsClient.subscribeApprovalActivityChanged(() => {
	desktopRpc.send.approvalActivityChanged({});
});

let shutdownStarted = false;
let companionSupervisor: CompanionProcessSupervisor | undefined;
let companionStartupPromise: Promise<CompanionProcessSupervisor | undefined> =
	Promise.resolve(undefined);
const shutdownCoordinator = createDesktopShutdownCoordinator({
	async cleanup() {
		shutdownStarted = true;
		unsubscribeAgentsReady();
		unsubscribeChatEvents();
		unsubscribeChatSessionInvalidations();
		unsubscribeRuntimeBoxesChanged();
		unsubscribeApprovalEvents();
		unsubscribeSessionApprovalPolicy();
		unsubscribeApprovalActivity();
		agentsClient.close();
		try {
			await companionSupervisor?.shutdown();
		} finally {
			await companionStartupPromise;
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

if (process.platform === "darwin") {
	ApplicationMenu.setApplicationMenu(macApplicationMenu);
}

const mainWindow = new BrowserWindow({
	title: "墨枢",
	url: await getMainViewUrl(),
	rpc: desktopRpc,
	titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
	frame: {
		width: 1180,
		height: 760,
		x: 120,
		y: 80,
	},
});
if (process.platform === "darwin") {
	mainWindow.setWindowButtonPosition(14, 12);
}
mainWindow.on("close", () => {
	console.info("墨枢 main window closed.");
	shutdownCoordinator.handleWindowClose();
});

companionStartupPromise = startCompanionRuntime({
	dataPaths: {
		productDatabase: join(Utils.paths.userData, "moshu.db"),
		agentDataDirectory: join(Utils.paths.userData, "agent-data"),
	},
	connectClient: (options) => agentsClient.connect(options),
	onSupervisorCreated(supervisor) {
		companionSupervisor = supervisor;
		if (shutdownStarted) {
			void supervisor.shutdown();
		}
	},
}).catch((error: unknown) => {
	console.error(
		"Companion runtime is unavailable; server-backed features will recover or remain disabled.",
		error,
	);
	return undefined;
});

console.info(`墨枢 started with Bun ${Bun.version}.`);
