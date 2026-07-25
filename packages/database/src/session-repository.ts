import {
	type ChatSession,
	chatSessionSchema,
	type CreateChatSessionInput,
	type CreateChatSessionOutput,
	createChatSessionInputSchema,
	createChatSessionOutputSchema,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	deleteChatSessionInputSchema,
	deleteChatSessionOutputSchema,
	type GetChatSessionInput,
	getChatSessionInputSchema,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
} from "@moshu/contracts";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { chatSessionsTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

type SessionRow = typeof chatSessionsTable.$inferSelect;

export interface SessionRepository {
	create(input: CreateChatSessionInput): CreateChatSessionOutput;
	list(input?: ListChatSessionsInput): ListChatSessionsOutput;
	get(input: GetChatSessionInput): ChatSession;
	update(input: UpdateChatSessionInput): UpdateChatSessionOutput;
	setArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput;
	delete(input: DeleteChatSessionInput): DeleteChatSessionOutput;
}

function toIsoDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function buildSession(row: SessionRow): ChatSession {
	return chatSessionSchema.parse({
		schemaVersion: 1,
		id: row.id,
		title: row.title,
		defaultMode: row.defaultMode,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
		lastMessageAt: row.lastMessageAtMs === null ? undefined : toIsoDateTime(row.lastMessageAtMs),
		archivedAt: row.archivedAtMs === null ? undefined : toIsoDateTime(row.archivedAtMs),
	});
}

export class SqliteSessionRepository implements SessionRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	create(input: CreateChatSessionInput): CreateChatSessionOutput {
		const parsedInput = createChatSessionInputSchema.parse(input);
		const nowMs = this.clock.now();
		const row: typeof chatSessionsTable.$inferInsert = {
			id: this.idGenerator.create(nowMs),
			title: parsedInput.title,
			defaultMode: parsedInput.defaultMode ?? "ask",
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
			lastMessageAtMs: null,
			archivedAtMs: null,
		};

		this.orm.insert(chatSessionsTable).values(row).run();
		return createChatSessionOutputSchema.parse({ session: buildSession(row as SessionRow) });
	}

	list(input: ListChatSessionsInput = {}): ListChatSessionsOutput {
		const parsedInput = listChatSessionsInputSchema.parse(input);
		const conditions = [
			parsedInput.archived
				? isNotNull(chatSessionsTable.archivedAtMs)
				: isNull(chatSessionsTable.archivedAtMs),
		];
		if (parsedInput.query !== undefined && parsedInput.query.length > 0) {
			conditions.push(
				sql`instr(lower(${chatSessionsTable.title}), lower(${parsedInput.query})) > 0`,
			);
		}

		const rows = this.orm
			.select()
			.from(chatSessionsTable)
			.where(and(...conditions))
			.orderBy(desc(chatSessionsTable.updatedAtMs), desc(chatSessionsTable.id))
			.limit(parsedInput.limit ?? 50)
			.all();

		return listChatSessionsOutputSchema.parse({ items: rows.map(buildSession) });
	}

	get(input: GetChatSessionInput): ChatSession {
		const parsedInput = getChatSessionInputSchema.parse(input);
		return buildSession(this.selectRow(parsedInput.sessionId));
	}

	update(input: UpdateChatSessionInput): UpdateChatSessionOutput {
		const parsedInput = updateChatSessionInputSchema.parse(input);
		this.selectRow(parsedInput.sessionId);
		this.orm
			.update(chatSessionsTable)
			.set({ title: parsedInput.title, updatedAtMs: this.clock.now() })
			.where(eq(chatSessionsTable.id, parsedInput.sessionId))
			.run();

		return updateChatSessionOutputSchema.parse({
			session: buildSession(this.selectRow(parsedInput.sessionId)),
		});
	}

	setArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		this.selectRow(parsedInput.sessionId);
		const nowMs = this.clock.now();
		this.orm
			.update(chatSessionsTable)
			.set({ archivedAtMs: parsedInput.archived ? nowMs : null, updatedAtMs: nowMs })
			.where(eq(chatSessionsTable.id, parsedInput.sessionId))
			.run();

		return setChatSessionArchivedOutputSchema.parse({
			session: buildSession(this.selectRow(parsedInput.sessionId)),
		});
	}

	delete(input: DeleteChatSessionInput): DeleteChatSessionOutput {
		const parsedInput = deleteChatSessionInputSchema.parse(input);
		this.selectRow(parsedInput.sessionId);
		this.orm.delete(chatSessionsTable).where(eq(chatSessionsTable.id, parsedInput.sessionId)).run();
		return deleteChatSessionOutputSchema.parse({ sessionId: parsedInput.sessionId });
	}

	private selectRow(sessionId: string): SessionRow {
		const row = this.orm
			.select()
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.id, sessionId))
			.get();
		if (row === undefined) {
			throw new Error(`Chat session ${sessionId} was not found.`);
		}
		return row;
	}
}

export function createSessionRepository(database: { orm: AppDrizzleDatabase }): SessionRepository {
	return new SqliteSessionRepository(database.orm);
}
