import type { PathOrFileDescriptor } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const wasmFilename = "photon_rs_bg.wasm";
let photonModule: typeof import("@silvia-odwyer/photon-node") | undefined;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node")> | undefined;

export type PhotonImage = import("@silvia-odwyer/photon-node").PhotonImage;

function pathFromDescriptor(file: PathOrFileDescriptor): string | undefined {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return undefined;
}

function fallbackWasmPaths(): string[] {
	const executableDirectory = dirname(process.execPath);
	return [
		join(executableDirectory, wasmFilename),
		join(executableDirectory, "photon", wasmFilename),
		join(process.cwd(), wasmFilename),
	];
}

function patchPhotonWasmRead(): () => void {
	const originalReadFileSync = fs.readFileSync.bind(fs);
	type ReadFileSync = typeof fs.readFileSync;
	const mutableFs = fs as { readFileSync: ReadFileSync };
	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const requestedPath = pathFromDescriptor(file);
		if (!requestedPath?.endsWith(wasmFilename)) {
			return originalReadFileSync(...args);
		}

		try {
			return originalReadFileSync(...args);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code !== undefined &&
				error.code !== "ENOENT"
			) {
				throw error;
			}
			for (const fallbackPath of fallbackWasmPaths()) {
				if (!fs.existsSync(fallbackPath)) {
					continue;
				}
				return options === undefined
					? originalReadFileSync(fallbackPath)
					: originalReadFileSync(fallbackPath, options);
			}
			throw error;
		}
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node")> {
	if (photonModule) {
		return photonModule;
	}
	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch (error) {
			throw new Error("Failed to load the executor image processor", { cause: error });
		} finally {
			restoreReadFileSync();
		}
	})();
	return loadPromise;
}
