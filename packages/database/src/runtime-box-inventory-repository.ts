import {
	listRuntimeBoxInventoryOutputSchema,
	runtimeBoxInventoryChangeSchema,
	runtimeBoxInventoryResourceSchema,
	runtimeBoxInventorySnapshotSchema,
	type ListRuntimeBoxInventoryOutput,
	type RuntimeBoxInventoryChange,
	type RuntimeBoxInventorySnapshot,
} from "@moshu/contracts";
import { and, asc, eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import type { RuntimeBoxRepository } from "./runtime-box-repository";
import { runtimeBoxInventoryCacheTable, runtimeBoxInventoryStateTable } from "./schema";

type AppDatabaseTransaction = Parameters<Parameters<AppDrizzleDatabase["transaction"]>[0]>[0];

interface RepositoryClock {
	now(): number;
}

export interface RuntimeBoxInventorySyncState {
	runtimeBoxId: string;
	inventoryEpoch?: string;
	inventoryRevision?: number;
	runtimeBoxGeneration?: number;
	capabilities: string[];
	stale: boolean;
	syncedAt?: string;
}

export class RuntimeBoxInventoryContinuityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeBoxInventoryContinuityError";
	}
}

export interface RuntimeBoxInventoryRepository {
	markStale(runtimeBoxId: string): void;
	replaceSnapshot(snapshot: RuntimeBoxInventorySnapshot): RuntimeBoxInventorySyncState;
	applyChanges(input: {
		runtimeBoxId: string;
		inventoryEpoch: string;
		fromRevisionExclusive: number;
		throughRevision: number;
		changes: readonly RuntimeBoxInventoryChange[];
	}): RuntimeBoxInventorySyncState;
	getState(runtimeBoxId: string): RuntimeBoxInventorySyncState;
	list(runtimeBoxId: string): ListRuntimeBoxInventoryOutput;
}

