import { createHash, randomUUID } from "node:crypto";

import {
	agentServerSkillResourceRefSchema,
	listSkillsOutputSchema,
	skillMetadataSchema,
	skillMutationResultSchema,
	skillSummarySchema,
	type AgentServerSkillResourceRef,
	type DeleteSkillInput,
	type ListSkillsOutput,
	type SetSkillEnabledInput,
	type SkillMutationResult,
	type SkillSummary,
	type UpsertSkillInput,
} from "@moshu/contracts";
import { prepareSkillPackage, type DecodedSkillFile } from "@moshu/skill-runtime";
import { and, eq, inArray } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import {
	agentServerSkillCommandResultsTable,
	agentServerSkillInstallationsTable,
	agentServerSkillPendingContentDeletionsTable,
	agentServerSkillVersionsTable,
} from "./schema";

const agentServerOwner = { kind: "agent-server" } as const;
const maxCommandResults = 1_024;
type AppDatabaseTransaction = Parameters<Parameters<AppDrizzleDatabase["transaction"]>[0]>[0];

export interface AgentServerSkillContentStorePort {
	writeVersion(
		stableResourceId: string,
		version: string,
		files: readonly DecodedSkillFile[],
	): string;
	readSkillMarkdown(locator: string): string;
	verifyVersion(locator: string, expectedHash: string): void;
	deleteVersion(locator: string): void;
	cleanupOrphans(referencedLocators: ReadonlySet<string>): void;
}

export class SkillResourceNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillResourceNotFoundError";
	}
}

export class SkillResourceVersionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillResourceVersionConflictError";
	}
}

export class SkillOwnerCapabilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillOwnerCapabilityError";
	}
}

export class SkillPackageValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SkillPackageValidationError";
	}
}

export interface ResolvedAgentServerSkill {
	summary: SkillSummary;
	skillMarkdown: string;
}

export interface AgentServerSkillRepository {
	list(): ListSkillsOutput;
	upsert(input: UpsertSkillInput): SkillMutationResult;
	setEnabled(input: SetSkillEnabledInput): SkillMutationResult;
	delete(input: DeleteSkillInput): SkillMutationResult;
	resolveRefs(refs: readonly AgentServerSkillResourceRef[]): ResolvedAgentServerSkill[];
	reconcileContent(): void;
	drainPendingContentDeletions(): void;
}

