import type Database from "bun:sqlite";
import {
	appErrorSchema,
	type AppError,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	type ChatRun,
	type ChatRunEvent,
	type ChatRunEventSource,
	chatRunEventSchema,
	chatRunSchema,
	type ChatRunStatus,
	chatRunStatusSchema,
	type OpenAiCompatibleProviderConfigInput,
	type OpenAiCompatibleProviderState,
	openAiCompatibleProviderStateSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { chatRunEventsTable, chatRunsTable, chatSessionsTable } from "./schema";

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

interface ErrorRecord {
	schemaVersion: 1;
	error: AppError;
}

export interface CreateRunInput {
	sessionId: string;
	mode: ChatRun["mode"];
	provider: OpenAiCompatibleProviderConfigInput;
	userMessageId: string;
	assistantMessageId: string;
}

export interface CreateRunResult {
	run: ChatRun;
	event: ChatRunEvent;
}

export interface UpdateRunStatusInput {
	runId: string;
	status: ChatRunStatus;
	source?: ChatRunEventSource;
}

export interface RunStatusMutationResult {
	run: ChatRun;
	event: ChatRunEvent;
}

export interface AppendRunEventInput {
	runId: string;
	type: ChatRunEvent["type"];
	source: ChatRunEventSource;
	visibility?: ChatRunEvent["visibility"];
	payload: ChatRunEvent["payload"];
}

export interface FailRunInput {
	runId: string;
	error: AppError;
	source?: ChatRunEventSource;
	messageEvent?: {
		messageId: string;
		content: string;
	};
}

export interface FailRunResult {
	run: ChatRun;
	events: ChatRunEvent[];
}

export interface ListRunEventsInput {
	runId: string;
	afterSeq?: number;
}

export interface RunJournalRepository {
	create(input: CreateRunInput): CreateRunResult;
	get(runId: string): ChatRun;
	listBySession(sessionId: string): ChatRun[];
	updateStatus(input: UpdateRunStatusInput): RunStatusMutationResult;
	appendEvent(input: AppendRunEventInput): ChatRunEvent;
	fail(input: FailRunInput): FailRunResult;
	cancel(input: CancelChatRunInput): CancelChatRunOutput;
	listEvents(input: ListRunEventsInput): ChatRunEvent[];
}

type RunRow = typeof chatRunsTable.$inferSelect;
type EventRow = typeof chatRunEventsTable.$inferSelect;

const terminalRunStatuses = new Set<ChatRunStatus>(["cancelled", "completed", "failed"]);

const allowedRunTransitions: Record<ChatRunStatus, ReadonlySet<ChatRunStatus>> = {
	cancelled: new Set(),
	cancelling: new Set(["cancelled", "failed"]),
	completed: new Set(),
	failed: new Set(),
	queued: new Set(["cancelled", "cancelling", "failed", "running"]),
	running: new Set(["cancelling", "completed", "failed"]),
};

function toIsoDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function parseJsonValue(raw: string, description: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${description} JSON.`, { cause: error });
	}
}

function toSafeProviderState(
	provider: OpenAiCompatibleProviderConfigInput,
): OpenAiCompatibleProviderState {
	return openAiCompatibleProviderStateSchema.parse({
		schemaVersion: 1,
		providerId: provider.providerId,
		name: provider.name,
		baseUrl: provider.baseUrl,
		model: provider.model,
		organization: provider.organization,
		status: "ready",
	});
}

function parseError(raw: string | null): AppError | undefined {
	if (raw === null) {
		return undefined;
	}
	const value = parseJsonValue(raw, "error record");
	if (typeof value !== "object" || value === null || !("error" in value)) {
		throw new Error("Invalid error record.");
	}
	return appErrorSchema.parse(value.error);
}

function serializeError(error: AppError): string {
	return JSON.stringify({
		schemaVersion: 1,
		error: appErrorSchema.parse(error),
	} satisfies ErrorRecord);
}

function buildRun(row: RunRow): ChatRun {
	return chatRunSchema.parse({
		schemaVersion: 1,
		id: row.id,
		sessionId: row.sessionId,
		mode: row.mode,
		status: row.status,
		provider: openAiCompatibleProviderStateSchema.parse(
			parseJsonValue(row.providerJson, "provider state"),
		),
		userMessageId: row.userMessageId,
		assistantMessageId: row.assistantMessageId,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
		completedAt: row.completedAtMs === null ? undefined : toIsoDateTime(row.completedAtMs),
		lastError: parseError(row.lastErrorJson),
	});
}

function buildEvent(row: EventRow): ChatRunEvent {
	return chatRunEventSchema.parse({
		schemaVersion: 1,
		id: row.id,
		runId: row.runId,
		sessionId: row.sessionId,
		seq: row.seq,
		type: row.type,
		source: { kind: row.sourceKind, id: row.sourceId ?? undefined },
		visibility: row.visibility,
		createdAt: toIsoDateTime(row.createdAtMs),
		payload: parseJsonValue(row.payloadJson, "event payload"),
	});
}

function assertTransitionAllowed(currentStatus: ChatRunStatus, nextStatus: ChatRunStatus): void {
	if (currentStatus === nextStatus) {
		throw new Error(`Run is already ${currentStatus}.`);
	}
	if (!allowedRunTransitions[currentStatus].has(nextStatus)) {
		throw new Error(`Run status cannot transition from ${currentStatus} to ${nextStatus}.`);
	}
}

export class SqliteRunJournalRepository implements RunJournalRepository {
	constructor(
		private readonly client: Database,
		private readonly orm: AppDrizzleDatabase,
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	create(input: CreateRunInput): CreateRunResult {
		const sessionId = uuidV7Schema.parse(input.sessionId);
		const userMessageId = uuidV7Schema.parse(input.userMessageId);
		const assistantMessageId = uuidV7Schema.parse(input.assistantMessageId);
		const provider = toSafeProviderState(input.provider);

		return this.inTransaction(() => {
			this.assertSessionExists(sessionId);
			const nowMs = this.clock.now();
			const row: RunRow = {
				id: this.idGenerator.create(nowMs),
				sessionId,
				mode: input.mode,
				status: "queued",
				providerJson: JSON.stringify(provider),
				userMessageId,
				assistantMessageId,
				lastErrorJson: null,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				completedAtMs: null,
			};
			this.orm.insert(chatRunsTable).values(row).run();
			const event = this.insertEvent({
				runId: row.id,
				sessionId,
				type: "run.status",
				source: { kind: "user" },
				visibility: "user",
				payload: { previousStatus: undefined, status: "queued" },
				createdAtMs: nowMs,
			});
			this.touchSession(sessionId, nowMs, true);
			return { run: buildRun(row), event: buildEvent(event) };
		});
	}

	get(runId: string): ChatRun {
		return buildRun(this.selectRun(uuidV7Schema.parse(runId)));
	}

	listBySession(sessionId: string): ChatRun[] {
		const parsedSessionId = uuidV7Schema.parse(sessionId);
		return this.orm
			.select()
			.from(chatRunsTable)
			.where(eq(chatRunsTable.sessionId, parsedSessionId))
			.orderBy(desc(chatRunsTable.createdAtMs), desc(chatRunsTable.id))
			.all()
			.map(buildRun);
	}

	updateStatus(input: UpdateRunStatusInput): RunStatusMutationResult {
		const runId = uuidV7Schema.parse(input.runId);
		const status = chatRunStatusSchema.parse(input.status);
		return this.inTransaction(() => {
			const row = this.selectRun(runId);
			assertTransitionAllowed(row.status, status);
			const nowMs = this.clock.now();
			const completedAtMs = terminalRunStatuses.has(status) ? nowMs : null;
			this.orm
				.update(chatRunsTable)
				.set({ status, updatedAtMs: nowMs, completedAtMs })
				.where(eq(chatRunsTable.id, runId))
				.run();
			const event = this.insertEvent({
				runId,
				sessionId: row.sessionId,
				type: "run.status",
				source: input.source ?? { kind: "system" },
				visibility: "user",
				payload: { previousStatus: row.status, status },
				createdAtMs: nowMs,
			});
			this.touchSession(row.sessionId, nowMs, false);
			return {
				run: buildRun({ ...row, status, updatedAtMs: nowMs, completedAtMs }),
				event: buildEvent(event),
			};
		});
	}

	appendEvent(input: AppendRunEventInput): ChatRunEvent {
		return this.inTransaction(() => {
			const row = this.selectRun(uuidV7Schema.parse(input.runId));
			const nowMs = this.clock.now();
			const event = this.insertEvent({
				runId: row.id,
				sessionId: row.sessionId,
				type: input.type,
				source: input.source,
				visibility: input.visibility ?? "user",
				payload: input.payload,
				createdAtMs: nowMs,
			});
			this.touchSession(row.sessionId, nowMs, input.type.startsWith("message."));
			return buildEvent(event);
		});
	}

	fail(input: FailRunInput): FailRunResult {
		const runId = uuidV7Schema.parse(input.runId);
		const error = appErrorSchema.parse(input.error);
		return this.inTransaction(() => {
			const row = this.selectRun(runId);
			if (terminalRunStatuses.has(row.status)) {
				throw new Error(`Run ${runId} is already ${row.status}.`);
			}
			const nowMs = this.clock.now();
			const source = input.source ?? { kind: "system" as const };
			const events: ChatRunEvent[] = [];
			if (input.messageEvent !== undefined) {
				events.push(
					buildEvent(
						this.insertEvent({
							runId,
							sessionId: row.sessionId,
							type: "message.completed",
							source: { kind: "assistant" },
							visibility: "user",
							payload: {
								messageId: input.messageEvent.messageId,
								status: "failed",
								content: input.messageEvent.content,
								error,
							},
							createdAtMs: nowMs,
						}),
					),
				);
			}
			events.push(
				buildEvent(
					this.insertEvent({
						runId,
						sessionId: row.sessionId,
						type: "run.error",
						source,
						visibility: "user",
						payload: { error },
						createdAtMs: nowMs,
					}),
				),
			);
			this.orm
				.update(chatRunsTable)
				.set({
					status: "failed",
					lastErrorJson: serializeError(error),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				})
				.where(eq(chatRunsTable.id, runId))
				.run();
			events.push(
				buildEvent(
					this.insertEvent({
						runId,
						sessionId: row.sessionId,
						type: "run.status",
						source,
						visibility: "user",
						payload: { previousStatus: row.status, status: "failed" },
						createdAtMs: nowMs,
					}),
				),
			);
			this.touchSession(row.sessionId, nowMs, false);
			return {
				run: buildRun({
					...row,
					status: "failed",
					lastErrorJson: serializeError(error),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				}),
				events,
			};
		});
	}

	cancel(input: CancelChatRunInput): CancelChatRunOutput {
		const parsedInput = cancelChatRunInputSchema.parse(input);
		const run = this.get(parsedInput.runId);
		if (terminalRunStatuses.has(run.status) || run.status === "cancelling") {
			return cancelChatRunOutputSchema.parse({ run });
		}
		return cancelChatRunOutputSchema.parse({
			run: this.updateStatus({
				runId: run.id,
				status: run.status === "queued" ? "cancelled" : "cancelling",
				source: { kind: "user" },
			}).run,
		});
	}

	listEvents(input: ListRunEventsInput): ChatRunEvent[] {
		const runId = uuidV7Schema.parse(input.runId);
		const afterSeq = input.afterSeq;
		if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
			throw new Error("afterSeq must be a non-negative integer.");
		}
		return this.orm
			.select()
			.from(chatRunEventsTable)
			.where(
				afterSeq === undefined
					? eq(chatRunEventsTable.runId, runId)
					: and(eq(chatRunEventsTable.runId, runId), gt(chatRunEventsTable.seq, afterSeq)),
			)
			.orderBy(asc(chatRunEventsTable.seq))
			.all()
			.map(buildEvent);
	}

	private inTransaction<TResult>(callback: () => TResult): TResult {
		this.client.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			this.client.exec("COMMIT");
			return result;
		} catch (error) {
			this.client.exec("ROLLBACK");
			throw error;
		}
	}

	private assertSessionExists(sessionId: string): void {
		const row = this.orm
			.select({ id: chatSessionsTable.id })
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.id, sessionId))
			.get();
		if (row === undefined) {
			throw new Error(`Chat session ${sessionId} was not found.`);
		}
	}

	private selectRun(runId: string): RunRow {
		const row = this.orm.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId)).get();
		if (row === undefined) {
			throw new Error(`Chat run ${runId} was not found.`);
		}
		return row;
	}

	private insertEvent(args: {
		runId: string;
		sessionId: string;
		type: ChatRunEvent["type"];
		source: ChatRunEventSource;
		visibility: ChatRunEvent["visibility"];
		payload: ChatRunEvent["payload"];
		createdAtMs: number;
	}): EventRow {
		const seqRow = this.orm
			.select({ value: sql<number>`coalesce(max(${chatRunEventsTable.seq}), 0)` })
			.from(chatRunEventsTable)
			.where(eq(chatRunEventsTable.runId, args.runId))
			.get();
		const event = chatRunEventSchema.parse({
			schemaVersion: 1,
			id: this.idGenerator.create(args.createdAtMs),
			runId: args.runId,
			sessionId: args.sessionId,
			seq: (seqRow?.value ?? 0) + 1,
			type: args.type,
			source: args.source,
			visibility: args.visibility,
			createdAt: toIsoDateTime(args.createdAtMs),
			payload: args.payload,
		});
		const row: EventRow = {
			id: event.id,
			runId: event.runId,
			sessionId: event.sessionId,
			seq: event.seq,
			type: event.type,
			sourceKind: event.source.kind,
			sourceId: event.source.id ?? null,
			visibility: event.visibility,
			payloadJson: JSON.stringify(event.payload),
			createdAtMs: args.createdAtMs,
		};
		this.orm.insert(chatRunEventsTable).values(row).run();
		return row;
	}

	private touchSession(sessionId: string, nowMs: number, updateLastMessageAt: boolean): void {
		this.orm
			.update(chatSessionsTable)
			.set({
				updatedAtMs: nowMs,
				lastMessageAtMs: updateLastMessageAt
					? nowMs
					: sql`coalesce(${chatSessionsTable.lastMessageAtMs}, ${nowMs})`,
			})
			.where(eq(chatSessionsTable.id, sessionId))
			.run();
	}
}

export function createRunJournalRepository(database: {
	client: Database;
	orm: AppDrizzleDatabase;
}): RunJournalRepository {
	return new SqliteRunJournalRepository(database.client, database.orm);
}
