import { writeFileSync } from "node:fs";

import {
	type ExecutorToolAssetManifest,
	type ExecutorToolAssetTarget,
	type ExecutorToolTargetKey,
	executorToolManifestPath,
	readExecutorToolManifest,
} from "./executor-tool-assets";

interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	digest: string | null;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubReleaseAsset[];
}

const targetTriples: Record<ExecutorToolTargetKey, string> = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"linux-arm64": "aarch64-unknown-linux-musl",
	"linux-x64": "x86_64-unknown-linux-musl",
	"win32-arm64": "aarch64-pc-windows-msvc",
	"win32-x64": "x86_64-pc-windows-msvc",
};

const current = readExecutorToolManifest();
const versions = parseVersions(process.argv.slice(2), current);
const next: ExecutorToolAssetManifest = {
	schemaVersion: 1,
	tools: {
		rg: await resolveTool("rg", "BurntSushi/ripgrep", versions.rg),
		fd: await resolveTool("fd", "sharkdp/fd", versions.fd),
	},
};
writeFileSync(executorToolManifestPath, `${JSON.stringify(next, null, "\t")}\n`);
console.info(`Updated ${executorToolManifestPath} (rg ${versions.rg}, fd ${versions.fd}).`);

function parseVersions(
	arguments_: string[],
	manifest: ExecutorToolAssetManifest,
): { rg: string; fd: string } {
	const versions = {
		rg: manifest.tools.rg.version,
		fd: manifest.tools.fd.version,
	};
	for (let index = 0; index < arguments_.length; index += 2) {
		const flag = arguments_[index];
		const value = arguments_[index + 1];
		if (value === undefined || !/^\d+\.\d+\.\d+$/.test(value)) {
			throw new Error(`${flag ?? "version flag"} requires a semantic version.`);
		}
		if (flag === "--ripgrep") {
			versions.rg = value;
		} else if (flag === "--fd") {
			versions.fd = value;
		} else {
			throw new Error(`Unknown executor tool update flag: ${flag}.`);
		}
	}
	return versions;
}

async function resolveTool(
	tool: "rg" | "fd",
	repository: string,
	version: string,
): Promise<ExecutorToolAssetManifest["tools"]["rg"]> {
	const releaseTag = tool === "fd" ? `v${version}` : version;
	const response = await fetch(
		`https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`,
		{
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "moshu-executor-tool-updater",
				"x-github-api-version": "2022-11-28",
			},
		},
	);
	if (!response.ok) {
		throw new Error(
			`GitHub release lookup failed for ${repository}@${releaseTag}: ${response.status}.`,
		);
	}
	const release = (await response.json()) as GitHubRelease;
	if (release.tag_name !== releaseTag || !Array.isArray(release.assets)) {
		throw new Error(`GitHub returned an invalid release for ${repository}@${releaseTag}.`);
	}
	const targets = {} as Record<ExecutorToolTargetKey, ExecutorToolAssetTarget>;
	for (const [targetKey, triple] of Object.entries(targetTriples) as [
		ExecutorToolTargetKey,
		string,
	][]) {
		const extension = targetKey.startsWith("win32-") ? "zip" : "tar.gz";
		const root = tool === "rg" ? `ripgrep-${version}-${triple}` : `fd-v${version}-${triple}`;
		const assetName = `${root}.${extension}`;
		const asset = release.assets.find((candidate) => candidate.name === assetName);
		const digest = asset?.digest;
		if (asset === undefined || digest === null || !digest.startsWith("sha256:")) {
			throw new Error(
				`Release ${repository}@${releaseTag} is missing a SHA-256 asset ${assetName}.`,
			);
		}
		targets[targetKey] = {
			url: asset.browser_download_url,
			sha256: digest.slice("sha256:".length),
			archiveType: extension,
			executablePath: `${root}/${tool}${targetKey.startsWith("win32-") ? ".exe" : ""}`,
		};
	}
	return {
		version,
		repository,
		releaseTag,
		license: tool === "rg" ? "MIT OR Unlicense" : "MIT OR Apache-2.0",
		licenseUrl: `https://github.com/${repository}/blob/${releaseTag}/LICENSE-MIT`,
		targets,
	};
}
