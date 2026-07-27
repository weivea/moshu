import {
	type ChatSession,
	type CreateChatSessionInput,
	type CreateChatSessionOutput,
	type CreateProcessChatSessionInput,
	chatSessionSchema,
	createChatSessionInputSchema,
	createChatSessionOutputSchema,
	createProcessChatSessionInputSchema,
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
	type ProcessPeerIdentity,
	processPeerIdentitySchema,
	type SessionModelSelection,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type SetChatSessionModelInput,
	type SetChatSessionModelOutput,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	setChatSessionModelInputSchema,
	setChatSessionModelOutputSchema,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
} from "@moshu/contracts";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { chatSessionCreateRequestsTable, chatSessionsTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

type SessionRow = typeof chatSessionsTable.$inferSelect;

export const maxSessionCreateIdempotencyRecords = 1_024;

export class ChatSessionNotFoundError extends Error {
	constructor(readonly sessionId: string) {
		super(`Chat session ${sessionId} was not found.`);
		this.name = "ChatSessionNotFoundError";
	}
}

export class SessionCreateKeyConflictError extends Error {
	constructor(readonly createKey: string) {
		super(`Session create key ${createKey} was reused with a different origin or parameters.`);
		this.name = "SessionCreateKeyConflictError";
	}
}

export class SessionCreateCapacityError extends Error {
	constructor() {
		super("Session create idempotency capacity is full.");
		this.name = "SessionCreateCapacityError";
	}
}

export interface IdempotentSessionCreateInput {
	request: CreateProcessChatSessionInput;
	origin: ProcessPeerIdentity;
}

export interface SessionRepository {
	create(input: CreateChatSessionInput): CreateChatSessionOutput;
	createIdempotently(input: IdempotentSessionCreateInput): CreateChatSessionOutput;
	list(input?: ListChatSessionsInput): ListChatSessionsOutput;
	get(input: GetChatSessionInput): ChatSession;
	update(input: UpdateChatSessionInput): UpdateChatSessionOutput;
	setArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput;
	setModel(input: SetChatSessionModelInput): SetChatSessionModelOutput;
	delete(input: DeleteChatSessionInput): DeleteChatSessionOutput;
}

function toIsoDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function buildSessionModel(row: SessionRow): SessionModelSelection | undefined {
	if (row.providerId === null || row.modelId === null) {
		return undefined;
	}
	const reasoning = {
		...(row.reasoningEffort === null ? {} : { effort: row.reasoningEffort }),
		...(row.reasoningBudgetTokens === null ? {} : { budgetTokens: row.reasoningBudgetTokens }),
	};

	return {
		providerId: row.providerId,
		modelId: row.modelId,
		...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
	};
}

function toModelColumns(model: SessionModelSelection | null): {
	providerId: string | null;
	modelId: string | null;
	reasoningEffort: string | null;
	reasoningBudgetTokens: number | null;
} {
	return {
		providerId: model === null ? null : model.providerId,
		modelId: model === null ? null : model.modelId,
		reasoningEffort: model?.reasoning?.effort ?? null,
		reasoningBudgetTokens: model?.reasoning?.budgetTokens ?? null,
	};
}

function buildSession(row: SessionRow): ChatSession {
	return chatSessionSchema.parse({
		schemaVersion: 1,
		id: row.id,
		title: row.title,
		defaultMode: row.defaultMode,
		model: buildSessionModel(row),
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
			...toModelColumns(parsedInput.model ?? null),
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
			lastMessageAtMs: null,
			archivedAtMs: null,
		};

		this.orm.insert(chatSessionsTable).values(row).run();
		return createChatSessionOutputSchema.parse({ session: buildSession(row as SessionRow) });
	}

	createIdempotently(input: IdempotentSessionCreateInput): CreateChatSessionOutput {
		const request = createProcessChatSessionInputSchema.parse(input.request);
		const origin = processPeerIdentitySchema.parse(input.origin);
		if (origin.role !== "client") {
			throw new TypeError("Idempotent Session creation requires a client origin.");
		}

		return this.orm.transaction((transaction) => {
			const existing = transaction
				.select()
				.from(chatSessionCreateRequestsTable)
				.where(eq(chatSessionCreateRequestsTable.createKey, request.createKey))
				.get();
			if (existing !== undefined) {
				if (
					existing.originRole !== origin.role ||
					existing.originPeerId !== origin.peerId ||
					existing.originInstanceId !== origin.instanceId ||
					existing.originGeneration !== origin.generation ||
					existing.title !== request.title ||
					existing.defaultMode !== request.defaultMode
				) {
					throw new SessionCreateKeyConflictError(request.createKey);
				}
				const row = transaction
					.select()
					.from(chatSessionsTable)
					.where(eq(chatSessionsTable.id, existing.sessionId))
					.get();
				if (row === undefined) {
					throw new Error("Session create idempotency record refers to a missing Session.");
				}
				return createChatSessionOutputSchema.parse({ session: buildSession(row) });
			}

			const recordCount =
				transaction
					.select({ value: sql<number>`count(*)` })
					.from(chatSessionCreateRequestsTable)
					.get()?.value ?? 0;
			if (recordCount >= maxSessionCreateIdempotencyRecords) {
				throw new SessionCreateCapacityError();
			}

			const nowMs = this.clock.now();
			const row: typeof chatSessionsTable.$inferInsert = {
				id: this.idGenerator.create(nowMs),
				title: request.title,
				defaultMode: request.defaultMode,
				...toModelColumns(request.model ?? null),
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				lastMessageAtMs: null,
				archivedAtMs: null,
			};
			transaction.insert(chatSessionsTable).values(row).run();
			transaction
				.insert(chatSessionCreateRequestsTable)
				.values({
					createKey: request.createKey,
					originRole: origin.role,
					originPeerId: origin.peerId,
					originInstanceId: origin.instanceId,
					originGeneration: origin.generation,
					title: request.title,
					defaultMode: request.defaultMode,
					sessionId: row.id,
					createdAtMs: nowMs,
				})
				.run();
			return createChatSessionOutputSchema.parse({ session: buildSession(row as SessionRow) });
		});
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

	setModel(input: SetChatSessionModelInput): SetChatSessionModelOutput {
		const parsedInput = setChatSessionModelInputSchema.parse(input);
		this.selectRow(parsedInput.sessionId);
		this.orm
			.update(chatSessionsTable)
			.set({ ...toModelColumns(parsedInput.model), updatedAtMs: this.clock.now() })
			.where(eq(chatSessionsTable.id, parsedInput.sessionId))
			.run();

		return setChatSessionModelOutputSchema.parse({
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
			throw new ChatSessionNotFoundError(sessionId);
		}
		return row;
	}
}

export function createSessionRepository(database: { orm: AppDrizzleDatabase }): SessionRepository {
	return new SqliteSessionRepository(database.orm);
}
