import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	type KeyObject,
	verify,
} from "node:crypto";
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
import { dirname } from "node:path";

interface StoredAgentServerIdentity {
	schemaVersion: 1;
	agentServerId: string;
	publicKey: string;
	privateKey: string;
}

export class AgentServerIdentity {
	readonly agentServerId: string;
	readonly publicKey: string;
	readonly #privateKey: KeyObject;

	private constructor(record: StoredAgentServerIdentity) {
		this.agentServerId = record.agentServerId;
		this.publicKey = record.publicKey;
		this.#privateKey = createPrivateKey({
			key: Buffer.from(record.privateKey, "base64url"),
			format: "der",
			type: "pkcs8",
		});
		const publicKey = createPublicKey({
			key: Buffer.from(record.publicKey, "base64url"),
			format: "der",
			type: "spki",
		});
		const probe = Buffer.from("moshu-agent-server-identity-check", "utf8");
		if (!verify(null, probe, publicKey, sign(null, probe, this.#privateKey))) {
			throw new Error("Agent Server identity public key does not match its private key.");
		}
	}

	static open(filename: string): AgentServerIdentity {
		if (existsSync(filename)) {
			const metadata = lstatSync(filename);
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new Error("Agent Server identity must be a regular file.");
			}
			chmodSync(filename, 0o600);
			return new AgentServerIdentity(parseStoredIdentity(readFileSync(filename, "utf8")));
		}
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const record: StoredAgentServerIdentity = {
			schemaVersion: 1,
			agentServerId: randomUUID(),
			publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
			privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
		};
		writeIdentity(filename, record);
		return new AgentServerIdentity(record);
	}

	sign(payload: string): string {
		return sign(null, Buffer.from(payload, "utf8"), this.#privateKey).toString("base64url");
	}
}

function parseStoredIdentity(input: string): StoredAgentServerIdentity {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch (error) {
		throw new Error("Agent Server identity is not valid JSON.", { cause: error });
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("agentServerId" in value) ||
		typeof value.agentServerId !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(value.agentServerId) ||
		!("publicKey" in value) ||
		typeof value.publicKey !== "string" ||
		!("privateKey" in value) ||
		typeof value.privateKey !== "string"
	) {
		throw new Error("Agent Server identity has an invalid shape.");
	}
	return {
		schemaVersion: 1,
		agentServerId: value.agentServerId,
		publicKey: value.publicKey,
		privateKey: value.privateKey,
	};
}

function writeIdentity(filename: string, record: StoredAgentServerIdentity): void {
	const directory = dirname(filename);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
	let renamed = false;
	try {
		writeFileSync(temporary, JSON.stringify(record), {
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
