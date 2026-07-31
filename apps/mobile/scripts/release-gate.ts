/**
 * Release gate for the Moshu iOS App. Run before cutting a build:
 *
 *   bun run --cwd apps/mobile release:gate
 *
 * It is a defensive, fail-closed set of static checks that encode Layer 5's hard product boundaries.
 * None of these checks talk to the network or require signing credentials. A non-zero exit means the
 * build must NOT be shipped until the reported issue is resolved.
 *
 * What it enforces:
 *   1. No remote UI          — capacitor config has no `server.url`; the App only loads bundled `dist`.
 *   2. No desktop/node leak  — mobile `src` imports no node builtins, `Buffer`, or `ws`.
 *   3. No secret samples     — no private keys / tokens committed under `src` or `ios`.
 *   4. No broad ATS          — Info.plist has no arbitrary-loads exception.
 *   5. No forbidden bg modes — no remote-notification / voip / audio / fetch / processing background.
 *   6. No APNs               — no `aps-environment` entitlement, no Local Network / Bonjour usage.
 *   7. No baked signing      — pbxproj has no DEVELOPMENT_TEAM / provisioning profile.
 *   8. Release bundle id     — real releases must resolve to a permanent non-dev bundle id.
 *   9. Version consistency   — release.config.json == pbxproj == package.json.
 *  10. Contracts/vectors sync— regenerating canonical vectors produces no diff.
 *  11. Web bundle synced     — `dist` and iOS `public` contain the same files and hashes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = resolve(mobileRoot, "../..");
const developmentBundleId = "dev.moshu.mobile";
const bundleManifestExcludes = [
	".DS_Store",
	"capacitor.config.json",
	"config.xml",
	"cordova.js",
	"cordova_plugins.js",
] as const;

interface Failure {
	readonly check: string;
	readonly detail: string;
}

interface ReleaseGateConfig {
	readonly bundleId?: {
		readonly development?: string;
		readonly release?: string | null;
	};
}

export interface BundleManifestEntry {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export function checkReleaseBundleId(opts: {
	releaseMode: boolean;
	envBundleId?: string;
	configReleaseBundleId?: string | null;
	resolveActualBundleId: () => string | null;
}): string[] {
	if (!opts.releaseMode) return [];

	const problems: string[] = [];
	const hasEnvBundleId = opts.envBundleId !== undefined;
	const hasConfigReleaseBundleId =
		opts.configReleaseBundleId !== undefined && opts.configReleaseBundleId !== null;
	const envBundleId = opts.envBundleId?.trim() ?? "";
	const configReleaseBundleId = opts.configReleaseBundleId?.trim() ?? "";
	const expectedBundleId = hasEnvBundleId
		? envBundleId
		: hasConfigReleaseBundleId
			? configReleaseBundleId
			: "";

	if (expectedBundleId.length === 0) {
		problems.push(
			hasEnvBundleId || hasConfigReleaseBundleId
				? "release bundle id is empty — set MOSHU_MOBILE_RELEASE_BUNDLE_ID to a permanent non-dev reverse-DNS id before running the real release gate"
				: "release bundle id is not configured — set MOSHU_MOBILE_RELEASE_BUNDLE_ID to a permanent non-dev reverse-DNS id before running the real release gate",
		);
		return problems;
	}

	if (expectedBundleId.toLowerCase() === developmentBundleId) {
		problems.push(
			`release bundle id must not be ${developmentBundleId}; set MOSHU_MOBILE_RELEASE_BUNDLE_ID to the publisher's permanent non-dev id`,
		);
		return problems;
	}

	let actualBundleId: string | null;
	try {
		actualBundleId = opts.resolveActualBundleId();
	} catch (error) {
		problems.push(
			`failed to resolve Release PRODUCT_BUNDLE_IDENTIFIER with xcodebuild: ${formatError(error)}`,
		);
		return problems;
	}

	if (actualBundleId === null || actualBundleId.trim().length === 0) {
		problems.push(
			"failed to resolve Release PRODUCT_BUNDLE_IDENTIFIER with xcodebuild (no value reported)",
		);
		return problems;
	}

	if (actualBundleId !== expectedBundleId) {
		problems.push(
			`Release PRODUCT_BUNDLE_IDENTIFIER mismatch: expected ${expectedBundleId}, got ${actualBundleId}`,
		);
	}

	return problems;
}

export function computeBundleManifest(
	dir: string,
	exclude: readonly string[],
): BundleManifestEntry[] {
	if (!existsSync(dir)) return [];

	const excludeSet = new Set(exclude);
	const manifest: BundleManifestEntry[] = [];

	function walk(currentDir: string, relativePrefix: string): void {
		const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
			if (excludeSet.has(entry.name) || excludeSet.has(relativePath)) continue;

			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath, relativePath);
				continue;
			}
			if (!entry.isFile()) continue;

			const data = readFileSync(fullPath);
			manifest.push({
				path: relativePath,
				size: statSync(fullPath).size,
				sha256: createHash("sha256").update(data).digest("hex"),
			});
		}
	}

	walk(dir, "");
	return manifest.sort((a, b) => a.path.localeCompare(b.path));
}

export function diffBundleManifests(
	dist: readonly BundleManifestEntry[],
	pub: readonly BundleManifestEntry[],
): string[] {
	const problems: string[] = [];
	const distByPath = new Map(dist.map((entry) => [entry.path, entry]));
	const publicByPath = new Map(pub.map((entry) => [entry.path, entry]));
	const paths = [...new Set([...distByPath.keys(), ...publicByPath.keys()])].sort((a, b) =>
		a.localeCompare(b),
	);

	for (const path of paths) {
		const distEntry = distByPath.get(path);
		const publicEntry = publicByPath.get(path);
		if (!distEntry) {
			problems.push(`iOS public bundle contains extra file ${path} not present in dist`);
			continue;
		}
		if (!publicEntry) {
			problems.push(
				`iOS public bundle is missing file ${path} from dist — run \`bun run cap:copy\` (or cap sync)`,
			);
			continue;
		}
		if (distEntry.size !== publicEntry.size || distEntry.sha256 !== publicEntry.sha256) {
			problems.push(
				`iOS public bundle content mismatch for ${path} (dist ${distEntry.size} bytes ${distEntry.sha256}, public ${publicEntry.size} bytes ${publicEntry.sha256}) — run \`bun run cap:copy\` (or cap sync)`,
			);
		}
	}

	return problems;
}

function read(path: string): string {
	return readFileSync(path, "utf8");
}

function listFiles(dir: string, exts: readonly string[]): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...listFiles(full, exts));
		} else if (exts.some((e) => entry.endsWith(e))) {
			out.push(full);
		}
	}
	return out;
}

function loadReleaseGateConfig(): ReleaseGateConfig {
	return JSON.parse(read(resolve(mobileRoot, "release.config.json"))) as ReleaseGateConfig;
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function outputToString(output: unknown): string {
	if (Buffer.isBuffer(output)) return output.toString();
	if (typeof output === "string") return output;
	return "";
}

function isTruthyEnv(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 && !["0", "false", "no", "off"].includes(normalized);
}

function resolveXcodeReleaseBundleId(): string | null {
	try {
		const output = execFileSync(
			"xcodebuild",
			[
				"-showBuildSettings",
				"-configuration",
				"Release",
				"-project",
				resolve(mobileRoot, "ios/App/App.xcodeproj"),
				"-scheme",
				"App",
			],
			{ cwd: mobileRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		const match = /^\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(.+?)\s*$/m.exec(output);
		return match?.[1]?.trim() ?? null;
	} catch (error) {
		const stderr = outputToString((error as { stderr?: unknown }).stderr).trim();
		const stdout = outputToString((error as { stdout?: unknown }).stdout).trim();
		const detail = stderr || stdout || formatError(error);
		throw new Error(`xcodebuild -showBuildSettings failed: ${detail}`);
	}
}

export function runGate(
	argv: readonly string[] = process.argv.slice(2),
	env: Record<string, string | undefined> = process.env,
): number {
	const failures: Failure[] = [];
	const passed: string[] = [];
	const notes: string[] = [];
	const releaseMode = isTruthyEnv(env.MOSHU_MOBILE_RELEASE) || argv.includes("--release");

	function record(check: string, problems: string[]): void {
		if (problems.length === 0) {
			passed.push(check);
			return;
		}
		for (const detail of problems) failures.push({ check, detail });
	}

	// --- 1. No remote UI origin ---
	(() => {
		const problems: string[] = [];
		const config = read(resolve(mobileRoot, "capacitor.config.ts"));
		const serverBlock = /server\s*:\s*\{[^}]*\}/s.exec(config)?.[0] ?? "";
		if (/\burl\s*:/.test(serverBlock)) {
			problems.push("capacitor.config.ts declares a server.url (remote UI origin is forbidden)");
		}
		const generatedConfig = resolve(mobileRoot, "ios/App/App/capacitor.config.json");
		if (existsSync(generatedConfig)) {
			const parsed = JSON.parse(read(generatedConfig)) as { server?: { url?: unknown } };
			if (parsed.server && typeof parsed.server.url === "string") {
				problems.push("ios capacitor.config.json has server.url set");
			}
		}
		record("no-remote-ui", problems);
	})();

	// --- 2. No node builtins / Buffer / ws in mobile source ---
	(() => {
		const problems: string[] = [];
		const files = listFiles(resolve(mobileRoot, "src"), [".ts", ".tsx"]);
		const patterns: Array<{ re: RegExp; label: string }> = [
			{ re: /(from|import)\s+["']node:/, label: "node: builtin import" },
			{ re: /require\(\s*["']node:/, label: "node: builtin require" },
			{ re: /\bfrom\s+["']ws["']/, label: 'import from "ws"' },
			{ re: /\bBuffer\b/, label: "Buffer usage" },
		];
		for (const file of files) {
			const text = read(file);
			for (const { re, label } of patterns) {
				if (re.test(text)) problems.push(`${label} in ${file.slice(repoRoot.length + 1)}`);
			}
		}
		record("no-node-or-ws-in-bundle", problems);
	})();

	// --- 3. No secret samples under src / ios ---
	(() => {
		const problems: string[] = [];
		const secretPatterns: Array<{ re: RegExp; label: string }> = [
			{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "PEM private key" },
			{ re: /\bghp_[A-Za-z0-9]{20,}/, label: "GitHub token" },
			{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, label: "GitHub fine-grained token" },
			{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: "Slack token" },
			{ re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
		];
		const files = [
			...listFiles(resolve(mobileRoot, "src"), [".ts", ".tsx", ".json"]),
			...listFiles(resolve(mobileRoot, "ios/App/App"), [".swift", ".plist", ".json", ".xcprivacy"]),
		];
		for (const file of files) {
			const text = read(file);
			for (const { re, label } of secretPatterns) {
				if (re.test(text)) problems.push(`${label} in ${file.slice(repoRoot.length + 1)}`);
			}
		}
		record("no-secret-samples", problems);
	})();

	// --- 4/5/6. Info.plist: ATS, background modes, Local Network ---
	(() => {
		const problems: string[] = [];
		const plist = read(resolve(mobileRoot, "ios/App/App/Info.plist"));
		if (/NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(plist)) {
			problems.push("Info.plist enables NSAllowsArbitraryLoads (broad ATS exception)");
		}
		if (/NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/.test(plist)) {
			problems.push("Info.plist enables NSAllowsArbitraryLoadsInWebContent");
		}
		const bgMatch = /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
		if (bgMatch) {
			const modes = bgMatch[1] ?? "";
			const forbidden = ["remote-notification", "voip", "audio", "fetch", "processing"];
			for (const mode of forbidden) {
				if (modes.includes(mode)) {
					problems.push(`Info.plist declares forbidden UIBackgroundMode "${mode}"`);
				}
			}
		}
		if (/NSLocalNetworkUsageDescription/.test(plist) || /NSBonjourServices/.test(plist)) {
			problems.push("Info.plist declares Local Network / Bonjour usage (not used by Moshu)");
		}
		record("info-plist-transport-and-background", problems);
	})();

	// --- 6b. No APNs entitlement ---
	(() => {
		const problems: string[] = [];
		const entitlements = listFiles(resolve(mobileRoot, "ios"), [".entitlements"]);
		for (const file of entitlements) {
			if (/aps-environment/.test(read(file))) {
				problems.push(
					`${file.slice(repoRoot.length + 1)} declares aps-environment (APNs is forbidden)`,
				);
			}
		}
		record("no-apns-entitlement", problems);
	})();

	// --- 7. No baked signing identity ---
	(() => {
		const problems: string[] = [];
		const pbxproj = read(resolve(mobileRoot, "ios/App/App.xcodeproj/project.pbxproj"));
		const team = /DEVELOPMENT_TEAM\s*=\s*([^;]+);/g;
		for (const m of pbxproj.matchAll(team)) {
			const value = (m[1] ?? "").trim().replace(/^"|"$/g, "");
			if (value !== "" && value !== '""') {
				problems.push(`pbxproj hardcodes DEVELOPMENT_TEAM = ${value}`);
			}
		}
		const profile = /PROVISIONING_PROFILE_SPECIFIER\s*=\s*([^;]+);/g;
		for (const m of pbxproj.matchAll(profile)) {
			const value = (m[1] ?? "").trim().replace(/^"|"$/g, "");
			if (value !== "" && value !== '""') {
				problems.push(`pbxproj hardcodes PROVISIONING_PROFILE_SPECIFIER = ${value}`);
			}
		}
		record("no-baked-signing", problems);
	})();

	// --- 8. Release bundle id policy ---
	(() => {
		const config = loadReleaseGateConfig();
		const problems = checkReleaseBundleId({
			releaseMode,
			envBundleId: env.MOSHU_MOBILE_RELEASE_BUNDLE_ID,
			configReleaseBundleId: config.bundleId?.release ?? null,
			resolveActualBundleId: resolveXcodeReleaseBundleId,
		});
		if (!releaseMode) {
			notes.push(
				"release-bundle-id skipped in default dev mode; set MOSHU_MOBILE_RELEASE=1 or pass --release to enforce it",
			);
		}
		record("release-bundle-id", problems);
	})();

	// --- 9. Version consistency ---
	(() => {
		const problems: string[] = [];
		try {
			execFileSync("bun", ["run", resolve(mobileRoot, "scripts/sync-version.ts"), "--check"], {
				cwd: mobileRoot,
				stdio: "pipe",
			});
		} catch (error) {
			const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
			problems.push(stderr.trim());
		}
		record("version-consistency", problems);
	})();

	// --- 10. Contracts / canonical vectors sync ---
	(() => {
		const problems: string[] = [];
		const fixture =
			"apps/mobile/native/MoshuMobile/Tests/MoshuMobileCoreTests/Fixtures/mobile-canonical-vectors.json";
		try {
			execFileSync("bun", ["run", resolve(mobileRoot, "scripts/gen-canonical-vectors.ts")], {
				cwd: mobileRoot,
				stdio: "pipe",
			});
			execFileSync("git", ["diff", "--quiet", "--", fixture], { cwd: repoRoot, stdio: "pipe" });
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 1) {
				problems.push(
					`canonical vectors are stale — regenerate with \`bun run gen:vectors\` (${fixture})`,
				);
			} else {
				problems.push(`failed to verify canonical vectors: ${(error as Error).message}`);
			}
		}
		record("contracts-vectors-sync", problems);
	})();

	// --- 11. Web bundle built and synced into iOS ---
	(() => {
		const problems: string[] = [];
		const distDir = resolve(mobileRoot, "dist");
		const publicDir = resolve(mobileRoot, "ios/App/App/public");
		if (!existsSync(distDir)) {
			problems.push("dist missing — run `bun run build` before the gate");
		} else if (!existsSync(publicDir)) {
			problems.push("ios/App/App/public missing — run `bun run cap:copy` (or cap sync)");
		} else {
			problems.push(
				...diffBundleManifests(
					computeBundleManifest(distDir, bundleManifestExcludes),
					computeBundleManifest(publicDir, bundleManifestExcludes),
				),
			);
		}
		record("web-bundle-synced", problems);
	})();

	// --- Report ---
	for (const name of passed) console.log(`  ok   ${name}`);
	for (const note of notes) console.log(`  info ${note}`);
	for (const { check, detail } of failures) console.error(`  FAIL ${check}: ${detail}`);

	if (failures.length > 0) {
		console.error(`\nRelease gate FAILED with ${failures.length} problem(s).`);
		return 1;
	}
	console.log(`\nRelease gate passed (${passed.length} checks).`);
	return 0;
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
	process.exit(runGate());
}