export class SqliteRuntimeBoxInventoryRepository implements RuntimeBoxInventoryRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly runtimeBoxes: RuntimeBoxRepository,
		private readonly clock: RepositoryClock = { now: Date.now },
	) {}

	markStale(runtimeBoxId: string): void {
		this.runtimeBoxes.get(runtimeBoxId);
		const now = this.clock.now();
		this.orm
			.insert(runtimeBoxInventoryStateTable)
			.values({
				runtimeBoxId,
				inventoryEpoch: null,
				inventoryRevision: null,
				runtimeBoxGeneration: null,
				capabilitiesJson: "[]",
				stale: true,
				syncedAtMs: null,
				updatedAtMs: now,
			})
			.onConflictDoUpdate({
				target: runtimeBoxInventoryStateTable.runtimeBoxId,
				set: { stale: true, updatedAtMs: now },
			})
			.run();
	}

	replaceSnapshot(snapshotValue: RuntimeBoxInventorySnapshot): RuntimeBoxInventorySyncState {
		const snapshot = runtimeBoxInventorySnapshotSchema.parse(snapshotValue);
		this.runtimeBoxes.get(snapshot.runtimeBoxId);
		const now = this.clock.now();
		this.orm.transaction((transaction) => {
			transaction
				.delete(runtimeBoxInventoryCacheTable)
				.where(eq(runtimeBoxInventoryCacheTable.runtimeBoxId, snapshot.runtimeBoxId))
				.run();
			for (const resource of snapshot.resources) {
				this.#upsertResource(transaction, snapshot.runtimeBoxId, resource, now);
			}
			transaction
				.insert(runtimeBoxInventoryStateTable)
				.values({
					runtimeBoxId: snapshot.runtimeBoxId,
					inventoryEpoch: snapshot.inventoryEpoch,
					inventoryRevision: snapshot.inventoryRevision,
					runtimeBoxGeneration: snapshot.runtimeBoxGeneration,
					capabilitiesJson: JSON.stringify(snapshot.capabilities),
					stale: false,
					syncedAtMs: now,
					updatedAtMs: now,
				})
				.onConflictDoUpdate({
					target: runtimeBoxInventoryStateTable.runtimeBoxId,
					set: {
						inventoryEpoch: snapshot.inventoryEpoch,
						inventoryRevision: snapshot.inventoryRevision,
						runtimeBoxGeneration: snapshot.runtimeBoxGeneration,
						capabilitiesJson: JSON.stringify(snapshot.capabilities),
						stale: false,
						syncedAtMs: now,
						updatedAtMs: now,
					},
				})
				.run();
		});
		return this.getState(snapshot.runtimeBoxId);
	}

	applyChanges(input: {
		runtimeBoxId: string;
		inventoryEpoch: string;
		fromRevisionExclusive: number;
		throughRevision: number;
		changes: readonly RuntimeBoxInventoryChange[];
	}): RuntimeBoxInventorySyncState {
		this.runtimeBoxes.get(input.runtimeBoxId);
		const changes = input.changes.map((change) => runtimeBoxInventoryChangeSchema.parse(change));
		if (
			!Number.isSafeInteger(input.fromRevisionExclusive) ||
			input.fromRevisionExclusive < 0 ||
			!Number.isSafeInteger(input.throughRevision) ||
			input.throughRevision < input.fromRevisionExclusive
		) {
			throw new RuntimeBoxInventoryContinuityError("Inventory revision range is invalid.");
		}
		if (changes.length !== input.throughRevision - input.fromRevisionExclusive) {
			throw new RuntimeBoxInventoryContinuityError("Inventory change batch is not contiguous.");
		}
		for (const [index, change] of changes.entries()) {
			if (change.revision !== input.fromRevisionExclusive + index + 1) {
				throw new RuntimeBoxInventoryContinuityError("Inventory change revision has a gap.");
			}
		}
		const now = this.clock.now();
		this.orm.transaction((transaction) => {
			const state = transaction
				.select()
				.from(runtimeBoxInventoryStateTable)
				.where(eq(runtimeBoxInventoryStateTable.runtimeBoxId, input.runtimeBoxId))
				.get();
			if (
				state === undefined ||
				state.inventoryEpoch !== input.inventoryEpoch ||
				state.inventoryRevision !== input.fromRevisionExclusive
			) {
				throw new RuntimeBoxInventoryContinuityError(
					"Inventory cache does not match the delta base.",
				);
			}
			let capabilitiesJson = state.capabilitiesJson;
			for (const change of changes) {
				if (change.category === "capability") {
					capabilitiesJson = JSON.stringify(change.capabilities);
					continue;
				}
				if (change.operation === "upsert" && change.descriptor !== undefined) {
					this.#upsertResource(transaction, input.runtimeBoxId, change.descriptor, now);
					continue;
				}
				if (change.operation === "delete" && change.tombstone !== undefined) {
					transaction
						.delete(runtimeBoxInventoryCacheTable)
						.where(
							and(
								eq(runtimeBoxInventoryCacheTable.runtimeBoxId, input.runtimeBoxId),
								eq(runtimeBoxInventoryCacheTable.resourceKind, change.tombstone.resourceKind),
								eq(
									runtimeBoxInventoryCacheTable.stableResourceId,
									change.tombstone.stableResourceId,
								),
							),
						)
						.run();
					continue;
				}
				throw new RuntimeBoxInventoryContinuityError("Inventory change is not applicable.");
			}
			transaction
				.update(runtimeBoxInventoryStateTable)
				.set({
					inventoryRevision: input.throughRevision,
					capabilitiesJson,
					stale: false,
					syncedAtMs: now,
					updatedAtMs: now,
				})
				.where(eq(runtimeBoxInventoryStateTable.runtimeBoxId, input.runtimeBoxId))
				.run();
		});
		return this.getState(input.runtimeBoxId);
	}

	getState(runtimeBoxId: string): RuntimeBoxInventorySyncState {
		this.runtimeBoxes.get(runtimeBoxId);
		const row = this.orm
			.select()
			.from(runtimeBoxInventoryStateTable)
			.where(eq(runtimeBoxInventoryStateTable.runtimeBoxId, runtimeBoxId))
			.get();
		if (row === undefined) {
			return {
				runtimeBoxId,
				capabilities: [],
				stale: true,
			};
		}
		const capabilities = parseCapabilities(row.capabilitiesJson);
		return {
			runtimeBoxId,
			...(row.inventoryEpoch === null ? {} : { inventoryEpoch: row.inventoryEpoch }),
			...(row.inventoryRevision === null ? {} : { inventoryRevision: row.inventoryRevision }),
			...(row.runtimeBoxGeneration === null
				? {}
				: { runtimeBoxGeneration: row.runtimeBoxGeneration }),
			capabilities,
			stale: row.stale,
			...(row.syncedAtMs === null ? {} : { syncedAt: new Date(row.syncedAtMs).toISOString() }),
		};
	}

	list(runtimeBoxId: string): ListRuntimeBoxInventoryOutput {
		const state = this.getState(runtimeBoxId);
		const resources = this.orm
			.select()
			.from(runtimeBoxInventoryCacheTable)
			.where(eq(runtimeBoxInventoryCacheTable.runtimeBoxId, runtimeBoxId))
			.orderBy(
				asc(runtimeBoxInventoryCacheTable.resourceKind),
				asc(runtimeBoxInventoryCacheTable.stableResourceId),
			)
			.all()
			.map((row) => {
				const descriptor = runtimeBoxInventoryResourceSchema.parse(JSON.parse(row.descriptorJson));
				if (
					descriptor.resourceKind !== row.resourceKind ||
					descriptor.stableResourceId !== row.stableResourceId ||
					descriptor.version !== row.version ||
					descriptor.contentHash !== row.contentHash
				) {
					throw new Error("Runtime Box inventory cache row is inconsistent.");
				}
				return descriptor;
			});
		return listRuntimeBoxInventoryOutputSchema.parse({
			runtimeBoxId,
			...(state.inventoryEpoch === undefined ? {} : { inventoryEpoch: state.inventoryEpoch }),
			...(state.inventoryRevision === undefined
				? {}
				: { inventoryRevision: state.inventoryRevision }),
			stale: state.stale,
			resources,
		});
	}

	#upsertResource(
		transaction: AppDatabaseTransaction,
		runtimeBoxId: string,
		resourceValue: unknown,
		now: number,
	): void {
		const resource = runtimeBoxInventoryResourceSchema.parse(resourceValue);
		transaction
			.insert(runtimeBoxInventoryCacheTable)
			.values({
				runtimeBoxId,
				resourceKind: resource.resourceKind,
				stableResourceId: resource.stableResourceId,
				version: resource.version,
				contentHash: resource.contentHash,
				descriptorJson: JSON.stringify(resource),
				updatedAtMs: now,
			})
			.onConflictDoUpdate({
				target: [
					runtimeBoxInventoryCacheTable.runtimeBoxId,
					runtimeBoxInventoryCacheTable.resourceKind,
					runtimeBoxInventoryCacheTable.stableResourceId,
				],
				set: {
					version: resource.version,
					contentHash: resource.contentHash,
					descriptorJson: JSON.stringify(resource),
					updatedAtMs: now,
				},
			})
			.run();
	}
}

function parseCapabilities(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.length > 128 ||
		parsed.some((capability) => typeof capability !== "string")
	) {
		throw new Error("Runtime Box inventory capabilities are invalid.");
	}
	return parsed;
}
