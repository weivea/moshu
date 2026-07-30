import {
	agentGlobalProfileSchema,
	updateAgentGlobalProfileInputSchema,
	type AgentGlobalProfile,
	type AgentServerMcpResourceRef,
} from "@moshu/contracts";
import { eq } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { agentGlobalProfilesTable } from "./schema";

export class AgentGlobalProfileRevisionConflictError extends Error {
	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
	) {
		super(
			`Agent global profile revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`,
		);
		this.name = "AgentGlobalProfileRevisionConflictError";
	}
}

export interface AgentGlobalProfileRepository {
	getOrCreate(agentId: string): AgentGlobalProfile;
	update(input: {
		agentId: string;
		expectedRevision: number;
		serverMcpRefs: readonly AgentServerMcpResourceRef[];
	}): AgentGlobalProfile;
	isResourceReferenced(stableResourceId: string): boolean;
}

export class SqliteAgentGlobalProfileRepository implements AgentGlobalProfileRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: { now(): number } = { now: Date.now },
	) {}

	getOrCreate(agentId: string): AgentGlobalProfile {
		const existing = this.#select(agentId);
		if (existing !== undefined) {
			return buildProfile(existing);
		}
		const now = this.clock.now();
		this.orm
			.insert(agentGlobalProfilesTable)
			.values({
				agentId,
				revision: 1,
				serverMcpRefsJson: "[]",
				createdAtMs: now,
				updatedAtMs: now,
			})
			.onConflictDoNothing()
			.run();
		const created = this.#select(agentId);
		if (created === undefined) {
			throw new Error("Agent global profile could not be initialized.");
		}
		return buildProfile(created);
	}

	update(inputValue: {
		agentId: string;
		expectedRevision: number;
		serverMcpRefs: readonly AgentServerMcpResourceRef[];
	}): AgentGlobalProfile {
		const input = updateAgentGlobalProfileInputSchema.parse(inputValue);
		const current = this.getOrCreate(input.agentId);
		if (current.revision !== input.expectedRevision) {
			throw new AgentGlobalProfileRevisionConflictError(input.expectedRevision, current.revision);
		}
		const now = this.clock.now();
		this.orm
			.update(agentGlobalProfilesTable)
			.set({
				revision: current.revision + 1,
				serverMcpRefsJson: JSON.stringify(input.serverMcpRefs),
				updatedAtMs: now,
			})
			.where(eq(agentGlobalProfilesTable.agentId, input.agentId))
			.run();
		const updated = this.#select(input.agentId);
		if (updated === undefined) {
			throw new Error("Agent global profile disappeared after update.");
		}
		return buildProfile(updated);
	}

	isResourceReferenced(stableResourceId: string): boolean {
		return this.orm
			.select({ refs: agentGlobalProfilesTable.serverMcpRefsJson })
			.from(agentGlobalProfilesTable)
			.all()
			.some((row) =>
				agentGlobalProfileSchema.shape.serverMcpRefs
					.parse(JSON.parse(row.refs))
					.some((ref) => ref.stableResourceId === stableResourceId),
			);
	}

	#select(agentId: string) {
		return this.orm
			.select()
			.from(agentGlobalProfilesTable)
			.where(eq(agentGlobalProfilesTable.agentId, agentId))
			.get();
	}
}

function buildProfile(row: typeof agentGlobalProfilesTable.$inferSelect): AgentGlobalProfile {
	return agentGlobalProfileSchema.parse({
		agentId: row.agentId,
		revision: row.revision,
		serverMcpRefs: JSON.parse(row.serverMcpRefsJson),
		createdAt: new Date(row.createdAtMs).toISOString(),
		updatedAt: new Date(row.updatedAtMs).toISOString(),
	});
}
