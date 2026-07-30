import Database from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	deleteRuntimeBoxMcpServerInputSchema,
	deleteRuntimeBoxSkillInputSchema,
	getRuntimeBoxInventoryChangesInputSchema,
	getRuntimeBoxSkillContentInputSchema,
	getRuntimeBoxSkillContentOutputSchema,
	installRuntimeBoxSkillInputSchema,
	listRuntimeBoxMcpServersOutputSchema,
	listRuntimeBoxSkillsOutputSchema,
	mcpToolDescriptorSchema,
	runtimeBoxInventoryChangeSchema,
	runtimeBoxInventoryChangesPageSchema,
	runtimeBoxInventoryChangedHintSchema,
	runtimeBoxInventoryResourceSchema,
	runtimeBoxInventorySnapshotSchema,
	runtimeBoxMcpServerSchema,
	runtimeBoxResourceMutationResultSchema,
	runtimeBoxSkillSchema,
	setRuntimeBoxMcpServerEnabledInputSchema,
	setRuntimeBoxSkillEnabledInputSchema,
	upsertRuntimeBoxMcpServerInputSchema,
	validateRuntimeBoxResourcesInputSchema,
	validateRuntimeBoxResourcesOutputSchema,
	type DeleteRuntimeBoxMcpServerInput,
	type DeleteRuntimeBoxSkillInput,
	type GetRuntimeBoxInventoryChangesInput,
	type GetRuntimeBoxSkillContentInput,
	type GetRuntimeBoxSkillContentOutput,
	type InstallRuntimeBoxSkillInput,
	type RuntimeBoxInventoryChange,
	type RuntimeBoxInventoryChangedHint,
	type RuntimeBoxInventoryChangesPage,
	type RuntimeBoxInventoryResource,
	type RuntimeBoxInventorySnapshot,
	type RuntimeBoxMcpServer,
	type McpToolDescriptor,
	type McpSecretInput,
	type McpTransportConfig,
	type RuntimeBoxResourceMutationResult,
	type RuntimeBoxResourceRef,
	type RuntimeBoxSkill,
	type SetRuntimeBoxMcpServerEnabledInput,
	type SetRuntimeBoxSkillEnabledInput,
	type UpsertRuntimeBoxMcpServerInput,
	type ValidateRuntimeBoxResourcesInput,
	type ValidateRuntimeBoxResourcesOutput,
	maxRuntimeBoxInventoryPayloadBytes,
	maxRuntimeBoxInventoryResources,
	maxRuntimeBoxSkillMarkdownBytes,
	maxRuntimeBoxSkillFileBytes,
} from "@moshu/contracts";
import {
	hashSkillFiles,
	prepareSkillPackage,
	skillDirectoryKey,
	type DecodedSkillFile,
} from "@moshu/skill-runtime";

import { ExecutorSecretStore } from "./executor-secret-store";

const runtimeResourceDatabaseVersion = 5;
const maxInventoryChangeRecords = 2_048;
const maxCommandResults = 1_024;
const inventoryPageSize = 64;

interface RuntimeResourceStoreOptions {
	readonly onInventoryChanged?: (hint: RuntimeBoxInventoryChangedHint) => void;
	readonly now?: () => number;
	readonly secretStore?: RuntimeMcpSecretStore;
}

export interface RuntimeMcpSecretStore {
	put(stableResourceId: string, secret: McpSecretInput): string;
	read(stableResourceId: string, locator: string): McpSecretInput;
	delete(locator: string): void;
	cleanupOrphans(referencedLocators: ReadonlySet<string>): void;
	fingerprint(secret: McpSecretInput): string;
}

export interface RuntimeMcpConnectionConfig {
	server: RuntimeBoxMcpServer;
	secret: McpSecretInput | undefined;
}

interface InventoryStateRow {
	epoch: string;
	revision: number;
	cursor_secret: string;
}

interface McpConfigRow {
	id: string;
	config_revision: number;
	version: string;
	content_hash: string;
	display_name: string;
	enabled: number;
	transport_json: string;
	secret_locator: string | null;
	health: "ready" | "stopped" | "error";
	tools_json: string;
	created_at_ms: number;
	updated_at_ms: number;
}

interface SkillRow {
	id: string;
	config_revision: number;
	current_version: string;
	enabled: number;
	source: string;
	created_at_ms: number;
	updated_at_ms: number;
	content_hash: string;
	metadata_json: string;
	installed_at_ms: number;
}

interface CommandResultRow {
	operation: string;
	request_digest: string;
	result_json: string;
}

interface InventoryChangeRow {
	revision: number;
	payload_json: string;
}

interface SkillVersionRow {
	content_hash: string;
	metadata_json: string;
	directory_name: string;
}

interface RetainedSecretRow {
	secret_locator: string;
}

export class RuntimeResourceVersionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResourceVersionConflictError";
	}
}

export class RuntimeResourceNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResourceNotFoundError";
	}
}

export class InventoryResyncRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InventoryResyncRequiredError";
	}
}

export class RuntimeResourceStore {
	readonly #root: string;
	readonly #skillsRoot: string;
	readonly #database: Database;
	readonly #secrets: RuntimeMcpSecretStore;
	#onInventoryChanged: ((hint: RuntimeBoxInventoryChangedHint) => void) | undefined;
	#onMcpConfigChanged:
		| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
		| undefined;
	readonly #now: () => number;

