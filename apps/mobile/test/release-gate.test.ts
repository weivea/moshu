import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkReleaseBundleId,
	computeBundleManifest,
	diffBundleManifests,
} from "../scripts/release-gate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scratchRoot = resolve(here, ".release-gate-fixtures");
const manifestExcludes = [
	".DS_Store",
	"capacitor.config.json",
	"config.xml",
	"cordova.js",
	"cordova_plugins.js",
] as const;
const scratchDirs: string[] = [];
let scratchCounter = 0;

function makeFixtureDir(name: string): string {
	const dir = resolve(scratchRoot, `${name}-${Date.now()}-${scratchCounter++}`);
	scratchDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFixtureFile(root: string, path: string, content: string): void {
	const fullPath = resolve(root, path);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content, "utf8");
}

function diffDirs(dist: string, pub: string): string[] {
	return diffBundleManifests(
		computeBundleManifest(dist, manifestExcludes),
		computeBundleManifest(pub, manifestExcludes),
	);
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	rmSync(scratchRoot, { recursive: true, force: true });
});

describe("checkReleaseBundleId", () => {
	it("passes in dev mode without resolving Xcode build settings", () => {
		const problems = checkReleaseBundleId({
			releaseMode: false,
			resolveActualBundleId: () => {
				throw new Error("should not resolve in dev mode");
			},
		});

		expect(problems).toEqual([]);
	});

	it("fails in release mode when no env or config bundle id is configured", () => {
		const problems = checkReleaseBundleId({
			releaseMode: true,
			configReleaseBundleId: null,
			resolveActualBundleId: () => "com.example.moshu",
		});

		expect(problems.join("\n")).toContain("MOSHU_MOBILE_RELEASE_BUNDLE_ID");
	});

	it("fails in release mode when the env bundle id is the development id", () => {
		const problems = checkReleaseBundleId({
			releaseMode: true,
			envBundleId: "dev.moshu.mobile",
			resolveActualBundleId: () => "dev.moshu.mobile",
		});

		expect(problems.join("\n")).toContain("dev.moshu.mobile");
	});

	it("fails in release mode when the resolved Xcode bundle id differs", () => {
		const problems = checkReleaseBundleId({
			releaseMode: true,
			envBundleId: "com.example.moshu",
			resolveActualBundleId: () => "com.other.moshu",
		});

		expect(problems.join("\n")).toContain("Release PRODUCT_BUNDLE_IDENTIFIER mismatch");
		expect(problems.join("\n")).toContain("com.example.moshu");
		expect(problems.join("\n")).toContain("com.other.moshu");
	});

	it("passes in release mode when the expected and resolved bundle ids match", () => {
		const problems = checkReleaseBundleId({
			releaseMode: true,
			envBundleId: "com.example.moshu",
			resolveActualBundleId: () => "com.example.moshu",
		});

		expect(problems).toEqual([]);
	});

	it("fails in release mode when xcodebuild cannot resolve a bundle id", () => {
		const problems = checkReleaseBundleId({
			releaseMode: true,
			envBundleId: "com.example.moshu",
			resolveActualBundleId: () => null,
		});

		expect(problems.join("\n")).toContain("failed to resolve Release PRODUCT_BUNDLE_IDENTIFIER");
	});
});

describe("bundle manifest comparison", () => {
	it("passes identical dist and public directories", () => {
		const dist = makeFixtureDir("dist-identical");
		const pub = makeFixtureDir("public-identical");
		writeFixtureFile(dist, "index.html", "<div>ok</div>");
		writeFixtureFile(dist, "assets/app.js", "console.log('ok');");
		writeFixtureFile(pub, "index.html", "<div>ok</div>");
		writeFixtureFile(pub, "assets/app.js", "console.log('ok');");
		writeFixtureFile(pub, ".DS_Store", "ignored");
		writeFixtureFile(pub, "capacitor.config.json", "{}");
		writeFixtureFile(pub, "config.xml", "<widget />");
		writeFixtureFile(pub, "cordova.js", "ignored");
		writeFixtureFile(pub, "cordova_plugins.js", "ignored");

		expect(diffDirs(dist, pub)).toEqual([]);
	});

	it("fails when public is missing a dist file", () => {
		const dist = makeFixtureDir("dist-missing");
		const pub = makeFixtureDir("public-missing");
		writeFixtureFile(dist, "index.html", "<div>ok</div>");
		writeFixtureFile(dist, "assets/app.js", "console.log('ok');");
		writeFixtureFile(pub, "index.html", "<div>ok</div>");

		const problems = diffDirs(dist, pub);

		expect(problems.join("\n")).toContain("assets/app.js");
		expect(problems.join("\n")).toContain("missing file");
	});

	it("fails when public contains an extra file", () => {
		const dist = makeFixtureDir("dist-extra");
		const pub = makeFixtureDir("public-extra");
		writeFixtureFile(dist, "index.html", "<div>ok</div>");
		writeFixtureFile(pub, "index.html", "<div>ok</div>");
		writeFixtureFile(pub, "assets/old.js", "console.log('old');");

		const problems = diffDirs(dist, pub);

		expect(problems.join("\n")).toContain("assets/old.js");
		expect(problems.join("\n")).toContain("extra file");
	});

	it("fails when a public file has changed content", () => {
		const dist = makeFixtureDir("dist-changed");
		const pub = makeFixtureDir("public-changed");
		writeFixtureFile(dist, "index.html", "<div>ok</div>");
		writeFixtureFile(pub, "index.html", "<div>changed</div>");

		const problems = diffDirs(dist, pub);

		expect(problems.join("\n")).toContain("index.html");
		expect(problems.join("\n")).toContain("content mismatch");
	});
});
