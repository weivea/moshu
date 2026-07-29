import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import {
	pairRemoteRuntimeBox,
	RemoteRuntimePermanentError,
	runRemoteRuntimeBox,
} from "./remote-client";
import { RemoteRuntimeBoxState } from "./remote-state";
import { RuntimeBoxServiceManager } from "./service-manager";
import { createExecutorToolRuntime } from "./tools";

export interface RuntimeBoxCliDependencies {
	createToolRuntime?: typeof createExecutorToolRuntime;
}

export async function runRuntimeBoxCli(
	args: readonly string[],
	write: (message: string) => void = console.log,
	dependencies: RuntimeBoxCliDependencies = {},
): Promise<number> {
	const command = args[0];
	const options = parseOptions(args.slice(1));
	const state = new RemoteRuntimeBoxState(options.get("data-dir"));
	switch (command) {
		case "pair": {
			const runtimeBaseUrl = requireOption(options, "url");
			const code = options.get("code") ?? (await Bun.stdin.text()).trim();
			if (!code) {
				throw new Error("Pairing code is required via stdin or --code.");
			}
			const displayName = options.get("name");
			const config = await pairRemoteRuntimeBox({
				state,
				runtimeBaseUrl,
				code,
				...(displayName === undefined ? {} : { displayName }),
				onStatus: (status) => write(JSON.stringify({ status })),
			});
			write(
				JSON.stringify({
					status: "paired",
					runtimeBoxId: config.runtimeBoxId,
					agentServerId: config.agentServerId,
				}),
			);
			return 0;
		}
		case "run": {
			const controller = new AbortController();
			const stop = () => controller.abort();
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			try {
				try {
					await runRemoteRuntimeBox({
						state,
						toolRuntime: await (dependencies.createToolRuntime ?? createExecutorToolRuntime)(),
						signal: controller.signal,
						onState: (status) => write(JSON.stringify({ status })),
					});
				} catch (error) {
					if (!(error instanceof RemoteRuntimePermanentError)) {
						throw error;
					}
					write(JSON.stringify({ status: "auth_failed", message: error.message }));
				}
				return 0;
			} finally {
				process.off("SIGINT", stop);
				process.off("SIGTERM", stop);
			}
		}
		case "status": {
			if (!state.isPaired()) {
				write(JSON.stringify({ paired: false }));
				return 1;
			}
			const config = state.read();
			write(
				JSON.stringify({
					paired: true,
					runtimeBoxId: config.runtimeBoxId,
					agentServerId: config.agentServerId,
					runtimeBaseUrl: config.runtimeBaseUrl,
					generation: config.generation,
					displayName: config.displayName,
				}),
			);
			return 0;
		}
		case "doctor": {
			const config = state.read();
			const privateKey = createPrivateKey({
				key: Buffer.from(config.privateKey, "base64url"),
				format: "der",
				type: "pkcs8",
			});
			const publicKey = createPublicKey({
				key: Buffer.from(config.publicKey, "base64url"),
				format: "der",
				type: "spki",
			});
			const probe = Buffer.from("moshu-runtime-box-doctor", "utf8");
			if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) {
				throw new Error("Runtime Box device key pair is inconsistent.");
			}
			state.initializeDirectories();
			write(
				JSON.stringify({
					ok: true,
					runtimeBoxId: config.runtimeBoxId,
					platform: process.platform,
					arch: process.arch,
				}),
			);
			return 0;
		}
		case "install": {
			const filename = await new RuntimeBoxServiceManager({ state }).install();
			write(JSON.stringify({ installed: true, service: filename }));
			return 0;
		}
		case "uninstall": {
			await new RuntimeBoxServiceManager({ state }).uninstall();
			write(JSON.stringify({ installed: false, dataPreserved: true }));
			return 0;
		}
		case "unpair": {
			await new RuntimeBoxServiceManager({ state }).uninstall();
			state.unpair();
			write(JSON.stringify({ paired: false, dataPreserved: true }));
			return 0;
		}
		case "help":
		case "--help":
		case "-h":
		case undefined:
			write(helpText);
			return 0;
		default:
			throw new Error(`Unknown Runtime Box command: ${command}`);
	}
}

const helpText = `Moshu Runtime Box

Commands:
  pair --url <https-url> [--name <name>] [--code <code>] [--data-dir <path>]
  run [--data-dir <path>]
  status [--data-dir <path>]
  doctor [--data-dir <path>]
  install [--data-dir <path>]
  uninstall [--data-dir <path>]
  unpair [--data-dir <path>]
`;

function parseOptions(args: readonly string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (name === undefined || !name.startsWith("--") || value === undefined) {
			throw new Error(`Invalid Runtime Box option near ${name ?? "end of command"}.`);
		}
		options.set(name.slice(2), value);
	}
	return options;
}

function requireOption(options: ReadonlyMap<string, string>, name: string): string {
	const value = options.get(name);
	if (!value) {
		throw new Error(`--${name} is required.`);
	}
	return value;
}
