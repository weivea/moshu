/**
 * Fans the single-source-of-truth version (`apps/mobile/release.config.json`) out into:
 *   - the Xcode project's `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (every build config), and
 *   - this workspace's `package.json` `version`.
 *
 * Idempotent: running it twice produces no further changes. It never touches signing identity,
 * `DEVELOPMENT_TEAM`, provisioning profiles, or the bundle identifier.
 *
 * Usage:
 *   bun run --cwd apps/mobile release:version            # write
 *   bun run --cwd apps/mobile release:version -- --check  # verify only (non-zero exit on drift)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(fileURLToPath(import.meta.url), "../..");
const configPath = resolve(mobileRoot, "release.config.json");
const pbxprojPath = resolve(mobileRoot, "ios/App/App.xcodeproj/project.pbxproj");
const packageJsonPath = resolve(mobileRoot, "package.json");

const checkOnly = process.argv.includes("--check");

interface ReleaseConfig {
	readonly marketingVersion: string;
	readonly buildNumber: string;
}

function loadConfig(): ReleaseConfig {
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<ReleaseConfig>;
	const marketingVersion = raw.marketingVersion;
	const buildNumber = raw.buildNumber;
	if (typeof marketingVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(marketingVersion)) {
		throw new Error(
			`release.config.json marketingVersion must be x.y.z, got ${String(marketingVersion)}`,
		);
	}
	if (typeof buildNumber !== "string" || !/^\d+$/.test(buildNumber)) {
		throw new Error(
			`release.config.json buildNumber must be a positive integer string, got ${String(buildNumber)}`,
		);
	}
	return { marketingVersion, buildNumber };
}

const config = loadConfig();
const drift: string[] = [];

// --- Xcode project ---
const originalPbxproj = readFileSync(pbxprojPath, "utf8");
let pbxproj = originalPbxproj.replace(
	/MARKETING_VERSION = [^;]+;/g,
	`MARKETING_VERSION = ${config.marketingVersion};`,
);
pbxproj = pbxproj.replace(
	/CURRENT_PROJECT_VERSION = [^;]+;/g,
	`CURRENT_PROJECT_VERSION = ${config.buildNumber};`,
);
if (pbxproj !== originalPbxproj) {
	drift.push("ios/App/App.xcodeproj/project.pbxproj MARKETING_VERSION/CURRENT_PROJECT_VERSION");
	if (!checkOnly) writeFileSync(pbxprojPath, pbxproj, "utf8");
}

// --- package.json ---
const originalPackageJson = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(originalPackageJson) as { version?: string };
if (packageJson.version !== config.marketingVersion) {
	drift.push(`package.json version (${String(packageJson.version)} -> ${config.marketingVersion})`);
	if (!checkOnly) {
		packageJson.version = config.marketingVersion;
		writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, "\t")}\n`, "utf8");
	}
}

if (checkOnly) {
	if (drift.length > 0) {
		console.error(
			`Version drift detected (run \`bun run release:version\`):\n  - ${drift.join("\n  - ")}`,
		);
		process.exit(1);
	}
	console.log(`Version in sync: ${config.marketingVersion} (build ${config.buildNumber}).`);
} else if (drift.length > 0) {
	console.log(
		`Synced version ${config.marketingVersion} (build ${config.buildNumber}):\n  - ${drift.join("\n  - ")}`,
	);
} else {
	console.log(`Version already in sync: ${config.marketingVersion} (build ${config.buildNumber}).`);
}
