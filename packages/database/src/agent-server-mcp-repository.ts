import { createHash, randomUUID } from "node:crypto";
import {
	agentServerMcpResourceRefSchema,
	listMcpServersOutputSchema,
	mcpServerMutationResultSchema,
	mcpServerSummarySchema,
	mcpToolDescriptorSchema,
	mcpTransportConfigSchema,
	type AgentServerMcpResourceRef,
	type ListMcpServersOutput,
	type McpSecretInput,
	type McpServerMutationResult,
	type McpServerSummary,
	type McpToolDescriptor,
	type McpTransportConfig,
	type SetMcpServerEnabledInput,
	type UpsertMcpServerInput,
	type DeleteMcpServerInput,
} from "@moshu/contracts";
import { eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import {
	agentServerMcpCommandResultsTable,
	agentServerMcpPendingSecretDeletionsTable,
	agentServerMcpRetainedSecretsTable,
	agentServerMcpServersTable,
} from "./schema";

const agentServerOwner = { kind: "agent-server" } as const;
type AppDatabaseTransaction = Parameters<Parameters<AppDrizzleDatabase["transaction"]>[0]>[0];

export interface AgentServerMcpSecretStorePort {
	put(stableResourceId: string, secret: McpSecretInput): string;
	read(stableResourceId: string, locator: string): McpSecretInput;
	delete(locator: string): void;
	fingerprint(secret: McpSecretInput): string;
}

export class McpResourceNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpResourceNotFoundError";
	}
}

export class McpResourceVersionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpResourceVersionConflictError";
	}
}

export interface AgentServerMcpRepository {
	list(): ListMcpServersOutput;
	upsert(input: UpsertMcpServerInput): McpServerMutationResult;
	setEnabled(input: SetMcpServerEnabledInput): McpServerMutationResult;
	delete(input: DeleteMcpServerInput): McpServerMutationResult;
	resolveRefs(refs: readonly AgentServerMcpResourceRef[]): McpServerSummary[];
	listSecretLocators(): readonly string[];
	drainPendingSecretDeletions(): void;
	setMcpConfigChangedListener(
		listener:
			| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
			| undefined,
	): void;
	listMcpServerIds(): readonly string[];
	getMcpConnectionConfig(stableResourceId: string): {
		server: {
			stableResourceId: string;
			configRevision: number;
			version: string;
			contentHash: string;
			displayName: string;
			enabled: boolean;
			health: "ready" | "stopped" | "error";
			transport: McpTransportConfig;
			tools: readonly McpToolDescriptor[];
		};
		secret: McpSecretInput | undefined;
	};
	updateMcpRuntimeState(
		stableResourceId: string,
		health: "ready" | "stopped" | "error",
		tools: readonly McpToolDescriptor[],
	): void;
}

