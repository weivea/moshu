import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import {
	runtimeBoxDeviceKeyIdSchema,
	runtimeBoxIdSchema,
	runtimeBoxPublicKeySchema,
} from "@moshu/contracts";
import { z } from "zod";

const remoteRuntimeBoxConfigSchema = z
	.object({
		schemaVersion: z.literal(1),
		runtimeBaseUrl: z.string().url(),
		runtimeBoxId: runtimeBoxIdSchema,
		deviceKeyId: runtimeBoxDeviceKeyIdSchema,
		publicKey: runtimeBoxPublicKeySchema,
		privateKey: runtimeBoxPublicKeySchema,
		agentServerId: z.string().uuid(),
		agentServerPublicKey: runtimeBoxPublicKeySchema,
		generation: z.int().nonnegative().safe(),
		displayName: z.string().trim().min(1).max(128),
	})
	.strict();

export type RemoteRuntimeBoxConfig = z.infer<typeof remoteRuntimeBoxConfigSchema>;

export class RemoteRuntimeBoxState {
	readonly root: string;
	readonly configPath: string;
	readonly workspacePath: string;

	constructor(root = resolveRemoteRuntimeBoxRoot()) {
		this.root = resolve(root);
		this.configPath = join(this.root, "remote-runtime-box.json");
		this.workspacePath = join(this.root, "workspace");
	}

	initializeDirectories(): void {
		for (const directory of [
			this.root,
			join(this.root, "skills"),
			join(this.root, "secrets"),
			join(this.root, "logs"),
			join(this.root, "cache"),
			this.workspacePath,
		]) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			chmodSync(directory, 0o700);
		}
	}

	isPaired(): boolean {
		return existsSync(this.configPath);
	}

	read(): RemoteRuntimeBoxConfig {
		if (!existsSync(this.configPath)) {
			throw new Error("Remote Runtime Box is not paired.");
		}
		const metadata = lstatSync(this.configPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Remote Runtime Box config must be a regular file.");
		}
		chmodSync(this.configPath, 0o600);
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(this.configPath, "utf8"));
		} catch (error) {
			throw new Error("Remote Runtime Box config is not valid JSON.", { cause: error });
		}
		return remoteRuntimeBoxConfigSchema.parse(value);
	}

	write(configValue: RemoteRuntimeBoxConfig): void {
		const config = remoteRuntimeBoxConfigSchema.parse(configValue);
		this.initializeDirectories();
		writePrivateJson(this.configPath, config);
	}

	nextConnectionIdentity(): {
		config: RemoteRuntimeBoxConfig;
		instanceId: string;
		generation: number;
	} {
		const config = this.read();
		const generation = config.generation + 1;
		if (!Number.isSafeInteger(generation)) {
			throw new Error("Remote Runtime Box generation exhausted the safe integer range.");
		}
		const updated = { ...config, generation };
		this.write(updated);
		return { config: updated, instanceId: randomUUID(), generation };
	}

	unpair(): void {
		if (!existsSync(this.configPath)) {
			return;
		}
		const metadata = lstatSync(this.configPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Remote Runtime Box config must be a regular file.");
		}
		unlinkSync(this.configPath);
	}
}

export function resolveRemoteRuntimeBoxRoot(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home = homedir(),
): string {
	const override = environment.MOSHU_RUNTIME_BOX_HOME?.trim();
	const path = platform === "win32" ? win32 : posix;
	if (override) {
		return path.resolve(override);
	}
	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", "Moshu", "runtime-box");
	}
	if (platform === "win32") {
		const localAppData = environment.LOCALAPPDATA?.trim();
		if (!localAppData) {
			throw new Error("LOCALAPPDATA is required for the Windows Runtime Box data root.");
		}
		return path.join(localAppData, "Moshu", "runtime-box");
	}
	if (platform === "linux") {
		return path.join(
			environment.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share"),
			"moshu",
			"runtime-box",
		);
	}
	throw new Error(`Unsupported Runtime Box platform: ${platform}.`);
}

export function normalizeRuntimeBaseUrl(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Runtime Box URL cannot contain credentials, query, or fragment.");
	}
	const loopback =
		url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Remote Runtime Box requires HTTPS; HTTP is allowed only for loopback.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function writePrivateJson(filename: string, value: unknown): void {
	const directory = dirname(filename);
	const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
	let renamed = false;
	try {
		writeFileSync(temporary, JSON.stringify(value), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		fsyncPath(temporary);
		renameSync(temporary, filename);
		renamed = true;
		chmodSync(filename, 0o600);
		fsyncPath(filename);
		if (process.platform !== "win32") {
			fsyncPath(directory);
		}
	} finally {
		if (!renamed && existsSync(temporary)) {
			unlinkSync(temporary);
		}
	}
}

function fsyncPath(filename: string): void {
	const descriptor = openSync(filename, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
