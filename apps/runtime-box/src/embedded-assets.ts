import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface EmbeddedRuntimeBoxAsset {
	readonly sourcePath: string;
	readonly sha256: string;
	readonly filename: string;
	readonly executable: boolean;
}

export interface EmbeddedRuntimeBoxAssets {
	readonly rg: EmbeddedRuntimeBoxAsset;
	readonly fd: EmbeddedRuntimeBoxAsset;
	readonly photonWasm: EmbeddedRuntimeBoxAsset;
}

export interface ExtractedRuntimeBoxAssets {
	readonly rg: string;
	readonly fd: string;
	readonly photonWasm: string;
}

export async function extractEmbeddedRuntimeBoxAssets(
	assets: EmbeddedRuntimeBoxAssets,
	cacheRoot = resolveRuntimeAssetCacheRoot(),
): Promise<ExtractedRuntimeBoxAssets> {
	const entries = await Promise.all(
		Object.entries(assets).map(async ([name, asset]) => {
			const bytes = new Uint8Array(await Bun.file(asset.sourcePath).arrayBuffer());
			const actualHash = hashBytes(bytes);
			if (actualHash !== asset.sha256) {
				throw new Error(`Embedded Runtime Box asset ${name} failed SHA-256 verification.`);
			}
			const directory = join(cacheRoot, asset.sha256);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
			const destination = join(directory, asset.filename);
			extractOne(destination, bytes, asset);
			return [name, destination] as const;
		}),
	);
	const extracted = Object.fromEntries(entries) as Record<string, string>;
	return {
		rg: requirePath(extracted.rg),
		fd: requirePath(extracted.fd),
		photonWasm: requirePath(extracted.photonWasm),
	};
}

export function resolveRuntimeAssetCacheRoot(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home = homedir(),
): string {
	const override = environment.MOSHU_RUNTIME_BOX_CACHE?.trim();
	if (override) {
		return resolve(override);
	}
	if (platform === "darwin") {
		return join(home, "Library", "Caches", "Moshu", "runtime-box-assets");
	}
	if (platform === "win32") {
		const localAppData = environment.LOCALAPPDATA?.trim();
		if (!localAppData) {
			throw new Error("LOCALAPPDATA is required for Runtime Box asset extraction.");
		}
		return join(localAppData, "Moshu", "runtime-box-assets");
	}
	if (platform === "linux") {
		return join(
			environment.XDG_CACHE_HOME?.trim() || join(home, ".cache"),
			"moshu",
			"runtime-box-assets",
		);
	}
	throw new Error(`Unsupported Runtime Box asset platform: ${platform}.`);
}

function extractOne(destination: string, bytes: Uint8Array, asset: EmbeddedRuntimeBoxAsset): void {
	if (existsSync(destination)) {
		const metadata = lstatSync(destination);
		if (
			metadata.isFile() &&
			!metadata.isSymbolicLink() &&
			hashBytes(readFileSync(destination)) === asset.sha256
		) {
			chmodSync(destination, asset.executable ? 0o700 : 0o600);
			return;
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Runtime Box asset cache entry must be a regular file.");
		}
	}
	const temporary = join(
		dirname(destination),
		`.${asset.filename}.${process.pid}.${randomUUID()}.tmp`,
	);
	let renamed = false;
	try {
		writeFileSync(temporary, bytes, { flag: "wx", mode: asset.executable ? 0o700 : 0o600 });
		if (hashBytes(readFileSync(temporary)) !== asset.sha256) {
			throw new Error("Extracted Runtime Box asset failed SHA-256 verification.");
		}
		renameSync(temporary, destination);
		renamed = true;
		chmodSync(destination, asset.executable ? 0o700 : 0o600);
	} finally {
		if (!renamed && existsSync(temporary)) {
			unlinkSync(temporary);
		}
	}
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function requirePath(value: string | undefined): string {
	if (value === undefined) {
		throw new Error("Embedded Runtime Box asset extraction is incomplete.");
	}
	return value;
}
