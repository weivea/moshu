import Database from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultLocalRuntimeBoxId } from "@moshu/contracts";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type ActionRepository, SqliteActionRepository } from "./action-repository";
import {
	type AgentGlobalProfileRepository,
	SqliteAgentGlobalProfileRepository,
} from "./agent-global-profile-repository";
import {
	type AgentServerMcpRepository,
	type AgentServerMcpSecretStorePort,
	SqliteAgentServerMcpRepository,
} from "./agent-server-mcp-repository";
import {
	type AgentServerSkillContentStorePort,
	type AgentServerSkillRepository,
	SqliteAgentServerSkillRepository,
} from "./agent-server-skill-repository";
import {
	applyAppMigrations,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
} from "./migrations";
import { type ProjectRepository, SqliteProjectRepository } from "./project-repository";
import {
	type RemoteAccessRepository,
	SqliteRemoteAccessRepository,
} from "./remote-access-repository";
import { createRunJournalRepository, type RunJournalRepository } from "./run-journal-repository";
import {
	type RuntimeBoxInventoryRepository,
	SqliteRuntimeBoxInventoryRepository,
} from "./runtime-box-inventory-repository";
import {
	type RuntimeBoxPairingRepository,
	SqliteRuntimeBoxPairingRepository,
} from "./runtime-box-pairing-repository";
import { type RuntimeBoxRepository, SqliteRuntimeBoxRepository } from "./runtime-box-repository";
import {
	type RuntimeProfileRepository,
	SqliteRuntimeProfileRepository,
} from "./runtime-profile-repository";
import { appSchema } from "./schema";
import { createSessionRepository, type SessionRepository } from "./session-repository";

export type AppDrizzleDatabase = ReturnType<typeof drizzle>;

export interface AppDatabase {
	client: Database;
	orm: AppDrizzleDatabase;
	sessions: SessionRepository;
	runs: RunJournalRepository;
	actions: ActionRepository;
	runtimeBoxes: RuntimeBoxRepository;
	projects: ProjectRepository;
	runtimeBoxPairings: RuntimeBoxPairingRepository;
	remoteAccess: RemoteAccessRepository;
	runtimeBoxInventory: RuntimeBoxInventoryRepository;
	runtimeProfiles: RuntimeProfileRepository;
	agentGlobalProfiles: AgentGlobalProfileRepository;
	agentServerMcps: AgentServerMcpRepository;
	agentServerSkills: AgentServerSkillRepository;
	close(): void;
}

export const coordinatedDatabaseResetReason = "product-schema-cutover" as const;

export interface CoordinatedDatabaseResetResult {
	reset: boolean;
	reason?: typeof coordinatedDatabaseResetReason;
	previousProductVersion?: number;
}

export function prepareCoordinatedDatabaseReset(input: {
	productDatabase: string;
	beforeReset?: () => void;
}): CoordinatedDatabaseResetResult {
	const filename = requireDatabaseFilename(input.productDatabase);
	if (!existsSync(filename)) {
		return { reset: false };
	}
	const metadata = lstatSync(filename);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Product database path must be a regular file.");
	}
	const inspection = new Database(filename, { readonly: true, strict: true });
	let previousProductVersion: number;
	try {
		previousProductVersion = getDatabaseUserVersion(inspection);
	} finally {
		inspection.close();
	}
	if (previousProductVersion === currentAppDatabaseVersion) {
		return { reset: false };
	}
	const artifacts: string[] = [];
	for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
		if (existsSync(path)) {
			const pathMetadata = lstatSync(path);
			if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
				throw new Error("Product database artifact must be a regular file.");
			}
			artifacts.push(path);
		}
	}
	input.beforeReset?.();
	for (const path of artifacts) {
		rmSync(path);
	}
	return {
		reset: true,
		reason: coordinatedDatabaseResetReason,
		previousProductVersion,
	};
}

