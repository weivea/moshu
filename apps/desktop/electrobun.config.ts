import type { ElectrobunConfig } from "electrobun";

import { createElectrobunCompanionCopyEntries } from "./src/shared/companion-executable-names";

const packageCompanions = process.env.MOSHU_PACKAGE_COMPANIONS === "1";

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
			...(packageCompanions ? createElectrobunCompanionCopyEntries(process.platform) : {}),
		},
		// Companion binaries are compiled for the build host, so cross-target packaging is unsupported.
		targets: "current",
		useAsar: false,
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			...(packageCompanions ? { createDmg: false } : {}),
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	runtime: {
		companionPocEnabled: packageCompanions,
		exitOnLastWindowClosed: false,
	},
	scripts: packageCompanions
		? {
				postBuild: "scripts/prepare-companion-bundle.ts",
			}
		: undefined,
	release: packageCompanions
		? {
				generatePatch: false,
			}
		: undefined,
} satisfies ElectrobunConfig;
