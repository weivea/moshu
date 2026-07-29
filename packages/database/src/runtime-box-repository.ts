import { randomUUID } from "node:crypto";
import {
	type ActiveRuntimeBoxSelection,
	activeRuntimeBoxSelectionSchema,
	type RuntimeBoxDescriptor,
	runtimeBoxDescriptorSchema,
	type SwitchRuntimeBoxInput,
	switchRuntimeBoxInputSchema,
} from "@moshu/contracts";
import { asc, eq, isNull } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { appSettingsTable, runtimeBoxGenerationFencesTable, runtimeBoxesTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

type RuntimeBoxRow = typeof runtimeBoxesTable.$inferSelect;
type AppDatabaseTransaction = Parameters<Parameters<AppDrizzleDatabase["transaction"]>[0]>[0];

export class RuntimeBoxNotFoundError extends Error {
	constructor(readonly runtimeBoxId: string) {
		super(`Runtime Box ${runtimeBoxId} was not found.`);
		this.name = "RuntimeBoxNotFoundError";
	}
}

export class RuntimeBoxArchivedError extends Error {
	constructor(readonly runtimeBoxId: string) {
		super(`Runtime Box ${runtimeBoxId} is archived.`);
		this.name = "RuntimeBoxArchivedError";
	}
}

export class ActiveRuntimeRevisionConflictError extends Error {
	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
	) {
		super(
			`Active Runtime Box revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`,
		);
		this.name = "ActiveRuntimeRevisionConflictError";
	}
}

export type RuntimeBoxGenerationAcceptance =
	| { accepted: true }
	| {
			accepted: false;
			code: "STALE_GENERATION" | "GENERATION_CONFLICT";
			currentGeneration: number;
	  };

export interface RuntimeBoxRepository {
	initializeDefault(descriptor: RuntimeBoxDescriptor): ActiveRuntimeBoxSelection;
	upsertRegistration(descriptor: RuntimeBoxDescriptor): void;
	list(): RuntimeBoxDescriptor[];
	get(runtimeBoxId: string): RuntimeBoxDescriptor;
	getActive(): ActiveRuntimeBoxSelection;
	getActionJournalEpoch(): string;
	switchActive(input: SwitchRuntimeBoxInput): ActiveRuntimeBoxSelection;
	acceptGeneration(
		runtimeBoxId: string,
		instanceId: string,
		generation: number,
	): RuntimeBoxGenerationAcceptance;
}

