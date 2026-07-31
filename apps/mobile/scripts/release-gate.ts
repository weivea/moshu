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
 *   8. Version consistency   — release.config.json == pbxproj == package.json.
 *   9. Contracts/vectors sync— regenerating canonical vectors produces no diff.
 *  10. Web bundle synced     — `dist` is built and copied into the iOS `public` folder.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = resolve(mobileRoot, "../..");

interface Failure {
	readonly check: string;
	readonly detail: string;
}

const failures: Failure[] = [];
const passed: string[] = [];

function record(check: string, problems: string[]): void {
	if (problems.length === 0) {
		passed.push(check);
		return;
	}
	for (const detail of problems) failures.push({ check, detail });
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
		const forbidden = ["remote-notification", "voip", "audio", "fetch", "processing"];
		for (const mode of forbidden) {
			if (bgMatch[1].includes(mode)) {
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
		const value = m[1].trim().replace(/^"|"$/g, "");
		if (value !== "" && value !== '""') {
			problems.push(`pbxproj hardcodes DEVELOPMENT_TEAM = ${value}`);
		}
	}
	const profile = /PROVISIONING_PROFILE_SPECIFIER\s*=\s*([^;]+);/g;
	for (const m of pbxproj.matchAll(profile)) {
		const value = m[1].trim().replace(/^"|"$/g, "");
		if (value !== "" && value !== '""') {
			problems.push(`pbxproj hardcodes PROVISIONING_PROFILE_SPECIFIER = ${value}`);
		}
	}
	record("no-baked-signing", problems);
})();

// --- 8. Version consistency ---
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

// --- 9. Contracts / canonical vectors sync ---
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

// --- 10. Web bundle built and synced into iOS ---
(() => {
	const problems: string[] = [];
	const distIndex = resolve(mobileRoot, "dist/index.html");
	const publicIndex = resolve(mobileRoot, "ios/App/App/public/index.html");
	if (!existsSync(distIndex)) {
		problems.push("dist/index.html missing — run `bun run build` before the gate");
	} else if (!existsSync(publicIndex)) {
		problems.push("ios/App/App/public/index.html missing — run `bun run cap:copy` (or cap sync)");
	} else if (read(distIndex) !== read(publicIndex)) {
		problems.push("iOS public bundle is out of date — run `bun run cap:copy` (or cap sync)");
	}
	record("web-bundle-synced", problems);
})();

// --- Report ---
for (const name of passed) console.log(`  ok   ${name}`);
for (const { check, detail } of failures) console.error(`  FAIL ${check}: ${detail}`);

if (failures.length > 0) {
	console.error(`\nRelease gate FAILED with ${failures.length} problem(s).`);
	process.exit(1);
}
console.log(`\nRelease gate passed (${passed.length} checks).`);
