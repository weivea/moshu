import {
	runtimeProfileSchema,
	updateRuntimeProfileInputSchema,
	type RuntimeProfile,
	type RuntimeBoxResourceRef,
} from "@moshu/contracts";
import { and, eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import type { RuntimeBoxRepository } from "./runtime-box-repository";
import { agentRuntimeProfilesTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

export class RuntimeProfileRevisionConflictError extends Error {
	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
	) {
		super(
			`Runtime Profile revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`,
		);
		this.name = "RuntimeProfileRevisionConflictError";
	}
}

export interface RuntimeProfileRepository {
	getOrCreate(agentId: string, runtimeBoxId: string): RuntimeProfile;
	update(input: {
		agentId: string;
		runtimeBoxId: string;
		expectedRevision: number;
		resources: readonly RuntimeBoxResourceRef[];
	}): RuntimeProfile;
	isResourceReferenced(
		runtimeBoxId: string,
		resourceKind: "mcp" | "skill",
		stableResourceId: string,
	): boolean;
}

export class SqliteRuntimeProfileRepository implements RuntimeProfileRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly runtimeBoxes: RuntimeBoxRepository,
		private readonly clock: RepositoryClock = { now: Date.now },
	) {}

	getOrCreate(agentId: string, runtimeBoxId: string): RuntimeProfile {
		this.runtimeBoxes.get(runtimeBoxId);
		const existing = this.#select(agentId, runtimeBoxId);
		if (existing !== undefined) {
			return buildProfile(existing);
		}
		const now = this.clock.now();
		this.orm
			.insert(agentRuntimeProfilesTable)
			.values({
				agentId,
				runtimeBoxId,
				revision: 1,
				resourcesJson: "[]",
				createdAtMs: now,
				updatedAtMs: now,
			})
			.onConflictDoNothing()
			.run();
		const created = this.#select(agentId, runtimeBoxId);
		if (created === undefined) {
			throw new Error("Runtime Profile could not be initialized.");
		}
		return buildProfile(created);
	}

	update(inputValue: {
		agentId: string;
		runtimeBoxId: string;
		expectedRevision: number;
		resources: readonly RuntimeBoxResourceRef[];
	}): RuntimeProfile {
		const parsed = updateRuntimeProfileInputSchema.parse({
			agentId: inputValue.agentId,
			runtimeBoxId: inputValue.runtimeBoxId,
			expectedRevision: inputValue.expectedRevision,
			resources: inputValue.resources,
		});
		if (parsed.runtimeBoxId === undefined) {
			throw new Error("Runtime Profile update requires a Runtime Box ID.");
		}
		const current = this.getOrCreate(parsed.agentId, parsed.runtimeBoxId);
		if (current.revision !== parsed.expectedRevision) {
			throw new RuntimeProfileRevisionConflictError(parsed.expectedRevision, current.revision);
		}
		const nextRevision = current.revision + 1;
		const now = this.clock.now();
		this.orm
			.update(agentRuntimeProfilesTable)
			.set({
				revision: nextRevision,
				resourcesJson: JSON.stringify(parsed.resources),
				updatedAtMs: now,
			})
			.where(
				and(
					eq(agentRuntimeProfilesTable.agentId, parsed.agentId),
					eq(agentRuntimeProfilesTable.runtimeBoxId, parsed.runtimeBoxId),
					eq(agentRuntimeProfilesTable.revision, parsed.expectedRevision),
				),
			)
			.run();
		const row = this.#select(parsed.agentId, parsed.runtimeBoxId);
		if (row === undefined) {
			throw new Error("Runtime Profile disappeared after update.");
		}
		return buildProfile(row);
	}

	isResourceReferenced(
		runtimeBoxId: string,
		resourceKind: "mcp" | "skill",
		stableResourceId: string,
	): boolean {
		this.runtimeBoxes.get(runtimeBoxId);
		const rows = this.orm
			.select({ resourcesJson: agentRuntimeProfilesTable.resourcesJson })
			.from(agentRuntimeProfilesTable)
			.where(eq(agentRuntimeProfilesTable.runtimeBoxId, runtimeBoxId))
			.all();
		return rows.some((row) => {
			const resources = runtimeProfileSchema.shape.resources.parse(JSON.parse(row.resourcesJson));
			return resources.some(
				(ref) => ref.resourceKind === resourceKind && ref.stableResourceId === stableResourceId,
			);
		});
	}

	#select(agentId: string, runtimeBoxId: string) {
		return this.orm
			.select()
			.from(agentRuntimeProfilesTable)
			.where(
				and(
					eq(agentRuntimeProfilesTable.agentId, agentId),
					eq(agentRuntimeProfilesTable.runtimeBoxId, runtimeBoxId),
				),
			)
			.get();
	}
}

function buildProfile(row: typeof agentRuntimeProfilesTable.$inferSelect): RuntimeProfile {
	return runtimeProfileSchema.parse({
		agentId: row.agentId,
		runtimeBoxId: row.runtimeBoxId,
		revision: row.revision,
		resources: JSON.parse(row.resourcesJson),
		createdAt: new Date(row.createdAtMs).toISOString(),
		updatedAt: new Date(row.updatedAtMs).toISOString(),
	});
}