export class SqliteAgentServerSkillRepository implements AgentServerSkillRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly content: AgentServerSkillContentStorePort,
		private readonly clock: { now(): number } = { now: Date.now },
	) {}

	list(): ListSkillsOutput {
		return listSkillsOutputSchema.parse({
			owner: agentServerOwner,
			items: this.orm
				.select()
				.from(agentServerSkillInstallationsTable)
				.orderBy(agentServerSkillInstallationsTable.id)
				.all()
				.map((installation) =>
					buildSummary(
						installation,
						this.#requireVersion(installation.id, installation.currentVersion),
					),
				),
		});
	}

	upsert(inputValue: UpsertSkillInput): SkillMutationResult {
		const input = requireAgentServerOwner(inputValue);
		if (
			input.files.length !== 1 ||
			input.files[0]?.path !== "SKILL.md" ||
			input.files[0].executable
		) {
			throw new SkillOwnerCapabilityError(
				"Agent Server-owned Skills may only contain one non-executable SKILL.md.",
			);
		}
		let prepared: ReturnType<typeof prepareSkillPackage>;
		try {
			prepared = prepareSkillPackage(input.files, {
				ownerKind: "agent-server",
				allowBundleFiles: false,
				allowExecutableFiles: false,
			});
		} catch (error) {
			throw new SkillPackageValidationError("The Skill package is invalid.", { cause: error });
		}
		const digest = commandDigest({
			...input,
			files: input.files.map((file) => ({
				path: file.path,
				encoding: file.encoding,
				executable: file.executable,
			})),
			contentHash: prepared.contentHash,
		});
		const replay = this.#getCommandResult(input.commandId, "skill.upsert", digest);
		if (replay !== undefined) {
			this.drainPendingContentDeletions();
			return replay;
		}
		const stableResourceId = input.stableResourceId ?? prepared.metadata.name;
		const existing = this.#selectInstallation(stableResourceId);
		assertExpectedSkill(
			existing?.configRevision,
			existing?.currentVersion,
			input.expectedConfigRevision,
			input.expectedVersion,
		);
		const existingVersion =
			existing === undefined
				? undefined
				: this.#requireVersion(stableResourceId, existing.currentVersion);
		let contentChanged = existingVersion?.contentHash !== prepared.contentHash;
		if (!contentChanged && existingVersion !== undefined) {
			try {
				this.content.verifyVersion(existingVersion.contentLocator, existingVersion.contentHash);
			} catch {
				contentChanged = true;
			}
		}
		const version =
			!contentChanged && existing !== undefined ? existing.currentVersion : randomUUID();
		const now = this.clock.now();
		const configRevision = (existing?.configRevision ?? 0) + 1;
		let createdLocator: string | undefined;
		if (contentChanged) {
			createdLocator = this.content.writeVersion(stableResourceId, version, prepared.files);
		}
		try {
			const result = this.orm.transaction((transaction) => {
				if (contentChanged) {
					if (createdLocator === undefined) {
						throw new Error("Agent Server Skill content locator was not created.");
					}
					transaction
						.insert(agentServerSkillVersionsTable)
						.values({
							skillId: stableResourceId,
							version,
							contentHash: prepared.contentHash,
							metadataJson: JSON.stringify(prepared.metadata),
							contentLocator: createdLocator,
							installedAtMs: now,
						})
						.run();
				}
				transaction
					.insert(agentServerSkillInstallationsTable)
					.values({
						id: stableResourceId,
						configRevision,
						currentVersion: version,
						enabled: input.enabled,
						sourceKind: input.source.kind,
						sourceLabel: input.source.label ?? null,
						health: input.enabled ? "ready" : "stopped",
						lastErrorCode: null,
						createdAtMs: existing?.createdAtMs ?? now,
						updatedAtMs: now,
					})
					.onConflictDoUpdate({
						target: agentServerSkillInstallationsTable.id,
						set: {
							configRevision,
							currentVersion: version,
							enabled: input.enabled,
							sourceKind: input.source.kind,
							sourceLabel: input.source.label ?? null,
							health: input.enabled ? "ready" : "stopped",
							lastErrorCode: null,
							updatedAtMs: now,
						},
					})
					.run();
				const installation = requireTransactionInstallation(transaction, stableResourceId);
				const versionRow = requireTransactionVersion(transaction, stableResourceId, version);
				const mutation = skillMutationResultSchema.parse({
					owner: agentServerOwner,
					stableResourceId,
					configRevision,
					version,
					contentHash: prepared.contentHash,
					deleted: false,
					summary: buildSummary(installation, versionRow),
				});
				this.#saveCommandResult(
					transaction,
					input.commandId,
					"skill.upsert",
					digest,
					mutation,
					now,
				);
				return mutation;
			});
			this.drainPendingContentDeletions();
			return result;
		} catch (error) {
			if (createdLocator !== undefined) {
				this.content.deleteVersion(createdLocator);
			}
			throw error;
		}
	}

	setEnabled(inputValue: SetSkillEnabledInput): SkillMutationResult {
		const input = requireAgentServerOwner(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "skill.setEnabled", digest);
		if (replay !== undefined) {
			return replay;
		}
		const existing = this.#requireInstallation(input.stableResourceId);
		if (existing.configRevision !== input.expectedConfigRevision) {
			throw new SkillResourceVersionConflictError("Skill config revision conflict.");
		}
		const now = this.clock.now();
		const configRevision = existing.configRevision + 1;
		return this.orm.transaction((transaction) => {
			transaction
				.update(agentServerSkillInstallationsTable)
				.set({
					configRevision,
					enabled: input.enabled,
					health: input.enabled ? "ready" : "stopped",
					lastErrorCode: null,
					updatedAtMs: now,
				})
				.where(eq(agentServerSkillInstallationsTable.id, input.stableResourceId))
				.run();
			const installation = requireTransactionInstallation(transaction, input.stableResourceId);
			const version = requireTransactionVersion(
				transaction,
				input.stableResourceId,
				installation.currentVersion,
			);
			const mutation = skillMutationResultSchema.parse({
				owner: agentServerOwner,
				stableResourceId: installation.id,
				configRevision,
				version: installation.currentVersion,
				contentHash: version.contentHash,
				deleted: false,
				summary: buildSummary(installation, version),
			});
			this.#saveCommandResult(
				transaction,
				input.commandId,
				"skill.setEnabled",
				digest,
				mutation,
				now,
			);
			return mutation;
		});
	}

	delete(inputValue: DeleteSkillInput): SkillMutationResult {
		const input = requireAgentServerOwner(inputValue);
		const digest = commandDigest(input);
		const replay = this.#getCommandResult(input.commandId, "skill.delete", digest);
		if (replay !== undefined) {
			this.drainPendingContentDeletions();
			return replay;
		}
		const existing = this.#requireInstallation(input.stableResourceId);
		if (
			existing.configRevision !== input.expectedConfigRevision ||
			existing.currentVersion !== input.expectedVersion
		) {
			throw new SkillResourceVersionConflictError("Skill configuration or version changed.");
		}
		const currentVersion = this.#requireVersion(input.stableResourceId, input.expectedVersion);
		const versions = this.orm
			.select()
			.from(agentServerSkillVersionsTable)
			.where(eq(agentServerSkillVersionsTable.skillId, input.stableResourceId))
			.all();
		const now = this.clock.now();
		const result = this.orm.transaction((transaction) => {
			for (const version of versions) {
				transaction
					.insert(agentServerSkillPendingContentDeletionsTable)
					.values({ contentLocator: version.contentLocator, createdAtMs: now })
					.onConflictDoNothing()
					.run();
			}
			transaction
				.delete(agentServerSkillVersionsTable)
				.where(eq(agentServerSkillVersionsTable.skillId, input.stableResourceId))
				.run();
			transaction
				.delete(agentServerSkillInstallationsTable)
				.where(eq(agentServerSkillInstallationsTable.id, input.stableResourceId))
				.run();
			const mutation = skillMutationResultSchema.parse({
				owner: agentServerOwner,
				stableResourceId: input.stableResourceId,
				configRevision: existing.configRevision,
				version: existing.currentVersion,
				contentHash: currentVersion.contentHash,
				deleted: true,
			});
			this.#saveCommandResult(transaction, input.commandId, "skill.delete", digest, mutation, now);
			return mutation;
		});
		this.drainPendingContentDeletions();
		return result;
	}

	resolveRefs(refValues: readonly AgentServerSkillResourceRef[]): ResolvedAgentServerSkill[] {
		return refValues.map((refValue) => {
			const ref = agentServerSkillResourceRefSchema.parse(refValue);
			const installation = this.#requireInstallation(ref.stableResourceId);
			const version = this.#requireVersion(ref.stableResourceId, installation.currentVersion);
			if (installation.currentVersion !== ref.version || version.contentHash !== ref.contentHash) {
				throw new SkillResourceVersionConflictError(
					`Agent Server Skill ${ref.stableResourceId} version or content hash changed.`,
				);
			}
			if (!installation.enabled || installation.health !== "ready") {
				throw new SkillResourceNotFoundError(
					`Agent Server Skill ${ref.stableResourceId} is not ready.`,
				);
			}
			this.content.verifyVersion(version.contentLocator, version.contentHash);
			return {
				summary: buildSummary(installation, version),
				skillMarkdown: this.content.readSkillMarkdown(version.contentLocator),
			};
		});
	}

	reconcileContent(): void {
		const referenced = new Set(
			this.orm
				.select({ contentLocator: agentServerSkillVersionsTable.contentLocator })
				.from(agentServerSkillVersionsTable)
				.all()
				.map((version) => version.contentLocator),
		);
		for (const installation of this.orm.select().from(agentServerSkillInstallationsTable).all()) {
			const version = this.#requireVersion(installation.id, installation.currentVersion);
			try {
				this.content.verifyVersion(version.contentLocator, version.contentHash);
				this.orm
					.update(agentServerSkillInstallationsTable)
					.set({
						health: installation.enabled ? "ready" : "stopped",
						lastErrorCode: null,
						updatedAtMs: this.clock.now(),
					})
					.where(eq(agentServerSkillInstallationsTable.id, installation.id))
					.run();
			} catch {
				this.orm
					.update(agentServerSkillInstallationsTable)
					.set({
						health: "error",
						lastErrorCode: "SKILL_CONTENT_TAMPERED",
						updatedAtMs: this.clock.now(),
					})
					.where(eq(agentServerSkillInstallationsTable.id, installation.id))
					.run();
			}
		}
		this.content.cleanupOrphans(referenced);
		this.drainPendingContentDeletions();
	}

	drainPendingContentDeletions(): void {
		for (const row of this.orm
			.select()
			.from(agentServerSkillPendingContentDeletionsTable)
			.orderBy(agentServerSkillPendingContentDeletionsTable.createdAtMs)
			.all()) {
			this.content.deleteVersion(row.contentLocator);
			this.orm
				.delete(agentServerSkillPendingContentDeletionsTable)
				.where(eq(agentServerSkillPendingContentDeletionsTable.contentLocator, row.contentLocator))
				.run();
		}
	}

	#selectInstallation(stableResourceId: string) {
		return this.orm
			.select()
			.from(agentServerSkillInstallationsTable)
			.where(eq(agentServerSkillInstallationsTable.id, stableResourceId))
			.get();
	}

	#requireInstallation(stableResourceId: string) {
		const row = this.#selectInstallation(stableResourceId);
		if (row === undefined) {
			throw new SkillResourceNotFoundError("Agent Server Skill was not found.");
		}
		return row;
	}

	#requireVersion(stableResourceId: string, version: string) {
		const row = this.orm
			.select()
			.from(agentServerSkillVersionsTable)
			.where(
				and(
					eq(agentServerSkillVersionsTable.skillId, stableResourceId),
					eq(agentServerSkillVersionsTable.version, version),
				),
			)
			.get();
		if (row === undefined) {
			throw new SkillResourceNotFoundError("Agent Server Skill version was not found.");
		}
		return row;
	}

	#getCommandResult(
		commandId: string,
		operation: string,
		requestDigest: string,
	): SkillMutationResult | undefined {
		const row = this.orm
			.select()
			.from(agentServerSkillCommandResultsTable)
			.where(eq(agentServerSkillCommandResultsTable.commandId, commandId))
			.get();
		if (row === undefined) {
			return undefined;
		}
		if (row.operation !== operation || row.requestDigest !== requestDigest) {
			throw new Error("Skill command ID was reused with a different request.");
		}
		return skillMutationResultSchema.parse(JSON.parse(row.resultJson));
	}

	#saveCommandResult(
		transaction: AppDatabaseTransaction,
		commandId: string,
		operation: string,
		requestDigest: string,
		result: SkillMutationResult,
		createdAtMs: number,
	): void {
		transaction
			.insert(agentServerSkillCommandResultsTable)
			.values({
				commandId,
				operation,
				requestDigest,
				resultJson: JSON.stringify(result),
				createdAtMs,
			})
			.run();
		const retained = transaction
			.select({ commandId: agentServerSkillCommandResultsTable.commandId })
			.from(agentServerSkillCommandResultsTable)
			.orderBy(agentServerSkillCommandResultsTable.createdAtMs)
			.all();
		const excess = retained.slice(0, Math.max(0, retained.length - maxCommandResults));
		if (excess.length > 0) {
			transaction
				.delete(agentServerSkillCommandResultsTable)
				.where(
					inArray(
						agentServerSkillCommandResultsTable.commandId,
						excess.map((row) => row.commandId),
					),
				)
				.run();
		}
	}
}