	constructor(root: string, options: RuntimeResourceStoreOptions = {}) {
		this.#root = resolve(root);
		this.#skillsRoot = join(this.#root, "skills");
		this.#onInventoryChanged = options.onInventoryChanged;
		this.#now = options.now ?? Date.now;
		ensurePrivateDirectory(this.#root);
		ensurePrivateDirectory(this.#skillsRoot);
		const databaseFile = join(this.#root, "runtime-box.db");
		if (existsSync(databaseFile)) {
			requirePrivateRegularFile(databaseFile);
		}
		this.#database = new Database(databaseFile, { create: true, strict: true });
		try {
			this.#database.exec(`
				PRAGMA foreign_keys = ON;
				PRAGMA busy_timeout = 5000;
				PRAGMA journal_mode = WAL;
				PRAGMA synchronous = FULL;
			`);
			this.#migrate();
			chmodSync(databaseFile, 0o600);
			for (const suffix of ["-wal", "-shm"]) {
				const artifact = `${databaseFile}${suffix}`;
				if (existsSync(artifact)) {
					chmodSync(artifact, 0o600);
				}
			}
			this.#secrets = options.secretStore ?? new ExecutorSecretStore(join(this.#root, "secrets"));
			this.#secrets.cleanupOrphans(new Set(this.#listSecretLocators()));
			this.#drainPendingSecretDeletions();
			this.#cleanupOrphanSkillDirectories();
		} catch (error) {
			this.#database.close();
			throw error;
		}
	}

	close(): void {
		this.#database.close();
	}

	setInventoryChangedListener(
		listener: ((hint: RuntimeBoxInventoryChangedHint) => void) | undefined,
	): void {
		this.#onInventoryChanged = listener;
	}

	setMcpConfigChangedListener(
		listener:
			| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
			| undefined,
	): void {
		this.#onMcpConfigChanged = listener;
	}

	listMcpServerIds(): readonly string[] {
		return this.#database
			.query<{ id: string }, []>("SELECT id FROM mcp_configs ORDER BY id ASC")
			.all()
			.map((row) => row.id);
	}

	getMcpConnectionConfig(stableResourceId: string): RuntimeMcpConnectionConfig {
		const row = this.#selectMcp(stableResourceId);
		if (row === undefined) {
			throw new RuntimeResourceNotFoundError("MCP Server was not found.");
		}
		return {
			server: buildMcpServer(row),
			secret:
				row.secret_locator === null
					? undefined
					: this.#secrets.read(stableResourceId, row.secret_locator),
		};
	}

	updateMcpRuntimeState(
		stableResourceId: string,
		health: "ready" | "stopped" | "error",
		toolsValue: readonly McpToolDescriptor[],
	): RuntimeBoxResourceMutationResult | undefined {
		const row = this.#selectMcp(stableResourceId);
		if (row === undefined) {
			return undefined;
		}
		const receivedTools = toolsValue.map((tool) => mcpToolDescriptorSchema.parse(tool));
		const previousToolValues = mcpToolDescriptorSchema.array().parse(JSON.parse(row.tools_json));
		const tools = health === "ready" ? receivedTools : previousToolValues;
		const previousTools = JSON.stringify(previousToolValues);
		const nextTools = JSON.stringify(tools);
		if (row.health === health && previousTools === nextTools) {
			return undefined;
		}
		const toolsChanged = previousTools !== nextTools;
		const version = toolsChanged ? crypto.randomUUID() : row.version;
		const contentHash = toolsChanged
			? sha256Canonical({ transport: JSON.parse(row.transport_json), tools })
			: row.content_hash;
		const descriptor = runtimeBoxInventoryResourceSchema.parse({
			resourceKind: "mcp",
			stableResourceId,
			version,
			contentHash,
			health,
			credentialConfigured: row.secret_locator !== null,
			mcpTools: tools,
		});
		this.#assertInventoryCapacity(descriptor);
		this.#assertMcpQueryCapacity(
			buildMcpServer({
				...row,
				version,
				content_hash: contentHash,
				health,
				tools_json: nextTools,
				updated_at_ms: this.#now(),
			}),
		);
		const result = this.#database.transaction(() => {
			this.#database
				.query(
					`UPDATE mcp_configs
					 SET version = ?, content_hash = ?, health = ?, tools_json = ?, updated_at_ms = ?
					 WHERE id = ?`,
				)
				.run(version, contentHash, health, nextTools, this.#now(), stableResourceId);
			const revision = this.#appendChange({
				category: toolsChanged ? "mcp_tool_schema" : "mcp",
				operation: "upsert",
				stableResourceId,
				descriptor,
			});
			const state = this.#getInventoryState();
			return runtimeBoxResourceMutationResultSchema.parse({
				stableResourceId,
				configRevision: row.config_revision,
				version,
				contentHash,
				inventoryEpoch: state.epoch,
				inventoryRevision: revision,
				descriptor,
				deleted: false,
			});
		})();
		this.#publishChange(result, [toolsChanged ? "mcp_tool_schema" : "mcp"]);
		return result;
	}

	getInventorySnapshot(input: {
		runtimeBoxId: string;
		runtimeBoxGeneration: number;
		capabilities: readonly string[];
	}): RuntimeBoxInventorySnapshot {
		const state = this.#getInventoryState();
		return runtimeBoxInventorySnapshotSchema.parse({
			runtimeBoxId: input.runtimeBoxId,
			runtimeBoxGeneration: input.runtimeBoxGeneration,
			inventoryEpoch: state.epoch,
			inventoryRevision: state.revision,
			generatedAt: new Date(this.#now()).toISOString(),
			capabilities: input.capabilities,
			resources: this.#listInventoryResources(),
		});
	}

	getInventoryChanges(
		inputValue: GetRuntimeBoxInventoryChangesInput,
	): RuntimeBoxInventoryChangesPage {
		const input = getRuntimeBoxInventoryChangesInputSchema.parse(inputValue);
		const state = this.#getInventoryState();
		if (input.inventoryEpoch !== state.epoch) {
			throw new InventoryResyncRequiredError("Runtime Box inventory epoch changed.");
		}
		const oldestAvailableRevision = this.#oldestAvailableRevision(state.revision);
		if (
			input.fromRevisionExclusive > state.revision ||
			input.fromRevisionExclusive < Math.max(0, oldestAvailableRevision - 1)
		) {
			throw new InventoryResyncRequiredError(
				"Runtime Box inventory change history is unavailable.",
			);
		}
		const cursor =
			input.cursor === undefined
				? {
						epoch: state.epoch,
						fromRevisionExclusive: input.fromRevisionExclusive,
						highWaterRevision: state.revision,
						nextRevision: input.fromRevisionExclusive + 1,
					}
				: this.#decodeCursor(input.cursor, state, input.fromRevisionExclusive);
		const rows = this.#database
			.query<InventoryChangeRow, [number, number]>(
				`SELECT revision, payload_json
				 FROM inventory_changes
				 WHERE revision >= ? AND revision <= ?
				 ORDER BY revision ASC
				 LIMIT ${inventoryPageSize}`,
			)
			.all(cursor.nextRevision, cursor.highWaterRevision);
		const changes: RuntimeBoxInventoryChange[] = [];
		for (const row of rows) {
			const parsed = runtimeBoxInventoryChangeSchema.parse(JSON.parse(row.payload_json));
			if (parsed.revision !== row.revision) {
				throw new Error("Runtime Box inventory change revision is inconsistent.");
			}
			const candidateBytes = Buffer.byteLength(
				JSON.stringify({
					inventoryEpoch: state.epoch,
					fromRevisionExclusive: input.fromRevisionExclusive,
					throughRevision: cursor.highWaterRevision,
					oldestAvailableRevision,
					changes: [...changes, parsed],
					nextCursor: "x".repeat(2_048),
				}),
				"utf8",
			);
			if (candidateBytes > maxRuntimeBoxInventoryPayloadBytes) {
				if (changes.length === 0) {
					throw new Error("One Runtime Box inventory change exceeds the RPC frame limit.");
				}
				break;
			}
			changes.push(parsed);
		}
		for (const [index, change] of changes.entries()) {
			if (change.revision !== cursor.nextRevision + index) {
				throw new InventoryResyncRequiredError("Runtime Box inventory change history has a gap.");
			}
		}
		const lastRevision =
			changes.length === 0 ? cursor.nextRevision - 1 : changes[changes.length - 1]?.revision;
		if (lastRevision === undefined) {
			throw new Error("Runtime Box inventory page did not produce a revision.");
		}
		if (lastRevision < cursor.highWaterRevision && changes.length === 0) {
			throw new InventoryResyncRequiredError("Runtime Box inventory change history has a gap.");
		}
		const nextCursor =
			lastRevision < cursor.highWaterRevision
				? this.#encodeCursor({
						...cursor,
						nextRevision: lastRevision + 1,
					})
				: undefined;
		return runtimeBoxInventoryChangesPageSchema.parse({
			inventoryEpoch: state.epoch,
			fromRevisionExclusive: input.fromRevisionExclusive,
			throughRevision: cursor.highWaterRevision,
			oldestAvailableRevision,
			changes,
			...(nextCursor === undefined ? {} : { nextCursor }),
		});
	}

	listMcpServers(runtimeBoxId: string) {
		return listRuntimeBoxMcpServersOutputSchema.parse({
			runtimeBoxId,
			items: this.#database
				.query<McpConfigRow, []>("SELECT * FROM mcp_configs ORDER BY id ASC")
				.all()
				.map(buildMcpServer),
		});
	}

	upsertMcpServer(inputValue: UpsertRuntimeBoxMcpServerInput): RuntimeBoxResourceMutationResult {
		const input = upsertRuntimeBoxMcpServerInputSchema.parse(inputValue);
		const digest = commandDigest(
			input,
			input.secret === undefined ? undefined : this.#secrets.fingerprint(input.secret),
		);
		const replay = this.#getCommandResult(input.commandId, "mcp.upsert", digest);
		if (replay !== undefined) {
			this.#drainPendingSecretDeletions();
			this.#onMcpConfigChanged?.({
				stableResourceId: replay.stableResourceId,
				operation: "upsert",
			});
			return replay;
		}
		const stableResourceId = input.stableResourceId ?? `mcp-${crypto.randomUUID().toLowerCase()}`;
		const existing = this.#selectMcp(stableResourceId);
		assertExpectedMcpConfig(existing, input.expectedConfigRevision, input.expectedVersion);
		const retainedSecretLocator = this.#selectRetainedSecret(stableResourceId);
		let nextSecretLocator = existing?.secret_locator ?? retainedSecretLocator ?? null;
		let createdSecretLocator: string | undefined;
		if (input.secret !== undefined) {
			createdSecretLocator = this.#secrets.put(stableResourceId, input.secret);
			nextSecretLocator = createdSecretLocator;
		} else if (input.clearSecret === true) {
			nextSecretLocator = null;
		}
		const effectiveSecret =
			input.secret ??
			(nextSecretLocator === null
				? undefined
				: this.#secrets.read(stableResourceId, nextSecretLocator));
		const transport = withSecretNames(input.transport, effectiveSecret);
		const transportJson = JSON.stringify(transport);
		const executionChanged =
			existing === undefined ||
			canonicalJson(JSON.parse(existing.transport_json)) !== canonicalJson(transport);
		const tools = executionChanged
			? []
			: mcpToolDescriptorSchema.array().parse(JSON.parse(existing.tools_json));
		const now = this.#now();
		const configRevision = (existing?.config_revision ?? 0) + 1;
		const version =
			executionChanged || existing === undefined ? crypto.randomUUID() : existing.version;
		const contentHash =
			executionChanged || existing === undefined
				? sha256Canonical({ transport, tools })
				: existing.content_hash;
		const previousSecretLocator = existing?.secret_locator ?? retainedSecretLocator;
		const credentialChanged = previousSecretLocator !== nextSecretLocator;
		const health: "ready" | "stopped" | "error" =
			!input.enabled || executionChanged || credentialChanged || existing === undefined
				? "stopped"
				: existing.health;
		const descriptor = runtimeBoxInventoryResourceSchema.parse({
			resourceKind: "mcp",
			stableResourceId,
			version,
			contentHash,
			health,
			credentialConfigured: nextSecretLocator !== null,
			mcpTools: tools,
		});
		try {
			this.#assertInventoryCapacity(descriptor);
			this.#assertMcpQueryCapacity(
				runtimeBoxMcpServerSchema.parse({
					stableResourceId,
					configRevision,
					version,
					contentHash,
					displayName: input.displayName,
					enabled: input.enabled,
					transport,
					credentialConfigured: nextSecretLocator !== null,
					health,
					tools,
					createdAt: new Date(existing?.created_at_ms ?? now).toISOString(),
					updatedAt: new Date(now).toISOString(),
				}),
			);
		} catch (error) {
			if (createdSecretLocator !== undefined) {
				this.#secrets.delete(createdSecretLocator);
			}
			throw error;
		}
		let result: RuntimeBoxResourceMutationResult;
		try {
			result = this.#database.transaction(() => {
				this.#database
					.query(
						`INSERT INTO mcp_configs (
							id, config_revision, version, content_hash, display_name, enabled, transport_json,
							secret_locator, health, tools_json, created_at_ms, updated_at_ms
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET
							config_revision = excluded.config_revision,
							version = excluded.version,
							content_hash = excluded.content_hash,
							display_name = excluded.display_name,
							enabled = excluded.enabled,
							transport_json = excluded.transport_json,
							secret_locator = excluded.secret_locator,
							health = excluded.health,
							tools_json = excluded.tools_json,
							updated_at_ms = excluded.updated_at_ms`,
					)
					.run(
						stableResourceId,
						configRevision,
						version,
						contentHash,
						input.displayName,
						input.enabled ? 1 : 0,
						transportJson,
						nextSecretLocator,
						health,
						JSON.stringify(tools),
						existing?.created_at_ms ?? now,
						now,
					);
				this.#database.query("DELETE FROM mcp_retained_secrets WHERE id = ?").run(stableResourceId);
				if (
					previousSecretLocator !== null &&
					previousSecretLocator !== undefined &&
					previousSecretLocator !== nextSecretLocator
				) {
					this.#database
						.query(
							`INSERT INTO mcp_pending_secret_deletions (secret_locator, created_at_ms)
							 VALUES (?, ?)
							 ON CONFLICT(secret_locator) DO NOTHING`,
						)
						.run(previousSecretLocator, now);
				}
				const revision = this.#appendChange({
					category: "mcp",
					operation: "upsert",
					stableResourceId,
					descriptor,
				});
				const state = this.#getInventoryState();
				const mutation = runtimeBoxResourceMutationResultSchema.parse({
					stableResourceId,
					configRevision,
					version,
					contentHash,
					inventoryEpoch: state.epoch,
					inventoryRevision: revision,
					descriptor,
					deleted: false,
				});
				this.#saveCommandResult(input.commandId, "mcp.upsert", digest, mutation);
				return mutation;
			})();
		} catch (error) {
			if (createdSecretLocator !== undefined) {
				this.#secrets.delete(createdSecretLocator);
			}
			throw error;
		}
		this.#drainPendingSecretDeletions();
		this.#publishChange(result, ["mcp", "mcp_tool_schema"]);
		this.#onMcpConfigChanged?.({ stableResourceId, operation: "upsert" });
		return result;
	}

	setMcpServerEnabled(
		inputValue: SetRuntimeBoxMcpServerEnabledInput,
	): RuntimeBoxResourceMutationResult {
		const input = setRuntimeBoxMcpServerEnabledInputSchema.parse(inputValue);
		const existing = this.#selectMcp(input.stableResourceId);
		if (existing === undefined) {
			throw new RuntimeResourceNotFoundError("MCP Server was not found.");
		}
		return this.upsertMcpServer({
			runtimeBoxId: input.runtimeBoxId,
			commandId: input.commandId,
			stableResourceId: input.stableResourceId,
			...(input.expectedConfigRevision === undefined
				? {}
				: { expectedConfigRevision: input.expectedConfigRevision }),
			expectedVersion: input.expectedVersion,
			displayName: existing.display_name,
			enabled: input.enabled,
			transport: JSON.parse(existing.transport_json),
		});
	}

	deleteMcpServer(inputValue: DeleteRuntimeBoxMcpServerInput): RuntimeBoxResourceMutationResult {
		const input = deleteRuntimeBoxMcpServerInputSchema.parse(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "mcp.delete", digest);
		if (replay !== undefined) {
			this.#drainPendingSecretDeletions();
			this.#onMcpConfigChanged?.({
				stableResourceId: replay.stableResourceId,
				operation: "delete",
			});
			return replay;
		}
		const existing = this.#selectMcp(input.stableResourceId);
		if (existing === undefined) {
			throw new RuntimeResourceNotFoundError("MCP Server was not found.");
		}
		assertExpectedMcpConfig(existing, input.expectedConfigRevision, input.expectedVersion);
		const retainedSecretLocator = this.#selectRetainedSecret(input.stableResourceId);
		const result = this.#database.transaction(() => {
			if (!input.deleteCredentials && existing.secret_locator !== null) {
				this.#database
					.query(
						`INSERT INTO mcp_retained_secrets (id, secret_locator)
						 VALUES (?, ?)
						 ON CONFLICT(id) DO UPDATE SET secret_locator = excluded.secret_locator`,
					)
					.run(input.stableResourceId, existing.secret_locator);
			} else {
				this.#database
					.query("DELETE FROM mcp_retained_secrets WHERE id = ?")
					.run(input.stableResourceId);
				for (const locator of new Set(
					[existing.secret_locator, retainedSecretLocator].filter(
						(value): value is string => typeof value === "string",
					),
				)) {
					this.#database
						.query(
							`INSERT INTO mcp_pending_secret_deletions (secret_locator, created_at_ms)
							 VALUES (?, ?)
							 ON CONFLICT(secret_locator) DO NOTHING`,
						)
						.run(locator, this.#now());
				}
			}
			this.#database.query("DELETE FROM mcp_configs WHERE id = ?").run(input.stableResourceId);
			const revision = this.#appendChange({
				category: "mcp",
				operation: "delete",
				stableResourceId: input.stableResourceId,
				tombstone: {
					resourceKind: "mcp",
					stableResourceId: input.stableResourceId,
					deletedVersion: existing.version,
				},
			});
			const state = this.#getInventoryState();
			const mutation = runtimeBoxResourceMutationResultSchema.parse({
				stableResourceId: input.stableResourceId,
				configRevision: existing.config_revision,
				version: existing.version,
				contentHash: existing.content_hash,
				inventoryEpoch: state.epoch,
				inventoryRevision: revision,
				deleted: true,
			});
			this.#saveCommandResult(input.commandId, "mcp.delete", digest, mutation);
			return mutation;
		})();
		this.#drainPendingSecretDeletions();
		this.#publishChange(result, ["mcp", "mcp_tool_schema"]);
		this.#onMcpConfigChanged?.({
			stableResourceId: input.stableResourceId,
			operation: "delete",
		});
		return result;
	}

	listSkills(runtimeBoxId: string) {
		return listRuntimeBoxSkillsOutputSchema.parse({
			runtimeBoxId,
			items: this.#selectSkills().map(buildSkill),
		});
	}

	installSkill(inputValue: InstallRuntimeBoxSkillInput): RuntimeBoxResourceMutationResult {
		const input = installRuntimeBoxSkillInputSchema.parse(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "skill.install", digest);
		if (replay !== undefined) {
			return replay;
		}
		const prepared = prepareSkillPackage(input.files, {
			ownerKind: "runtime-box",
			allowBundleFiles: true,
			allowExecutableFiles: true,
		});
		const stableResourceId = input.stableResourceId ?? prepared.metadata.name;
		const existing = this.#selectSkill(stableResourceId);
		assertExpectedSkillConfig(existing, input.expectedConfigRevision, input.expectedVersion);
		let contentChanged = existing?.content_hash !== prepared.contentHash;
		if (!contentChanged && existing !== undefined) {
			try {
				contentChanged =
					this.#hashStoredSkill(existing.id, existing.current_version) !== existing.content_hash;
			} catch {
				contentChanged = true;
			}
		}
		const configRevision = (existing?.config_revision ?? 0) + 1;
		const version =
			!contentChanged && existing !== undefined ? existing.current_version : crypto.randomUUID();
		const contentHash = prepared.contentHash;
		const directoryName = `${skillDirectoryKey(stableResourceId)}/${version}`;
		const targetDirectory = join(this.#skillsRoot, directoryName);
		const now = this.#now();
		const descriptor = runtimeBoxInventoryResourceSchema.parse({
			resourceKind: "skill",
			stableResourceId,
			configRevision,
			version,
			contentHash,
			health: input.enabled ? "ready" : "stopped",
		});
		this.#assertInventoryCapacity(descriptor);
		this.#assertSkillQueryCapacity(
			runtimeBoxSkillSchema.parse({
				stableResourceId,
				configRevision,
				version,
				contentHash,
				metadata: prepared.metadata,
				enabled: input.enabled,
				source: input.source,
				installedAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
			}),
		);
		if (contentChanged) {
			this.#writeSkillVersion(targetDirectory, prepared.files);
		}
		let result: RuntimeBoxResourceMutationResult;
		try {
			result = this.#database.transaction(() => {
				if (contentChanged) {
					this.#database
						.query(
							`INSERT INTO skill_versions (
								skill_id, version, content_hash, metadata_json, directory_name, installed_at_ms
							) VALUES (?, ?, ?, ?, ?, ?)`,
						)
						.run(
							stableResourceId,
							version,
							contentHash,
							JSON.stringify(prepared.metadata),
							directoryName,
							now,
						);
				}
				this.#database
					.query(
						`INSERT INTO skill_installations (
							id, config_revision, current_version, enabled, source, created_at_ms, updated_at_ms
						) VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET
							config_revision = excluded.config_revision,
							current_version = excluded.current_version,
							enabled = excluded.enabled,
							source = excluded.source,
							updated_at_ms = excluded.updated_at_ms`,
					)
					.run(
						stableResourceId,
						configRevision,
						version,
						input.enabled ? 1 : 0,
						input.source,
						existing?.created_at_ms ?? now,
						now,
					);
				const revision = this.#appendChange({
					category: "skill",
					operation: "upsert",
					stableResourceId,
					descriptor,
				});
				const state = this.#getInventoryState();
				const mutation = runtimeBoxResourceMutationResultSchema.parse({
					stableResourceId,
					configRevision,
					version,
					contentHash,
					inventoryEpoch: state.epoch,
					inventoryRevision: revision,
					descriptor,
					deleted: false,
				});
				this.#saveCommandResult(input.commandId, "skill.install", digest, mutation);
				return mutation;
			})();
		} catch (error) {
			if (contentChanged) {
				rmSync(targetDirectory, { recursive: true, force: true });
			}
			throw error;
		}
		this.#publishChange(result, ["skill"]);
		return result;
	}

	setSkillEnabled(inputValue: SetRuntimeBoxSkillEnabledInput): RuntimeBoxResourceMutationResult {
		const input = setRuntimeBoxSkillEnabledInputSchema.parse(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "skill.setEnabled", digest);
		if (replay !== undefined) {
			return replay;
		}
		const existing = this.#selectSkill(input.stableResourceId);
		if (existing === undefined) {
			throw new RuntimeResourceNotFoundError("Skill was not found.");
		}
		if (existing.config_revision !== input.expectedConfigRevision) {
			throw new RuntimeResourceVersionConflictError("Skill configuration changed.");
		}
		const configRevision = existing.config_revision + 1;
		const descriptor = runtimeBoxInventoryResourceSchema.parse({
			resourceKind: "skill",
			stableResourceId: existing.id,
			configRevision,
			version: existing.current_version,
			contentHash: existing.content_hash,
			health: input.enabled ? "ready" : "stopped",
		});
		const result = this.#database.transaction(() => {
			this.#database
				.query(
					`UPDATE skill_installations
					 SET config_revision = ?, enabled = ?, updated_at_ms = ?
					 WHERE id = ?`,
				)
				.run(configRevision, input.enabled ? 1 : 0, this.#now(), input.stableResourceId);
			const revision = this.#appendChange({
				category: "skill",
				operation: "upsert",
				stableResourceId: input.stableResourceId,
				descriptor,
			});
			const state = this.#getInventoryState();
			const mutation = runtimeBoxResourceMutationResultSchema.parse({
				stableResourceId: input.stableResourceId,
				configRevision,
				version: existing.current_version,
				contentHash: existing.content_hash,
				inventoryEpoch: state.epoch,
				inventoryRevision: revision,
				descriptor,
				deleted: false,
			});
			this.#saveCommandResult(input.commandId, "skill.setEnabled", digest, mutation);
			return mutation;
		})();
		this.#publishChange(result, ["skill"]);
		return result;
	}

	deleteSkill(inputValue: DeleteRuntimeBoxSkillInput): RuntimeBoxResourceMutationResult {
		const input = deleteRuntimeBoxSkillInputSchema.parse(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "skill.delete", digest);
		if (replay !== undefined) {
			return replay;
		}
		const existing = this.#selectSkill(input.stableResourceId);
		if (existing === undefined) {
			throw new RuntimeResourceNotFoundError("Skill was not found.");
		}
		if (
			input.expectedConfigRevision !== undefined &&
			existing.config_revision !== input.expectedConfigRevision
		) {
			throw new RuntimeResourceVersionConflictError("Skill configuration changed.");
		}
		assertExpectedVersion(existing.current_version, input.expectedVersion, "Skill");
		const contentRoots = this.#listSkillContentRoots(input.stableResourceId);
		const result = this.#database.transaction(() => {
			this.#database
				.query("DELETE FROM skill_installations WHERE id = ?")
				.run(input.stableResourceId);
			this.#database
				.query("DELETE FROM skill_versions WHERE skill_id = ?")
				.run(input.stableResourceId);
			const revision = this.#appendChange({
				category: "skill",
				operation: "delete",
				stableResourceId: input.stableResourceId,
				tombstone: {
					resourceKind: "skill",
					stableResourceId: input.stableResourceId,
					deletedVersion: existing.current_version,
				},
			});
			const state = this.#getInventoryState();
			const mutation = runtimeBoxResourceMutationResultSchema.parse({
				stableResourceId: input.stableResourceId,
				configRevision: existing.config_revision,
				version: existing.current_version,
				contentHash: existing.content_hash,
				inventoryEpoch: state.epoch,
				inventoryRevision: revision,
				deleted: true,
			});
			this.#saveCommandResult(input.commandId, "skill.delete", digest, mutation);
			return mutation;
		})();
		for (const contentRoot of contentRoots) {
			rmSync(join(this.#skillsRoot, contentRoot), {
				recursive: true,
				force: true,
			});
		}
		fsyncDirectory(this.#skillsRoot);
		this.#publishChange(result, ["skill"]);
		return result;
	}

	validateResources(
		runtimeBoxId: string,
		inputValue: ValidateRuntimeBoxResourcesInput,
	): ValidateRuntimeBoxResourcesOutput {
		const input = validateRuntimeBoxResourcesInputSchema.parse(inputValue);
		const resources: RuntimeBoxInventoryResource[] = [];
		const issues: Array<{
			ref: RuntimeBoxResourceRef;
			code: "WRONG_RUNTIME_BOX" | "MISSING" | "VERSION_MISMATCH" | "HASH_MISMATCH" | "NOT_READY";
			message: string;
		}> = [];
		for (const ref of input.refs) {
			if (ref.runtimeBoxId !== runtimeBoxId) {
				issues.push({
					ref,
					code: "WRONG_RUNTIME_BOX",
					message: "Resource belongs to another Runtime Box.",
				});
				continue;
			}
			const resource = this.#getInventoryResource(ref.resourceKind, ref.stableResourceId);
			if (resource === undefined) {
				issues.push({ ref, code: "MISSING", message: "Resource is not installed." });
				continue;
			}
			if (resource.version !== ref.version) {
				issues.push({
					ref,
					code: "VERSION_MISMATCH",
					message: "Resource version changed.",
				});
				continue;
			}
			if (resource.contentHash !== ref.contentHash) {
				issues.push({
					ref,
					code: "HASH_MISMATCH",
					message: "Resource content hash changed.",
				});
				continue;
			}
			if (resource.resourceKind === "skill") {
				const actualHash = this.#hashStoredSkill(ref.stableResourceId, ref.version);
				if (actualHash !== ref.contentHash) {
					issues.push({
						ref,
						code: "HASH_MISMATCH",
						message: "Skill content no longer matches its immutable version.",
					});
					continue;
				}
			}
			if (resource.health !== "ready") {
				issues.push({
					ref,
					code: "NOT_READY",
					message: "Resource is not ready.",
				});
				continue;
			}
			resources.push(resource);
		}
		return validateRuntimeBoxResourcesOutputSchema.parse({
			valid: issues.length === 0,
			resources,
			issues,
		});
	}

	getSkillContent(
		runtimeBoxId: string,
		inputValue: GetRuntimeBoxSkillContentInput,
	): GetRuntimeBoxSkillContentOutput {
		const input = getRuntimeBoxSkillContentInputSchema.parse(inputValue);
		const validation = this.validateResources(runtimeBoxId, { refs: [input.ref] });
		if (!validation.valid) {
			throw new RuntimeResourceVersionConflictError(
				validation.issues[0]?.message ?? "Skill resource validation failed.",
			);
		}
		const version = this.#selectSkillVersion(input.ref.stableResourceId, input.ref.version);
		if (version === undefined) {
			throw new RuntimeResourceNotFoundError("Skill version was not found.");
		}
		const skillMarkdown = readPrivateFile(
			join(this.#skillsRoot, version.directory_name, "SKILL.md"),
			maxRuntimeBoxSkillMarkdownBytes,
		).toString("utf8");
		return getRuntimeBoxSkillContentOutputSchema.parse({
			ref: input.ref,
			metadata: JSON.parse(version.metadata_json),
			skillMarkdown,
		});
	}

	#listSkillContentRoots(stableResourceId: string): string[] {
		return [
			...new Set(
				this.#database
					.query<{ directory_name: string }, [string]>(
						"SELECT directory_name FROM skill_versions WHERE skill_id = ?",
					)
					.all(stableResourceId)
					.map((row) => row.directory_name.split("/", 1)[0])
					.filter((value): value is string => value !== undefined && value.length > 0),
			),
		];
	}

	#migrate(): void {
		const version =
			this.#database.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version ?? 0;
		if (version > runtimeResourceDatabaseVersion) {
			throw new Error(
				`Runtime Box resource database version ${version} is unsupported; expected ${runtimeResourceDatabaseVersion}.`,
			);
		}
		if (version === runtimeResourceDatabaseVersion) {
			return;
		}
		if (version === 1 || version === 2 || version === 3 || version === 4) {
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				if (version === 1) {
					this.#database.exec(`
						CREATE TABLE mcp_retained_secrets (
							id TEXT PRIMARY KEY NOT NULL,
							secret_locator TEXT NOT NULL
						);
					`);
				}
				if (version <= 2) {
					this.#database.exec(
						"ALTER TABLE mcp_configs ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;",
					);
				}
				if (version <= 3) {
					this.#database.exec(`
						CREATE TABLE mcp_pending_secret_deletions (
							secret_locator TEXT PRIMARY KEY NOT NULL,
							created_at_ms INTEGER NOT NULL
						);
						DELETE FROM command_results WHERE operation = 'mcp.upsert';
					`);
				}
				if (!databaseColumnExists(this.#database, "skill_installations", "config_revision")) {
					this.#database.exec(`
						ALTER TABLE skill_installations
						ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
					`);
				}
				this.#database.exec(`
					DELETE FROM command_results WHERE operation LIKE 'skill.%';
					PRAGMA user_version = ${runtimeResourceDatabaseVersion};
				`);
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
			return;
		}
		if (version !== 0) {
			throw new Error(`Runtime Box resource database version ${version} is unsupported.`);
		}
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.exec(`
				CREATE TABLE inventory_state (
					id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
					epoch TEXT NOT NULL,
					revision INTEGER NOT NULL,
					cursor_secret TEXT NOT NULL
				);
				CREATE TABLE mcp_configs (
					id TEXT PRIMARY KEY NOT NULL,
					config_revision INTEGER NOT NULL,
					version TEXT NOT NULL,
					content_hash TEXT NOT NULL,
					display_name TEXT NOT NULL,
					enabled INTEGER NOT NULL,
					transport_json TEXT NOT NULL,
					secret_locator TEXT,
					health TEXT NOT NULL,
					tools_json TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL
				);
				CREATE TABLE mcp_retained_secrets (
					id TEXT PRIMARY KEY NOT NULL,
					secret_locator TEXT NOT NULL
				);
				CREATE TABLE mcp_pending_secret_deletions (
					secret_locator TEXT PRIMARY KEY NOT NULL,
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE skill_installations (
					id TEXT PRIMARY KEY NOT NULL,
					config_revision INTEGER NOT NULL,
					current_version TEXT NOT NULL,
					enabled INTEGER NOT NULL,
					source TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL
				);
				CREATE TABLE skill_versions (
					skill_id TEXT NOT NULL,
					version TEXT NOT NULL,
					content_hash TEXT NOT NULL,
					metadata_json TEXT NOT NULL,
					directory_name TEXT NOT NULL,
					installed_at_ms INTEGER NOT NULL,
					PRIMARY KEY (skill_id, version)
				);
				CREATE TABLE inventory_changes (
					revision INTEGER PRIMARY KEY NOT NULL,
					category TEXT NOT NULL,
					operation TEXT NOT NULL,
					stable_resource_id TEXT,
					payload_json TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL
				);
				CREATE TABLE command_results (
					command_id TEXT PRIMARY KEY NOT NULL,
					operation TEXT NOT NULL,
					request_digest TEXT NOT NULL,
					result_json TEXT NOT NULL,
					created_at_ms INTEGER NOT NULL
				);
				INSERT INTO inventory_state (id, epoch, revision, cursor_secret)
				VALUES (
					1,
					'${crypto.randomUUID()}',
					0,
					'${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}'
				);
				PRAGMA user_version = ${runtimeResourceDatabaseVersion};
			`);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	#getInventoryState(): InventoryStateRow {
		const state = this.#database
			.query<InventoryStateRow, []>(
				"SELECT epoch, revision, cursor_secret FROM inventory_state WHERE id = 1",
			)
			.get();
		if (state === null) {
			throw new Error("Runtime Box inventory state is missing.");
		}
		return state;
	}

	#listInventoryResources(): RuntimeBoxInventoryResource[] {
		return [
			...this.#database
				.query<McpConfigRow, []>("SELECT * FROM mcp_configs ORDER BY id ASC")
				.all()
				.map(buildMcpInventoryResource),
			...this.#selectSkills().map(buildSkillInventoryResource),
		];
	}

	#assertInventoryCapacity(descriptor: RuntimeBoxInventoryResource): void {
		const resources = this.#listInventoryResources().filter(
			(resource) =>
				resource.resourceKind !== descriptor.resourceKind ||
				resource.stableResourceId !== descriptor.stableResourceId,
		);
		resources.push(descriptor);
		if (resources.length > maxRuntimeBoxInventoryResources) {
			throw new RuntimeResourceVersionConflictError(
				"Runtime Box inventory resource capacity is exhausted.",
			);
		}
		const encodedBytes = Buffer.byteLength(
			JSON.stringify({
				runtimeBoxId: "x".repeat(128),
				runtimeBoxGeneration: Number.MAX_SAFE_INTEGER,
				inventoryEpoch: "00000000-0000-0000-0000-000000000000",
				inventoryRevision: Number.MAX_SAFE_INTEGER,
				generatedAt: new Date(0).toISOString(),
				capabilities: Array.from({ length: 128 }, () => "x".repeat(128)),
				resources,
			}),
			"utf8",
		);
		if (encodedBytes > maxRuntimeBoxInventoryPayloadBytes) {
			throw new RuntimeResourceVersionConflictError("Runtime Box inventory capacity is exhausted.");
		}
	}

	#assertMcpQueryCapacity(server: RuntimeBoxMcpServer): void {
		const servers = this.#database
			.query<McpConfigRow, []>("SELECT * FROM mcp_configs ORDER BY id ASC")
			.all()
			.filter((row) => row.id !== server.stableResourceId)
			.map(buildMcpServer);
		servers.push(server);
		if (
			servers.length > maxRuntimeBoxInventoryResources ||
			Buffer.byteLength(
				JSON.stringify({
					runtimeBoxId: "x".repeat(128),
					items: servers,
				}),
				"utf8",
			) > maxRuntimeBoxInventoryPayloadBytes
		) {
			throw new RuntimeResourceVersionConflictError("Runtime Box MCP query capacity is exhausted.");
		}
	}

	#assertSkillQueryCapacity(skill: RuntimeBoxSkill): void {
		const skills = this.#selectSkills()
			.filter((row) => row.id !== skill.stableResourceId)
			.map(buildSkill);
		skills.push(skill);
		if (
			skills.length > maxRuntimeBoxInventoryResources ||
			Buffer.byteLength(
				JSON.stringify({
					runtimeBoxId: "x".repeat(128),
					items: skills,
				}),
				"utf8",
			) > maxRuntimeBoxInventoryPayloadBytes
		) {
			throw new RuntimeResourceVersionConflictError(
				"Runtime Box Skill query capacity is exhausted.",
			);
		}
	}

	#getInventoryResource(
		kind: "mcp" | "skill",
		stableResourceId: string,
	): RuntimeBoxInventoryResource | undefined {
		if (kind === "mcp") {
			const row = this.#selectMcp(stableResourceId);
			return row === undefined ? undefined : buildMcpInventoryResource(row);
		}
		const row = this.#selectSkill(stableResourceId);
		return row === undefined ? undefined : buildSkillInventoryResource(row);
	}

	#selectMcp(stableResourceId: string): McpConfigRow | undefined {
		return (
			this.#database
				.query<McpConfigRow, [string]>("SELECT * FROM mcp_configs WHERE id = ?")
				.get(stableResourceId) ?? undefined
		);
	}

	#selectRetainedSecret(stableResourceId: string): string | undefined {
		return (
			this.#database
				.query<RetainedSecretRow, [string]>(
					"SELECT secret_locator FROM mcp_retained_secrets WHERE id = ?",
				)
				.get(stableResourceId)?.secret_locator ?? undefined
		);
	}

	#selectSkills(): SkillRow[] {
		return this.#database
			.query<SkillRow, []>(
				`SELECT
					i.id, i.config_revision, i.current_version, i.enabled, i.source,
					i.created_at_ms, i.updated_at_ms,
					v.content_hash, v.metadata_json, v.installed_at_ms
				 FROM skill_installations i
				 JOIN skill_versions v
				   ON v.skill_id = i.id AND v.version = i.current_version
				 ORDER BY i.id ASC`,
			)
			.all();
	}

	#selectSkill(stableResourceId: string): SkillRow | undefined {
		return (
			this.#database
				.query<SkillRow, [string]>(
					`SELECT
						i.id, i.config_revision, i.current_version, i.enabled, i.source,
						i.created_at_ms, i.updated_at_ms,
						v.content_hash, v.metadata_json, v.installed_at_ms
					 FROM skill_installations i
					 JOIN skill_versions v
					   ON v.skill_id = i.id AND v.version = i.current_version
					 WHERE i.id = ?`,
				)
				.get(stableResourceId) ?? undefined
		);
	}

	#selectSkillVersion(stableResourceId: string, version: string): SkillVersionRow | undefined {
		return (
			this.#database
				.query<SkillVersionRow, [string, string]>(
					`SELECT content_hash, metadata_json, directory_name
					 FROM skill_versions WHERE skill_id = ? AND version = ?`,
				)
				.get(stableResourceId, version) ?? undefined
		);
	}

	#appendChange(changeValue: Omit<RuntimeBoxInventoryChange, "revision">): number {
		const state = this.#getInventoryState();
		const revision = state.revision + 1;
		const change = runtimeBoxInventoryChangeSchema.parse({ revision, ...changeValue });
		this.#database
			.query(
				`INSERT INTO inventory_changes (
					revision, category, operation, stable_resource_id, payload_json, created_at_ms
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				revision,
				change.category,
				change.operation,
				change.stableResourceId ?? null,
				JSON.stringify(change),
				this.#now(),
			);
		this.#database.query("UPDATE inventory_state SET revision = ? WHERE id = 1").run(revision);
		this.#database
			.query("DELETE FROM inventory_changes WHERE revision <= ?")
			.run(Math.max(0, revision - maxInventoryChangeRecords));
		return revision;
	}

	#oldestAvailableRevision(currentRevision: number): number {
		const row = this.#database
			.query<{ revision: number | null }, []>(
				"SELECT MIN(revision) AS revision FROM inventory_changes",
			)
			.get();
		return row?.revision ?? currentRevision;
	}

	#getCommandResult(
		commandId: string,
		operation: string,
		requestDigest: string,
	): RuntimeBoxResourceMutationResult | undefined {
		const row =
			this.#database
				.query<CommandResultRow, [string]>(
					"SELECT operation, request_digest, result_json FROM command_results WHERE command_id = ?",
				)
				.get(commandId) ?? undefined;
		if (row === undefined) {
			return undefined;
		}
		if (row.operation !== operation || row.request_digest !== requestDigest) {
			throw new RuntimeResourceVersionConflictError(
				"Resource command ID was already used with different input.",
			);
		}
		return runtimeBoxResourceMutationResultSchema.parse(JSON.parse(row.result_json));
	}

	#saveCommandResult(
		commandId: string,
		operation: string,
		requestDigest: string,
		result: RuntimeBoxResourceMutationResult,
	): void {
		this.#database
			.query(
				`INSERT INTO command_results (
					command_id, operation, request_digest, result_json, created_at_ms
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(commandId, operation, requestDigest, JSON.stringify(result), this.#now());
		this.#database
			.query(
				`DELETE FROM command_results
			 WHERE command_id IN (
				SELECT command_id FROM command_results
				ORDER BY created_at_ms DESC, command_id DESC
				LIMIT -1 OFFSET ${maxCommandResults}
			 )`,
			)
			.run();
	}

	#publishChange(
		result: RuntimeBoxResourceMutationResult,
		categories: RuntimeBoxInventoryChangedHint["categories"],
	): void {
		this.#onInventoryChanged?.(
			runtimeBoxInventoryChangedHintSchema.parse({
				inventoryEpoch: result.inventoryEpoch,
				inventoryRevision: result.inventoryRevision,
				categories,
			}),
		);
	}

	#listSecretLocators(): string[] {
		return this.#database
			.query<{ secret_locator: string }, []>(
				`SELECT secret_locator FROM mcp_configs WHERE secret_locator IS NOT NULL
				 UNION
				 SELECT secret_locator FROM mcp_retained_secrets`,
			)
			.all()
			.map((row) => row.secret_locator);
	}

	#drainPendingSecretDeletions(): void {
		for (const row of this.#database
			.query<{ secret_locator: string }, []>(
				"SELECT secret_locator FROM mcp_pending_secret_deletions ORDER BY created_at_ms ASC",
			)
			.all()) {
			this.#secrets.delete(row.secret_locator);
			this.#database
				.query("DELETE FROM mcp_pending_secret_deletions WHERE secret_locator = ?")
				.run(row.secret_locator);
		}
	}

	#encodeCursor(cursor: InventoryCursor): string {
		const state = this.#getInventoryState();
		const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
		const signature = createHmac("sha256", Buffer.from(state.cursor_secret, "base64"))
			.update(payload)
			.digest("base64url");
		return `${payload}.${signature}`;
	}

	#decodeCursor(
		value: string,
		state: InventoryStateRow,
		fromRevisionExclusive: number,
	): InventoryCursor {
		const [payload, signature, extra] = value.split(".");
		if (payload === undefined || signature === undefined || extra !== undefined) {
			throw new InventoryResyncRequiredError("Runtime Box inventory cursor is invalid.");
		}
		const expected = createHmac("sha256", Buffer.from(state.cursor_secret, "base64"))
			.update(payload)
			.digest();
		const actual = Buffer.from(signature, "base64url");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			throw new InventoryResyncRequiredError("Runtime Box inventory cursor signature is invalid.");
		}
		const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("epoch" in parsed) ||
			parsed.epoch !== state.epoch ||
			!("fromRevisionExclusive" in parsed) ||
			parsed.fromRevisionExclusive !== fromRevisionExclusive ||
			!("highWaterRevision" in parsed) ||
			typeof parsed.highWaterRevision !== "number" ||
			parsed.highWaterRevision > state.revision ||
			!("nextRevision" in parsed) ||
			typeof parsed.nextRevision !== "number" ||
			parsed.nextRevision <= fromRevisionExclusive ||
			parsed.nextRevision > parsed.highWaterRevision
		) {
			throw new InventoryResyncRequiredError("Runtime Box inventory cursor is invalid.");
		}
		return {
			epoch: state.epoch,
			fromRevisionExclusive,
			highWaterRevision: parsed.highWaterRevision,
			nextRevision: parsed.nextRevision,
		};
	}

	#writeSkillVersion(targetDirectory: string, files: readonly DecodedSkillFile[]): void {
		const stagingDirectory = join(this.#skillsRoot, `.staging-${crypto.randomUUID()}`);
		ensurePrivateDirectory(stagingDirectory);
		fsyncDirectory(this.#skillsRoot);
		const createdDirectories = new Set<string>([stagingDirectory]);
		try {
			for (const file of files) {
				const filename = join(stagingDirectory, ...file.path.split("/"));
				ensurePrivateDirectory(dirname(filename));
				let directory = dirname(filename);
				while (directory !== stagingDirectory) {
					createdDirectories.add(directory);
					const parent = dirname(directory);
					if (parent === directory) {
						throw new Error("Skill package path escaped the staging directory.");
					}
					directory = parent;
				}
				const descriptor = openSync(
					filename,
					constants.O_CREAT |
						constants.O_EXCL |
						constants.O_WRONLY |
						(process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
					file.executable ? 0o700 : 0o600,
				);
				try {
					writeFileSync(descriptor, file.bytes);
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				chmodSync(filename, file.executable ? 0o700 : 0o600);
			}
			for (const directory of [...createdDirectories].sort(
				(left, right) => right.split("/").length - left.split("/").length,
			)) {
				fsyncDirectory(directory);
			}
			const targetParent = dirname(targetDirectory);
			ensurePrivateDirectory(targetParent);
			fsyncDirectory(this.#skillsRoot);
			renameSync(stagingDirectory, targetDirectory);
			fsyncDirectory(targetParent);
			fsyncDirectory(this.#skillsRoot);
		} catch (error) {
			rmSync(stagingDirectory, { recursive: true, force: true });
			throw error;
		}
	}

	#cleanupOrphanSkillDirectories(): void {
		const referenced = new Set(
			this.#database
				.query<{ directory_name: string }, []>("SELECT directory_name FROM skill_versions")
				.all()
				.map((row) => row.directory_name),
		);
		for (const skillEntry of readdirSync(this.#skillsRoot, { withFileTypes: true })) {
			const skillPath = join(this.#skillsRoot, skillEntry.name);
			if (skillEntry.name.startsWith(".staging-")) {
				rmSync(skillPath, { recursive: true, force: true });
				continue;
			}
			if (!skillEntry.isDirectory() || skillEntry.isSymbolicLink()) {
				throw new Error("Runtime Box Skill store contains an invalid entry.");
			}
			for (const versionEntry of readdirSync(skillPath, { withFileTypes: true })) {
				const relative = `${skillEntry.name}/${versionEntry.name}`;
				const versionPath = join(skillPath, versionEntry.name);
				if (!referenced.has(relative)) {
					rmSync(versionPath, { recursive: true, force: true });
				}
			}
			if (readdirSync(skillPath).length === 0) {
				rmSync(skillPath, { recursive: false, force: true });
			}
		}
		fsyncDirectory(this.#skillsRoot);
	}

	#hashStoredSkill(stableResourceId: string, version: string): string {
		const record = this.#selectSkillVersion(stableResourceId, version);
		if (record === undefined) {
			throw new RuntimeResourceNotFoundError("Skill version was not found.");
		}
		const root = join(this.#skillsRoot, record.directory_name);
		const files = listStoredSkillFiles(root).map((path) => {
			const filename = join(root, ...path.split("/"));
			const metadata = requirePrivateRegularFile(filename);
			return {
				path,
				executable: (metadata.mode & 0o100) !== 0,
				bytes: readPrivateFile(filename, maxRuntimeBoxSkillFileBytes),
			};
		});
		return hashSkillFiles(files);
	}
}

interface InventoryCursor {
	epoch: string;
	fromRevisionExclusive: number;
	highWaterRevision: number;
	nextRevision: number;
}

function buildMcpServer(row: McpConfigRow): RuntimeBoxMcpServer {
	return runtimeBoxMcpServerSchema.parse({
		stableResourceId: row.id,
		configRevision: row.config_revision,
		version: row.version,
		contentHash: row.content_hash,
		displayName: row.display_name,
		enabled: row.enabled === 1,
		transport: JSON.parse(row.transport_json),
		credentialConfigured: row.secret_locator !== null,
		health: row.health,
		tools: JSON.parse(row.tools_json),
		createdAt: new Date(row.created_at_ms).toISOString(),
		updatedAt: new Date(row.updated_at_ms).toISOString(),
	});
}

function buildMcpInventoryResource(row: McpConfigRow): RuntimeBoxInventoryResource {
	const server = buildMcpServer(row);
	return runtimeBoxInventoryResourceSchema.parse({
		resourceKind: "mcp",
		stableResourceId: server.stableResourceId,
		version: server.version,
		contentHash: server.contentHash,
		health: server.health,
		credentialConfigured: server.credentialConfigured,
		mcpTools: server.tools,
	});
}

function buildSkill(row: SkillRow): RuntimeBoxSkill {
	return runtimeBoxSkillSchema.parse({
		stableResourceId: row.id,
		configRevision: row.config_revision,
		version: row.current_version,
		contentHash: row.content_hash,
		metadata: JSON.parse(row.metadata_json),
		enabled: row.enabled === 1,
		source: row.source,
		installedAt: new Date(row.installed_at_ms).toISOString(),
		updatedAt: new Date(row.updated_at_ms).toISOString(),
	});
}

function buildSkillInventoryResource(row: SkillRow): RuntimeBoxInventoryResource {
	const skill = buildSkill(row);
	return runtimeBoxInventoryResourceSchema.parse({
		resourceKind: "skill",
		stableResourceId: skill.stableResourceId,
		configRevision: skill.configRevision,
		version: skill.version,
		contentHash: skill.contentHash,
		health: skill.enabled ? "ready" : "stopped",
	});
}

function assertExpectedVersion(
	actualVersion: string | undefined,
	expectedVersion: string | undefined,
	label: string,
): void {
	if (actualVersion === undefined) {
		if (expectedVersion !== undefined) {
			throw new RuntimeResourceVersionConflictError(`${label} does not exist.`);
		}
		return;
	}
	if (expectedVersion === undefined || expectedVersion !== actualVersion) {
		throw new RuntimeResourceVersionConflictError(`${label} version changed.`);
	}
}

function assertExpectedMcpConfig(
	row: McpConfigRow | undefined,
	expectedConfigRevision: number | undefined,
	expectedVersion: string | undefined,
): void {
	if (row === undefined) {
		if (expectedConfigRevision !== undefined || expectedVersion !== undefined) {
			throw new RuntimeResourceVersionConflictError("MCP Server does not exist.");
		}
		return;
	}
	if (expectedConfigRevision !== undefined) {
		if (row.config_revision !== expectedConfigRevision) {
			throw new RuntimeResourceVersionConflictError("MCP Server configuration changed.");
		}
		return;
	}
	assertExpectedVersion(row.version, expectedVersion, "MCP Server");
}

function assertExpectedSkillConfig(
	row: SkillRow | undefined,
	expectedConfigRevision: number | undefined,
	expectedVersion: string | undefined,
): void {
	if (row === undefined) {
		if (expectedConfigRevision !== undefined || expectedVersion !== undefined) {
			throw new RuntimeResourceVersionConflictError("Skill does not exist.");
		}
		return;
	}
	if (expectedConfigRevision !== undefined && row.config_revision !== expectedConfigRevision) {
		throw new RuntimeResourceVersionConflictError("Skill configuration changed.");
	}
	assertExpectedVersion(row.current_version, expectedVersion, "Skill");
}

function commandDigest(value: unknown, secretFingerprint?: string): string {
	return createHash("sha256")
		.update(canonicalJson(redactCommandSecrets(value, secretFingerprint)))
		.digest("hex");
}

function redactCommandSecrets(value: unknown, secretFingerprint?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactCommandSecrets(item, secretFingerprint));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => {
				if (key !== "secret" || item === null || typeof item !== "object") {
					return [key, redactCommandSecrets(item, secretFingerprint)];
				}
				const secret = item as {
					environment?: Record<string, unknown>;
					headers?: Record<string, unknown>;
				};
				return [
					key,
					{
						environmentKeys: Object.keys(secret.environment ?? {}).sort(),
						headerNames: Object.keys(secret.headers ?? {}).sort(),
						fingerprint: secretFingerprint,
					},
				];
			}),
		);
	}
	return value;
}

function withSecretNames(
	transport: McpTransportConfig,
	secret: McpSecretInput | undefined,
): McpTransportConfig {
	if (transport.type === "stdio") {
		return {
			...transport,
			environmentKeys: Object.keys(secret?.environment ?? {}).sort(),
		};
	}
	return {
		...transport,
		headerNames: Object.keys(secret?.headers ?? {}).sort(),
	};
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter((entry) => entry[1] !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	throw new TypeError("Value is not canonical JSON.");
}

function listStoredSkillFiles(root: string, relativeRoot = ""): string[] {
	const directory = relativeRoot.length === 0 ? root : join(root, ...relativeRoot.split("/"));
	const metadata = lstatSync(directory, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Skill version contains an invalid directory.");
	}
	const output: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
		if (entry.isSymbolicLink()) {
			throw new Error("Skill version cannot contain symbolic links.");
		}
		if (entry.isDirectory()) {
			output.push(...listStoredSkillFiles(root, relativePath));
		} else if (entry.isFile()) {
			output.push(relativePath);
		} else {
			throw new Error("Skill version contains an unsupported filesystem entry.");
		}
	}
	return output.sort();
}

function ensurePrivateDirectory(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Runtime Box private path must be a real directory.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	chmodSync(path, 0o700);
}

function requirePrivateRegularFile(path: string): Stats {
	const metadata = lstatSync(path, { bigint: false, throwIfNoEntry: true });
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("Runtime Box private file must be a regular file.");
	}
	assertOwnedByCurrentUser(metadata.uid);
	if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
		throw new Error("Runtime Box private file permissions are too broad.");
	}
	return metadata;
}

function readPrivateFile(path: string, maxBytes: number): Buffer {
	const metadata = requirePrivateRegularFile(path);
	if (metadata.size > maxBytes) {
		throw new Error("Runtime Box private file exceeds its size limit.");
	}
	const descriptor = openSync(
		path,
		constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
	);
	try {
		return readFileSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function assertOwnedByCurrentUser(uid: number): void {
	if (
		process.platform !== "win32" &&
		typeof process.getuid === "function" &&
		uid !== process.getuid()
	) {
		throw new Error("Runtime Box private storage is not owned by the current user.");
	}
}

function fsyncDirectory(path: string): void {
	if (process.platform === "win32") {
		return;
	}
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function databaseColumnExists(database: Database, table: string, column: string): boolean {
	return database
		.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
		.all()
		.some((entry) => entry.name === column);
}
