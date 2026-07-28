import type { ElectrobunConfig } from "electrobun";

import { resolveCompanionCodesignIdentity } from "./scripts/companion-signing";
import { createElectrobunCompanionCopyEntries } from "./src/shared/companion-executable-names";

export const companionSourceWatchPaths = [
	"../agents-server/src",
	"../executor/src",
	"../../packages/agent-runtime/src",
	"../../packages/contracts/src",
	"../../packages/database/src",
	"../../packages/process-rpc/src",
];

export const electrobunWatchIgnorePatterns = [
	"**/.git/**",
	"**/node_modules/**",
	"**/.cache/**",
	"**/build/**",
	"**/dist/**",
	"**/artifacts/**",
	"**/coverage/**",
];

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
				"../../THIRD_PARTY_NOTICES.txt": "licenses/THIRD_PARTY_NOTICES.txt",
				"../../third_party/licenses": "licenses/third_party",
				"../executor/node_modules/@silvia-odwyer/photon-node/LICENSE.md":
					"licenses/third_party/photon-node-LICENSE.md",
				...createElectrobunCompanionCopyEntries(platform),
			},
			// Companion binaries are compiled for the build host, so cross-target packaging is unsupported.
			targets: "current",
			useAsar: false,
			watch: companionSourceWatchPaths,
			// Root-level copy sources make Electrobun watch the repository root.
			watchIgnore: electrobunWatchIgnorePatterns,
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
			preBuild: "scripts/build-companions.ts",
			postBuild: "scripts/prepare-companion-bundle.ts",
			postPackage: "scripts/verify-mac-package.ts",
		},
		release: {
			generatePatch: false,
		},
	} satisfies ElectrobunConfig;
}

export default createElectrobunConfig();