function requireAgentServerOwner<T extends { owner: { kind: string } }>(input: T): T {
	if (input.owner.kind !== "agent-server") {
		throw new TypeError("Agent Server Skill repository cannot manage Runtime Box resources.");
	}
	return input;
}

function buildSummary(
	installation: typeof agentServerSkillInstallationsTable.$inferSelect,
	version: typeof agentServerSkillVersionsTable.$inferSelect,
): SkillSummary {
	return skillSummarySchema.parse({
		owner: agentServerOwner,
		stableResourceId: installation.id,
		configRevision: installation.configRevision,
		version: installation.currentVersion,
		contentHash: version.contentHash,
		metadata: skillMetadataSchema.parse(JSON.parse(version.metadataJson)),
		enabled: installation.enabled,
		health: installation.health,
		packageKind: "prompt-only",
		sourceKind: installation.sourceKind,
		stale: false,
		installedAt: new Date(version.installedAtMs).toISOString(),
		updatedAt: new Date(installation.updatedAtMs).toISOString(),
		...(installation.lastErrorCode === null ? {} : { lastErrorCode: installation.lastErrorCode }),
	});
}

function assertExpectedSkill(
	actualConfigRevision: number | undefined,
	actualVersion: string | undefined,
	expectedConfigRevision: number | undefined,
	expectedVersion: string | undefined,
): void {
	if (actualConfigRevision === undefined) {
		if (expectedConfigRevision !== undefined || expectedVersion !== undefined) {
			throw new SkillResourceVersionConflictError("Cannot update a missing Skill.");
		}
		return;
	}
	if (expectedConfigRevision === undefined || expectedVersion === undefined) {
		throw new SkillResourceVersionConflictError(
			"Skill update requires its current config revision and version.",
		);
	}
	if (actualConfigRevision !== expectedConfigRevision || actualVersion !== expectedVersion) {
		throw new SkillResourceVersionConflictError("Skill config revision or version conflict.");
	}
}

function requireTransactionInstallation(
	transaction: AppDatabaseTransaction,
	stableResourceId: string,
) {
	const row = transaction
		.select()
		.from(agentServerSkillInstallationsTable)
		.where(eq(agentServerSkillInstallationsTable.id, stableResourceId))
		.get();
	if (row === undefined) {
		throw new Error("Agent Server Skill installation disappeared during mutation.");
	}
	return row;
}

function requireTransactionVersion(
	transaction: AppDatabaseTransaction,
	stableResourceId: string,
	version: string,
) {
	const row = transaction
		.select()
		.from(agentServerSkillVersionsTable)
		.where(
			and(
				eq(agentServerSkillVersionsTable.skillId, stableResourceId),
				eq(agentServerSkillVersionsTable.version, version),
			),
		)
		.get();
	if (row === undefined) {
		throw new Error("Agent Server Skill version disappeared during mutation.");
	}
	return row;
}

function commandDigest(value: unknown): string {
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
