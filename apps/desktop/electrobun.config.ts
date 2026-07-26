import type { ElectrobunConfig } from "electrobun";

import { resolveCompanionCodesignIdentity } from "./scripts/companion-signing";
import { createElectrobunCompanionCopyEntries } from "./src/shared/companion-executable-names";

export function createElectrobunConfig(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
) {
	const codesignIdentity = resolveCompanionCodesignIdentity(environment);
	const useBuiltInMacCodesign = platform === "darwin" && codesignIdentity !== "-";
	return {
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
				...createElectrobunCompanionCopyEntries(platform),
			},
			// Companion binaries are compiled for the build host, so cross-target packaging is unsupported.
			targets: "current",
			useAsar: false,
			watchIgnore: ["dist/**"],
			mac: {
				bundleCEF: false,
				// Electrobun 1.18.1 always timestamps this path; ad-hoc signing runs pre-archive instead.
				codesign: useBuiltInMacCodesign,
				createDmg: false,
				notarize: false,
			},
			linux: {
				bundleCEF: false,
			},
			win: {
				bundleCEF: false,
			},
		},
		runtime: {
			exitOnLastWindowClosed: false,
		},
		scripts: {
			postBuild: "scripts/prepare-companion-bundle.ts",
			postPackage: "scripts/verify-mac-package.ts",
		},
		release: {
			generatePatch: false,
		},
	} satisfies ElectrobunConfig;
}

export default createElectrobunConfig();
