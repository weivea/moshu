import { BrowserWindow, Updater } from "electrobun/bun";
import { desktopRpc } from "./rpc";

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
});

console.info(`墨枢 started with Bun ${Bun.version}.`);