export class SqliteRuntimeBoxRepository implements RuntimeBoxRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	initializeDefault(descriptorValue: RuntimeBoxDescriptor): ActiveRuntimeBoxSelection {
		const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
		return this.orm.transaction((transaction) => {
			this.#upsertDescriptor(transaction, descriptor, false, true);
			const active = transaction.select().from(appSettingsTable).get();
			if (active === undefined) {
				transaction
					.insert(appSettingsTable)
					.values({
						id: 1,
						activeRuntimeBoxId: descriptor.runtimeBoxId,
						activeRuntimeRevision: 1,
						actionJournalEpoch: randomUUID(),
					})
					.run();
				return activeRuntimeBoxSelectionSchema.parse({
					runtimeBoxId: descriptor.runtimeBoxId,
					revision: 1,
				});
			}
			return activeRuntimeBoxSelectionSchema.parse({
				runtimeBoxId: active.activeRuntimeBoxId,
				revision: active.activeRuntimeRevision,
			});
		});
	}

	upsertRegistration(descriptorValue: RuntimeBoxDescriptor): void {
		const descriptor = runtimeBoxDescriptorSchema.parse(descriptorValue);
		this.orm.transaction((transaction) => {
			this.#upsertDescriptor(transaction, descriptor, true);
		});
	}

	list(): RuntimeBoxDescriptor[] {
		return this.orm
			.select()
			.from(runtimeBoxesTable)
			.where(isNull(runtimeBoxesTable.archivedAtMs))
			.orderBy(asc(runtimeBoxesTable.id))
			.all()
			.map(buildDescriptor);
	}

	get(runtimeBoxId: string): RuntimeBoxDescriptor {
		const row = this.orm
			.select()
			.from(runtimeBoxesTable)
			.where(eq(runtimeBoxesTable.id, runtimeBoxId))
			.get();
		if (row === undefined) {
			throw new RuntimeBoxNotFoundError(runtimeBoxId);
		}
		if (row.archivedAtMs !== null) {
			throw new RuntimeBoxArchivedError(runtimeBoxId);
		}
		return buildDescriptor(row);
	}

	getActive(): ActiveRuntimeBoxSelection {
		const row = this.orm.select().from(appSettingsTable).get();
		if (row === undefined) {
			throw new Error("Active Runtime Box setting has not been initialized.");
		}

		return activeRuntimeBoxSelectionSchema.parse({
			runtimeBoxId: row.activeRuntimeBoxId,
			revision: row.activeRuntimeRevision,
		});
	}

	getActionJournalEpoch(): string {
		const row = this.orm
			.select({ value: appSettingsTable.actionJournalEpoch })
			.from(appSettingsTable)
			.get();
		if (row === undefined) {
			throw new Error("Action journal epoch has not been initialized.");
		}
		return row.value;
	}

	switchActive(inputValue: SwitchRuntimeBoxInput): ActiveRuntimeBoxSelection {
		const input = switchRuntimeBoxInputSchema.parse(inputValue);
		return this.orm.transaction((transaction) => {
			const active = transaction.select().from(appSettingsTable).get();
			if (active === undefined) {
				throw new Error("Active Runtime Box setting has not been initialized.");
			}
			if (active.activeRuntimeRevision !== input.expectedRevision) {
				throw new ActiveRuntimeRevisionConflictError(
					input.expectedRevision,
					active.activeRuntimeRevision,
				);
			}
			const target = transaction
				.select()
				.from(runtimeBoxesTable)
				.where(eq(runtimeBoxesTable.id, input.runtimeBoxId))
				.get();
			if (target === undefined) {
				throw new RuntimeBoxNotFoundError(input.runtimeBoxId);
			}
			if (target.archivedAtMs !== null) {
				throw new RuntimeBoxArchivedError(input.runtimeBoxId);
			}
			if (active.activeRuntimeBoxId === input.runtimeBoxId) {
				return activeRuntimeBoxSelectionSchema.parse({
					runtimeBoxId: active.activeRuntimeBoxId,
					revision: active.activeRuntimeRevision,
				});
			}
			const revision = active.activeRuntimeRevision + 1;
			transaction
				.update(appSettingsTable)
				.set({
					activeRuntimeBoxId: input.runtimeBoxId,
					activeRuntimeRevision: revision,
				})
				.where(eq(appSettingsTable.id, 1))
				.run();
			return activeRuntimeBoxSelectionSchema.parse({
				runtimeBoxId: input.runtimeBoxId,
				revision,
			});
		});
	}

	acceptGeneration(
		runtimeBoxId: string,
		instanceId: string,
		generation: number,
	): RuntimeBoxGenerationAcceptance {
		if (!Number.isSafeInteger(generation) || generation < 0) {
			throw new TypeError("Runtime Box generation must be a nonnegative safe integer.");
		}
		if (instanceId.length === 0 || instanceId.length > 256) {
			throw new TypeError("Runtime Box instanceId must be between 1 and 256 characters.");
		}
		return this.orm.transaction((transaction) => {
			const runtimeBox = transaction
				.select({ archivedAtMs: runtimeBoxesTable.archivedAtMs })
				.from(runtimeBoxesTable)
				.where(eq(runtimeBoxesTable.id, runtimeBoxId))
				.get();
			if (runtimeBox === undefined) {
				throw new RuntimeBoxNotFoundError(runtimeBoxId);
			}
			if (runtimeBox.archivedAtMs !== null) {
				throw new RuntimeBoxArchivedError(runtimeBoxId);
			}
			const existing = transaction
				.select()
				.from(runtimeBoxGenerationFencesTable)
				.where(eq(runtimeBoxGenerationFencesTable.runtimeBoxId, runtimeBoxId))
				.get();
			if (existing !== undefined) {
				if (generation < existing.acceptedGeneration) {
					return {
						accepted: false,
						code: "STALE_GENERATION",
						currentGeneration: existing.acceptedGeneration,
					};
				}
				if (
					generation === existing.acceptedGeneration &&
					instanceId !== existing.acceptedInstanceId
				) {
					return {
						accepted: false,
						code: "GENERATION_CONFLICT",
						currentGeneration: existing.acceptedGeneration,
					};
				}
			}
			transaction
				.insert(runtimeBoxGenerationFencesTable)
				.values({
					runtimeBoxId,
					acceptedGeneration: generation,
					acceptedInstanceId: instanceId,
					updatedAtMs: this.clock.now(),
				})
				.onConflictDoUpdate({
					target: runtimeBoxGenerationFencesTable.runtimeBoxId,
					set: {
						acceptedGeneration: generation,
						acceptedInstanceId: instanceId,
						updatedAtMs: this.clock.now(),
					},
				})
				.run();
			return { accepted: true };
		});
	}

	#upsertDescriptor(
		transaction: AppDatabaseTransaction,
		descriptor: RuntimeBoxDescriptor,
		markSeen: boolean,
		preserveExisting = false,
	): void {
		const existing = transaction
			.select()
			.from(runtimeBoxesTable)
			.where(eq(runtimeBoxesTable.id, descriptor.runtimeBoxId))
			.get();
		if (existing !== undefined && existing.kind !== descriptor.kind) {
			throw new Error("A Runtime Box stable identity cannot change kind.");
		}
		if (existing?.archivedAtMs !== null && existing?.archivedAtMs !== undefined) {
			throw new RuntimeBoxArchivedError(descriptor.runtimeBoxId);
		}
		if (existing !== undefined && preserveExisting) {
			return;
		}
		const now = this.clock.now();
		transaction
			.insert(runtimeBoxesTable)
			.values({
				id: descriptor.runtimeBoxId,
				kind: descriptor.kind,
				displayName: descriptor.displayName,
				runtimeBoxVersion: descriptor.runtimeBoxVersion,
				platform: descriptor.platform,
				arch: descriptor.arch,
				capabilitiesJson: JSON.stringify(descriptor.capabilities),
				createdAtMs: existing?.createdAtMs ?? now,
				updatedAtMs: now,
				lastSeenAtMs: markSeen ? now : (existing?.lastSeenAtMs ?? null),
				archivedAtMs: null,
			})
			.onConflictDoUpdate({
				target: runtimeBoxesTable.id,
				set: {
					displayName: descriptor.displayName,
					runtimeBoxVersion: descriptor.runtimeBoxVersion,
					platform: descriptor.platform,
					arch: descriptor.arch,
					capabilitiesJson: JSON.stringify(descriptor.capabilities),
					updatedAtMs: now,
					...(markSeen ? { lastSeenAtMs: now } : {}),
				},
			})
			.run();
	}
}

function buildDescriptor(row: RuntimeBoxRow): RuntimeBoxDescriptor {
	let capabilities: unknown;
	try {
		capabilities = JSON.parse(row.capabilitiesJson);
	} catch (error) {
		throw new Error(`Runtime Box ${row.id} capabilities are not valid JSON.`, { cause: error });
	}
	return runtimeBoxDescriptorSchema.parse({
		schemaVersion: 1,
		runtimeBoxId: row.id,
		kind: row.kind,
		displayName: row.displayName,
		runtimeBoxVersion: row.runtimeBoxVersion,
		platform: row.platform,
		arch: row.arch,
		capabilities,
	});
}
