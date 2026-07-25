import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		// Electrobun 1.18.1 cannot archive a bundle directory with non-ASCII characters.
		name: "Moshu",
		description: "墨枢 - Local-first desktop agent",
		// Development placeholder; replace with the publisher's permanent reverse-DNS ID.
		identifier: "dev.moshu.app",
		version: "0.0.1",
	},
	build: {
		copy: {
			"dist/mainview/index.html": "views/mainview/index.html",
			"dist/mainview/assets": "views/mainview/assets",
			"src/views/canvas/index.html": "views/canvas/index.html",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