export function configureAppDatabase(client: Database): void {
	client.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
	`);
}

export function openAppDatabase(
	filename: string,
	options: {
		agentServerMcpSecrets?: AgentServerMcpSecretStorePort;
		prepareAgentServerMcpStdioCwd?: (stableResourceId: string) => string;
		agentServerSkillContent?: AgentServerSkillContentStorePort;
	} = {},
): AppDatabase {
	const normalized = requireDatabaseFilename(filename);
	mkdirSync(dirname(normalized), { recursive: true, mode: 0o700 });
	chmodSync(dirname(normalized), 0o700);
	const client = new Database(normalized, { create: true, strict: true });
	try {
		configureAppDatabase(client);
		applyAppMigrations(client);
	} catch (error) {
		client.close();
		throw error;
	}
	const orm = drizzle(client, { schema: appSchema });
	const runtimeBoxes = new SqliteRuntimeBoxRepository(orm);
	const projects = new SqliteProjectRepository(orm, runtimeBoxes);
	const agentServerMcpSecrets = options.agentServerMcpSecrets ?? createUnavailableMcpSecretStore();
	const agentServerSkillContent =
		options.agentServerSkillContent ?? createUnavailableSkillContentStore();
	const platform = requireSupportedPlatform(process.platform);
	runtimeBoxes.initializeDefault({
		schemaVersion: 1,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		kind: "local",
		displayName: "Local Runtime Box",
		runtimeBoxVersion: "unregistered",
		platform,
		arch: process.arch,
		capabilities: [],
	});
	return {
		client,
		orm,
		runtimeBoxes,
		runtimeBoxInventory: new SqliteRuntimeBoxInventoryRepository(orm, runtimeBoxes),
		runtimeProfiles: new SqliteRuntimeProfileRepository(orm, runtimeBoxes),
		agentGlobalProfiles: new SqliteAgentGlobalProfileRepository(orm),
		agentServerMcps: new SqliteAgentServerMcpRepository(
			orm,
			agentServerMcpSecrets,
			{ now: Date.now },
			options.prepareAgentServerMcpStdioCwd,
		),
		agentServerSkills: new SqliteAgentServerSkillRepository(orm, agentServerSkillContent),
		projects,
		runtimeBoxPairings: new SqliteRuntimeBoxPairingRepository(orm),
		remoteAccess: new SqliteRemoteAccessRepository(orm),
		sessions: createSessionRepository({ orm, runtimeBoxes, projects }),
		runs: createRunJournalRepository({ client, orm }),
		actions: new SqliteActionRepository(orm),
		close: () => client.close(),
	};
}

function createUnavailableSkillContentStore(): AgentServerSkillContentStorePort {
	return {
		writeVersion() {
			throw new Error("Agent Server Skill content store is not configured.");
		},
		readSkillMarkdown() {
			throw new Error("Agent Server Skill content store is not configured.");
		},
		verifyVersion() {
			throw new Error("Agent Server Skill content store is not configured.");
		},
		deleteVersion() {
			throw new Error("Agent Server Skill content store is not configured.");
		},
		cleanupOrphans() {
			throw new Error("Agent Server Skill content store is not configured.");
		},
	};
}

function createUnavailableMcpSecretStore(): AgentServerMcpSecretStorePort {
	return {
		put() {
			throw new Error("Agent Server MCP SecretStore is not configured.");
		},
		read() {
			throw new Error("Agent Server MCP SecretStore is not configured.");
		},
		delete() {
			throw new Error("Agent Server MCP SecretStore is not configured.");
		},
		fingerprint() {
			throw new Error("Agent Server MCP SecretStore is not configured.");
		},
	};
}

function requireSupportedPlatform(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
	if (platform === "darwin" || platform === "win32" || platform === "linux") {
		return platform;
	}
	throw new Error(`Unsupported Runtime Box platform: ${platform}.`);
}

function requireDatabaseFilename(value: string): string {
	if (value.trim().length === 0) {
		throw new TypeError("A product database filename is required.");
	}
	if (value === ":memory:") {
		return value;
	}
	return resolve(value);
}