export class SqliteAgentServerMcpRepository implements AgentServerMcpRepository {
	#listener:
		| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
		| undefined;

	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly secrets: AgentServerMcpSecretStorePort,
		private readonly clock: { now(): number } = { now: Date.now },
		private readonly prepareDefaultStdioCwd?: (stableResourceId: string) => string,
	) {}

	list(): ListMcpServersOutput {
		return listMcpServersOutputSchema.parse({
			owner: agentServerOwner,
			items: this.orm
				.select()
				.from(agentServerMcpServersTable)
				.orderBy(agentServerMcpServersTable.id)
				.all()
				.map(buildSummary),
		});
	}

	upsert(inputValue: UpsertMcpServerInput): McpServerMutationResult {
		const input = requireAgentServerOwner(inputValue);
		const digest = commandDigest(
			input,
			input.secret === undefined ? undefined : this.secrets.fingerprint(input.secret),
		);
		const replay = this.#getCommandResult(input.commandId, "mcp.upsert", digest);
		if (replay !== undefined) {
			this.drainPendingSecretDeletions();
			this.#listener?.({
				stableResourceId: replay.stableResourceId,
				operation: "upsert",
			});
			return replay;
		}
		const stableResourceId = input.stableResourceId ?? `mcp-${input.commandId}`;
		const existing = this.#select(stableResourceId);
		assertExpectedConfigRevision(existing?.configRevision, input.expectedConfigRevision);
		const retained = this.#selectRetainedSecret(stableResourceId);
		let nextSecretLocator = existing?.secretLocator ?? retained ?? null;
		let createdSecretLocator: string | undefined;
		if (input.secret !== undefined) {
			createdSecretLocator = this.secrets.put(stableResourceId, input.secret);
			nextSecretLocator = createdSecretLocator;
		} else if (input.clearSecret === true) {
			nextSecretLocator = null;
		}
		const effectiveSecret =
			input.secret ??
			(nextSecretLocator === null
				? undefined
				: this.secrets.read(stableResourceId, nextSecretLocator));
		const transport = withSecretNames(
			input.transport.type === "stdio" &&
				input.transport.cwd === undefined &&
				this.prepareDefaultStdioCwd !== undefined
				? {
						...input.transport,
						cwd: this.prepareDefaultStdioCwd(stableResourceId),
					}
				: input.transport,
			effectiveSecret,
		);
		const transportJson = JSON.stringify(transport);
		const executionChanged =
			existing === undefined ||
			canonicalJson(JSON.parse(existing.transportJson)) !== canonicalJson(transport);
		const tools = executionChanged ? [] : parseTools(existing.toolsJson);
		const version = executionChanged || existing === undefined ? randomUUID() : existing.version;
		const contentHash =
			executionChanged || existing === undefined
				? resourceContentHash(transport, tools)
				: existing.contentHash;
		const now = this.clock.now();
		const configRevision = (existing?.configRevision ?? 0) + 1;
		const previousSecretLocator = existing?.secretLocator ?? retained;
		const credentialChanged = previousSecretLocator !== nextSecretLocator;
		const health: "ready" | "stopped" | "error" =
			!input.enabled || executionChanged || credentialChanged || existing === undefined
				? "stopped"
				: existing.health;
		let result: McpServerMutationResult;
		try {
			result = this.orm.transaction((transaction) => {
				transaction
					.insert(agentServerMcpServersTable)
					.values({
						id: stableResourceId,
						configRevision,
						version,
						contentHash,
						displayName: input.displayName,
						enabled: input.enabled,
						transportJson,
						secretLocator: nextSecretLocator,
						credentialConfigured: nextSecretLocator !== null,
						health,
						toolsJson: JSON.stringify(tools),
						createdAtMs: existing?.createdAtMs ?? now,
						updatedAtMs: now,
					})
					.onConflictDoUpdate({
						target: agentServerMcpServersTable.id,
						set: {
							configRevision,
							version,
							contentHash,
							displayName: input.displayName,
							enabled: input.enabled,
							transportJson,
							secretLocator: nextSecretLocator,
							credentialConfigured: nextSecretLocator !== null,
							health,
							toolsJson: JSON.stringify(tools),
							updatedAtMs: now,
						},
					})
					.run();
				transaction
					.delete(agentServerMcpRetainedSecretsTable)
					.where(eq(agentServerMcpRetainedSecretsTable.id, stableResourceId))
					.run();
				if (
					previousSecretLocator !== null &&
					previousSecretLocator !== undefined &&
					previousSecretLocator !== nextSecretLocator
				) {
					transaction
						.insert(agentServerMcpPendingSecretDeletionsTable)
						.values({
							secretLocator: previousSecretLocator,
							createdAtMs: now,
						})
						.onConflictDoNothing()
						.run();
				}
				const row = transaction
					.select()
					.from(agentServerMcpServersTable)
					.where(eq(agentServerMcpServersTable.id, stableResourceId))
					.get();
				if (row === undefined) {
					throw new Error("Agent Server MCP row disappeared after upsert.");
				}
				const mutation = mcpServerMutationResultSchema.parse({
					owner: agentServerOwner,
					stableResourceId,
					configRevision,
					version,
					contentHash,
					deleted: false,
					summary: buildSummary(row),
				});
				this.#saveCommandResult(transaction, input.commandId, "mcp.upsert", digest, mutation, now);
				return mutation;
			});
		} catch (error) {
			if (createdSecretLocator !== undefined) {
				this.secrets.delete(createdSecretLocator);
			}
			throw error;
		}
		this.drainPendingSecretDeletions();
		this.#listener?.({ stableResourceId, operation: "upsert" });
		return result;
	}

	setEnabled(inputValue: SetMcpServerEnabledInput): McpServerMutationResult {
		this.drainPendingSecretDeletions();
		const input = requireAgentServerOwner(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "mcp.setEnabled", digest);
		if (replay !== undefined) {
			this.#listener?.({
				stableResourceId: replay.stableResourceId,
				operation: "upsert",
			});
			return replay;
		}
		const existing = this.#require(input.stableResourceId);
		assertExpectedConfigRevision(existing.configRevision, input.expectedConfigRevision);
		const now = this.clock.now();
		const configRevision = existing.configRevision + 1;
		const result = this.orm.transaction((transaction) => {
			transaction
				.update(agentServerMcpServersTable)
				.set({
					configRevision,
					enabled: input.enabled,
					health: input.enabled ? existing.health : "stopped",
					updatedAtMs: now,
				})
				.where(eq(agentServerMcpServersTable.id, input.stableResourceId))
				.run();
			const updated = transaction
				.select()
				.from(agentServerMcpServersTable)
				.where(eq(agentServerMcpServersTable.id, input.stableResourceId))
				.get();
			if (updated === undefined) {
				throw new Error("Agent Server MCP row disappeared after enable update.");
			}
			const mutation = mcpServerMutationResultSchema.parse({
				owner: agentServerOwner,
				stableResourceId: updated.id,
				configRevision: updated.configRevision,
				version: updated.version,
				contentHash: updated.contentHash,
				deleted: false,
				summary: buildSummary(updated),
			});
			this.#saveCommandResult(
				transaction,
				input.commandId,
				"mcp.setEnabled",
				digest,
				mutation,
				now,
			);
			return mutation;
		});
		this.#listener?.({ stableResourceId: input.stableResourceId, operation: "upsert" });
		return result;
	}

	delete(inputValue: DeleteMcpServerInput): McpServerMutationResult {
		const input = requireAgentServerOwner(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "mcp.delete", digest);
		if (replay !== undefined) {
			this.drainPendingSecretDeletions();
			this.#listener?.({
				stableResourceId: replay.stableResourceId,
				operation: "delete",
			});
			return replay;
		}
		const existing = this.#require(input.stableResourceId);
		assertExpectedConfigRevision(existing.configRevision, input.expectedConfigRevision);
		const retained = this.#selectRetainedSecret(input.stableResourceId);
		const now = this.clock.now();
		const result = this.orm.transaction((transaction) => {
			if (!input.deleteCredentials && existing.secretLocator !== null) {
				transaction
					.insert(agentServerMcpRetainedSecretsTable)
					.values({
						id: input.stableResourceId,
						secretLocator: existing.secretLocator,
					})
					.onConflictDoUpdate({
						target: agentServerMcpRetainedSecretsTable.id,
						set: { secretLocator: existing.secretLocator },
					})
					.run();
			} else {
				transaction
					.delete(agentServerMcpRetainedSecretsTable)
					.where(eq(agentServerMcpRetainedSecretsTable.id, input.stableResourceId))
					.run();
				for (const locator of new Set(
					[existing.secretLocator, retained].filter(
						(value): value is string => typeof value === "string",
					),
				)) {
					transaction
						.insert(agentServerMcpPendingSecretDeletionsTable)
						.values({ secretLocator: locator, createdAtMs: now })
						.onConflictDoNothing()
						.run();
				}
			}
			transaction
				.delete(agentServerMcpServersTable)
				.where(eq(agentServerMcpServersTable.id, input.stableResourceId))
				.run();
			const mutation = mcpServerMutationResultSchema.parse({
				owner: agentServerOwner,
				stableResourceId: input.stableResourceId,
				configRevision: existing.configRevision,
				version: existing.version,
				contentHash: existing.contentHash,
				deleted: true,
			});
			this.#saveCommandResult(transaction, input.commandId, "mcp.delete", digest, mutation, now);
			return mutation;
		});
		this.drainPendingSecretDeletions();
		this.#listener?.({ stableResourceId: input.stableResourceId, operation: "delete" });
		return result;
	}

	resolveRefs(refValues: readonly AgentServerMcpResourceRef[]): McpServerSummary[] {
		return refValues.map((refValue) => {
			const ref = agentServerMcpResourceRefSchema.parse(refValue);
			const row = this.#require(ref.stableResourceId);
			if (row.version !== ref.version || row.contentHash !== ref.contentHash) {
				throw new McpResourceVersionConflictError(
					`Agent Server MCP ${ref.stableResourceId} version or content hash changed.`,
				);
			}
			if (!row.enabled || row.health !== "ready") {
				throw new McpResourceNotFoundError(
					`Agent Server MCP ${ref.stableResourceId} is not ready.`,
				);
			}
			return buildSummary(row);
		});
	}

	listSecretLocators(): readonly string[] {
		return [
			...this.orm
				.select({ locator: agentServerMcpServersTable.secretLocator })
				.from(agentServerMcpServersTable)
				.all()
				.flatMap((row) => (row.locator === null ? [] : [row.locator])),
			...this.orm
				.select({ locator: agentServerMcpRetainedSecretsTable.secretLocator })
				.from(agentServerMcpRetainedSecretsTable)
				.all()
				.map((row) => row.locator),
		];
	}

	drainPendingSecretDeletions(): void {
		for (const row of this.orm
			.select()
			.from(agentServerMcpPendingSecretDeletionsTable)
			.orderBy(agentServerMcpPendingSecretDeletionsTable.createdAtMs)
			.all()) {
			this.secrets.delete(row.secretLocator);
			this.orm
				.delete(agentServerMcpPendingSecretDeletionsTable)
				.where(eq(agentServerMcpPendingSecretDeletionsTable.secretLocator, row.secretLocator))
				.run();
		}
	}

	setMcpConfigChangedListener(
		listener:
			| ((change: { stableResourceId: string; operation: "upsert" | "delete" }) => void)
			| undefined,
	): void {
		this.#listener = listener;
	}

	listMcpServerIds(): readonly string[] {
		return this.orm
			.select({ id: agentServerMcpServersTable.id })
			.from(agentServerMcpServersTable)
			.orderBy(agentServerMcpServersTable.id)
			.all()
			.map((row) => row.id);
	}

	getMcpConnectionConfig(stableResourceId: string) {
		const row = this.#require(stableResourceId);
		return {
			server: {
				stableResourceId: row.id,
				configRevision: row.configRevision,
				version: row.version,
				contentHash: row.contentHash,
				displayName: row.displayName,
				enabled: row.enabled,
				health: row.health,
				transport: parseTransport(row.transportJson),
				tools: parseTools(row.toolsJson),
			},
			secret:
				row.secretLocator === null
					? undefined
					: this.secrets.read(stableResourceId, row.secretLocator),
		};
	}

	updateMcpRuntimeState(
		stableResourceId: string,
		health: "ready" | "stopped" | "error",
		toolValues: readonly McpToolDescriptor[],
	): void {
		const existing = this.#require(stableResourceId);
		const receivedTools = toolValues.map((tool) => mcpToolDescriptorSchema.parse(tool));
		const previousTools = parseTools(existing.toolsJson);
		const tools = health === "ready" ? receivedTools : previousTools;
		const toolsChanged = JSON.stringify(previousTools) !== JSON.stringify(tools);
		if (existing.health === health && !toolsChanged) {
			return;
		}
		const transport = parseTransport(existing.transportJson);
		const version = toolsChanged ? randomUUID() : existing.version;
		const contentHash = toolsChanged ? resourceContentHash(transport, tools) : existing.contentHash;
		this.orm
			.update(agentServerMcpServersTable)
			.set({
				version,
				contentHash,
				health,
				toolsJson: JSON.stringify(tools),
				updatedAtMs: this.clock.now(),
			})
			.where(eq(agentServerMcpServersTable.id, stableResourceId))
			.run();
	}

	#select(stableResourceId: string) {
		return this.orm
			.select()
			.from(agentServerMcpServersTable)
			.where(eq(agentServerMcpServersTable.id, stableResourceId))
			.get();
	}

	#require(stableResourceId: string) {
		const row = this.#select(stableResourceId);
		if (row === undefined) {
			throw new McpResourceNotFoundError("Agent Server MCP Server was not found.");
		}
		return row;
	}

	#selectRetainedSecret(stableResourceId: string): string | undefined {
		return this.orm
			.select({ locator: agentServerMcpRetainedSecretsTable.secretLocator })
			.from(agentServerMcpRetainedSecretsTable)
			.where(eq(agentServerMcpRetainedSecretsTable.id, stableResourceId))
			.get()?.locator;
	}

	#getCommandResult(
		commandId: string,
		operation: string,
		requestDigest: string,
	): McpServerMutationResult | undefined {
		const row = this.orm
			.select()
			.from(agentServerMcpCommandResultsTable)
			.where(eq(agentServerMcpCommandResultsTable.commandId, commandId))
			.get();
		if (row === undefined) {
			return undefined;
		}
		if (row.operation !== operation || row.requestDigest !== requestDigest) {
			throw new Error("MCP command ID was reused with a different request.");
		}
		return mcpServerMutationResultSchema.parse(JSON.parse(row.resultJson));
	}

	#saveCommandResult(
		transaction: AppDatabaseTransaction,
		commandId: string,
		operation: string,
		requestDigest: string,
		result: McpServerMutationResult,
		createdAtMs: number,
	): void {
		transaction
			.insert(agentServerMcpCommandResultsTable)
			.values({
				commandId,
				operation,
				requestDigest,
				resultJson: JSON.stringify(result),
				createdAtMs,
			})
			.run();
	}
}

function requireAgentServerOwner<T extends { owner: { kind: string } }>(input: T): T {
	if (input.owner.kind !== "agent-server") {
		throw new TypeError("Agent Server MCP repository cannot manage Runtime Box resources.");
	}
	return input;
}

function buildSummary(row: typeof agentServerMcpServersTable.$inferSelect): McpServerSummary {
	return mcpServerSummarySchema.parse({
		owner: agentServerOwner,
		stableResourceId: row.id,
		configRevision: row.configRevision,
		version: row.version,
		contentHash: row.contentHash,
		displayName: row.displayName,
		enabled: row.enabled,
		credentialConfigured: row.credentialConfigured,
		health: row.health,
		tools: parseTools(row.toolsJson),
		stale: false,
	});
}

function parseTransport(value: string): McpTransportConfig {
	return mcpTransportConfigSchema.parse(JSON.parse(value));
}

function parseTools(value: string): McpToolDescriptor[] {
	return mcpToolDescriptorSchema.array().parse(JSON.parse(value));
}

function assertExpectedConfigRevision(
	actual: number | undefined,
	expected: number | undefined,
): void {
	if (actual === undefined && expected !== undefined) {
		throw new McpResourceVersionConflictError("Cannot update a missing MCP Server.");
	}
	if (actual !== undefined && expected === undefined) {
		throw new McpResourceVersionConflictError(
			"MCP Server update requires its current config revision.",
		);
	}
	if (actual !== expected) {
		throw new McpResourceVersionConflictError("MCP Server config revision conflict.");
	}
}

function withSecretNames(
	transportValue: McpTransportConfig,
	secret: McpSecretInput | undefined,
): McpTransportConfig {
	const transport = mcpTransportConfigSchema.parse(transportValue);
	if (transport.type === "stdio") {
		return mcpTransportConfigSchema.parse({
			...transport,
			...(secret?.environment === undefined
				? {}
				: { environmentKeys: Object.keys(secret.environment).sort() }),
		});
	}
	return mcpTransportConfigSchema.parse({
		...transport,
		...(secret?.headers === undefined ? {} : { headerNames: Object.keys(secret.headers).sort() }),
	});
}

function resourceContentHash(
	transport: McpTransportConfig,
	tools: readonly McpToolDescriptor[],
): string {
	return createHash("sha256").update(canonicalJson({ transport, tools })).digest("hex");
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

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
