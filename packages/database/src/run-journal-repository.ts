import type Database from "bun:sqlite";
import {
	type AppError,
	appErrorSchema,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatRun,
	type ChatRunEvent,
	type ChatRunEventSource,
	type ChatRunStatus,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatRunEventSchema,
	chatRunSchema,
	chatRunStatusSchema,
	deleteChatSessionOutputSchema,
	type RunProviderConfigInput,
	type RunProviderState,
	retiredSessionTombstoneTtlMs,
	runProviderStateSchema,
	sendAskChatMessageInputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import {
	chatRunEventsTable,
	chatRunsTable,
	chatSessionsTable,
	checkpointDeletionOutboxTable,
	retiredChatSessionsTable,
} from "./schema";
import { ChatSessionNotFoundError } from "./session-repository";

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
	clientRequestId: string;
	sessionId: string;
	mode: ChatRun["mode"];
	provider: RunProviderConfigInput;
	userMessageId: string;
	userContent: string;
	assistantMessageId: string;
}

export interface CreateRunResult {
	run: ChatRun;
	event: ChatRunEvent;
	events: ChatRunEvent[];
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

export const maxRunEventPageSize = 1_000;
export const maxRetiredSessionTombstones = 10_000;
export const maxCheckpointDeletionBatchSize = 100;
export const maxCheckpointDeletionJobs = 10_000;

export interface ReplayCursorSupport {
	serverTimeMs: number;
	oldestSupportedCursorIssuedAtMs: number;
	tombstoneTtlMs: typeof retiredSessionTombstoneTtlMs;
}

export interface CheckpointDeletionJob {
	sessionId: string;
	createdAtMs: number;
	attemptCount: number;
	nextAttemptAtMs: number;
	lastAttemptAtMs?: number;
	lastError?: string;
}

export interface ListRunEventPageInput extends ListRunEventsInput {
	limit: number;
}

export interface ListRunEventPageOutput {
	events: ChatRunEvent[];
	hasMore: boolean;
}

export interface RunPageCursor {
	createdAtMs: number;
	id: string;
}

export interface RunJournalPageItem {
	run: ChatRun;
	userContent: string;
	assistantContent?: string;
	events: ChatRunEvent[];
	lastEventSeq: number;
}

export interface ListRunPageInput {
	sessionId: string;
	after?: RunPageCursor;
	limit: number;
}

export interface ListRunPageOutput {
	items: RunJournalPageItem[];
	nextCursor?: RunPageCursor;
}

type MessageCompletedPayload = Extract<ChatRunEvent, { type: "message.completed" }>["payload"];

export interface CommitRunTerminalInput {
	runId: string;
	message: MessageCompletedPayload;
	source?: ChatRunEventSource;
}

export interface CommitRunTerminalOutput {
	run: ChatRun;
	events: ChatRunEvent[];
	committed: boolean;
}

export interface RunJournalRepository {
	create(input: CreateRunInput): CreateRunResult;
	getByClientRequestId(clientRequestId: string): RunJournalPageItem | undefined;
	getClientRequestId(runId: string): string;
	get(runId: string): ChatRun;
	listBySession(sessionId: string): ChatRun[];
	listPageBySession(input: ListRunPageInput): ListRunPageOutput;
	updateStatus(input: UpdateRunStatusInput): RunStatusMutationResult;
	appendEvent(input: AppendRunEventInput): ChatRunEvent;
	fail(input: FailRunInput): FailRunResult;
	cancel(input: CancelChatRunInput): CancelChatRunOutput;
	commitTerminal(input: CommitRunTerminalInput): CommitRunTerminalOutput;
	listEvents(input: ListRunEventsInput): ChatRunEvent[];
	listEventPage(input: ListRunEventPageInput): ListRunEventPageOutput;
	deleteSessionAndRetireRuns(sessionId: string): {
		sessionId: string;
	};
	isSessionRetired(sessionId: string): boolean;
	getReplayCursorSupport(): ReplayCursorSupport;
	listPendingCheckpointDeletions(limit: number, includeDeferred?: boolean): CheckpointDeletionJob[];
	recordCheckpointDeletionFailure(sessionId: string, error: string, nextAttemptAtMs: number): void;
	ackCheckpointDeletion(sessionId: string): void;
}

export class ChatRunNotFoundError extends Error {
	constructor(readonly runId: string) {
		super(`Chat run ${runId} was not found.`);
		this.name = "ChatRunNotFoundError";
	}
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

/** Strips the API key and every custom header value before a run is journalled. */
function toSafeProviderState(provider: RunProviderConfigInput): RunProviderState {
	return runProviderStateSchema.parse({
		schemaVersion: 1,
		providerId: provider.providerId,
		name: provider.name,
		type: provider.type,
		baseUrl: provider.baseUrl,
		model: provider.model,
		organization: provider.organization,
		reasoningEffort: provider.reasoningEffort,
		reasoningBudgetTokens: provider.reasoningBudgetTokens,
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

function parseRunProviderState(raw: string): RunProviderState {
	const value = parseJsonValue(raw, "provider state");
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return runProviderStateSchema.parse(value);
	}
	const storedType = "type" in value ? value.type : undefined;
	const type =
		storedType === "openai-chat-completions" || storedType === "openai-responses"
			? "openai-compatible"
			: storedType === "anthropic-messages"
				? "anthropic-compatible"
				: storedType;
	return runProviderStateSchema.parse({ ...value, type });
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
		provider: parseRunProviderState(row.providerJson),
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

function runStatusForMessageStatus(
	status: MessageCompletedPayload["status"],
): Extract<ChatRunStatus, "completed" | "failed" | "cancelled"> {
	switch (status) {
		case "complete":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
	}
}

function requireSafeTimestamp(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("Run page cursor timestamp must be a non-negative safe integer.");
	}
	return value;
}

function requireRequestId(value: string): string {
	const normalized = value.trim();
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
	) {
		throw new Error("Run client request ID must be a UUID.");
	}
	return normalized;
}

export class SqliteRunJournalRepository implements RunJournalRepository {
	constructor(
		private readonly client: Database,
		private readonly orm: AppDrizzleDatabase,
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
		private readonly clock: RepositoryClock = { now: () => Date.now() },
	) {}

	create(input: CreateRunInput): CreateRunResult {
		const clientRequestId = requireRequestId(input.clientRequestId);
		const sessionId = uuidV7Schema.parse(input.sessionId);
		const userMessageId = uuidV7Schema.parse(input.userMessageId);
		const assistantMessageId = uuidV7Schema.parse(input.assistantMessageId);
		const userContent = sendAskChatMessageInputSchema.parse({
			requestId: clientRequestId,
			sessionId,
			content: input.userContent,
		}).content;
		const provider = toSafeProviderState(input.provider);

		return this.inTransaction(() => {
			this.assertSessionExists(sessionId);
			const nowMs = this.clock.now();
			const row: RunRow = {
				id: this.idGenerator.create(nowMs),
				clientRequestId,
				sessionId,
				mode: input.mode,
				status: "queued",
				providerJson: JSON.stringify(provider),
				userMessageId,
				userContent,
				assistantMessageId,
				assistantContent: null,
				lastErrorJson: null,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				completedAtMs: null,
			};
			this.orm.insert(chatRunsTable).values(row).run();
			const queuedEvent = this.insertEvent({
				runId: row.id,
				sessionId,
				type: "run.status",
				source: { kind: "user" },
				visibility: "user",
				payload: { previousStatus: undefined, status: "queued" },
				createdAtMs: nowMs,
			});
			const startedEvent = this.insertEvent({
				runId: row.id,
				sessionId,
				type: "message.started",
				source: { kind: "assistant" },
				visibility: "user",
				payload: {
					messageId: assistantMessageId,
					role: "assistant",
					status: "streaming",
				},
				createdAtMs: nowMs,
			});
			this.touchSession(sessionId, nowMs, true);
			const event = buildEvent(queuedEvent);
			return {
				run: buildRun(row),
				event,
				events: [event, buildEvent(startedEvent)],
			};
		});
	}

	get(runId: string): ChatRun {
		return buildRun(this.selectRun(uuidV7Schema.parse(runId)));
	}

	getClientRequestId(runId: string): string {
		return this.selectRun(uuidV7Schema.parse(runId)).clientRequestId;
	}

	getByClientRequestId(clientRequestId: string): RunJournalPageItem | undefined {
		const row = this.orm
			.select()
			.from(chatRunsTable)
			.where(eq(chatRunsTable.clientRequestId, requireRequestId(clientRequestId)))
			.get();
		if (row === undefined) {
			return undefined;
		}
		return {
			run: buildRun(row),
			userContent: row.userContent,
			...(row.assistantContent === null ? {} : { assistantContent: row.assistantContent }),
			events: terminalRunStatuses.has(row.status) ? [] : this.listEvents({ runId: row.id }),
			lastEventSeq: this.getLastEventSeq(row.id),
		};
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

	listPageBySession(input: ListRunPageInput): ListRunPageOutput {
		const sessionId = uuidV7Schema.parse(input.sessionId);
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
			throw new Error("Run page limit must be between 1 and 100.");
		}
		const after =
			input.after === undefined
				? undefined
				: {
						createdAtMs: requireSafeTimestamp(input.after.createdAtMs),
						id: uuidV7Schema.parse(input.after.id),
					};
		const cursorCondition =
			after === undefined
				? undefined
				: sql`(${chatRunsTable.createdAtMs}, ${chatRunsTable.id}) > (${after.createdAtMs}, ${after.id})`;
		const rows = this.orm
			.select()
			.from(chatRunsTable)
			.where(
				cursorCondition === undefined
					? eq(chatRunsTable.sessionId, sessionId)
					: and(eq(chatRunsTable.sessionId, sessionId), cursorCondition),
			)
			.orderBy(asc(chatRunsTable.createdAtMs), asc(chatRunsTable.id))
			.limit(input.limit + 1)
			.all();
		const pageRows = rows.slice(0, input.limit);
		const eventsByRun = new Map<string, ChatRunEvent[]>();
		const activeRunIds = pageRows
			.filter((row) => !terminalRunStatuses.has(row.status))
			.map((row) => row.id);
		if (activeRunIds.length > 0) {
			for (const event of this.orm
				.select()
				.from(chatRunEventsTable)
				.where(inArray(chatRunEventsTable.runId, activeRunIds))
				.orderBy(asc(chatRunEventsTable.runId), asc(chatRunEventsTable.seq))
				.all()
				.map(buildEvent)) {
				const events = eventsByRun.get(event.runId) ?? [];
				events.push(event);
				eventsByRun.set(event.runId, events);
			}
		}
		const lastSeqByRun = new Map<string, number>();
		if (pageRows.length > 0) {
			for (const row of this.orm
				.select({
					runId: chatRunEventsTable.runId,
					lastSeq: sql<number>`max(${chatRunEventsTable.seq})`,
				})
				.from(chatRunEventsTable)
				.where(
					inArray(
						chatRunEventsTable.runId,
						pageRows.map((pageRow) => pageRow.id),
					),
				)
				.groupBy(chatRunEventsTable.runId)
				.all()) {
				lastSeqByRun.set(row.runId, row.lastSeq);
			}
		}
		const last = pageRows.at(-1);
		return {
			items: pageRows.map((row) => ({
				run: buildRun(row),
				userContent: row.userContent,
				...(row.assistantContent === null ? {} : { assistantContent: row.assistantContent }),
				events: eventsByRun.get(row.id) ?? [],
				lastEventSeq: lastSeqByRun.get(row.id) ?? 0,
			})),
			...(rows.length > input.limit && last !== undefined
				? { nextCursor: { createdAtMs: last.createdAtMs, id: last.id } }
				: {}),
		};
	}

	updateStatus(input: UpdateRunStatusInput): RunStatusMutationResult {
		const runId = uuidV7Schema.parse(input.runId);
		const status = chatRunStatusSchema.parse(input.status);
		if (terminalRunStatuses.has(status)) {
			throw new Error(`Use commitTerminal() to transition a Run to ${status}.`);
		}
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
					assistantContent: input.messageEvent?.content ?? row.assistantContent,
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
					assistantContent: input.messageEvent?.content ?? row.assistantContent,
					lastErrorJson: serializeError(error),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				}),
				events,
			};
		});
	}

	commitTerminal(input: CommitRunTerminalInput): CommitRunTerminalOutput {
		const runId = uuidV7Schema.parse(input.runId);
		return this.inTransaction(() => {
			const row = this.selectRun(runId);
			if (input.message.messageId !== row.assistantMessageId) {
				throw new Error(`Run ${runId} terminal message ID does not match its assistant message.`);
			}
			const existingMessageRow = this.orm
				.select()
				.from(chatRunEventsTable)
				.where(
					and(
						eq(chatRunEventsTable.runId, runId),
						eq(chatRunEventsTable.type, "message.completed"),
					),
				)
				.orderBy(desc(chatRunEventsTable.seq))
				.get();
			const existingMessage =
				existingMessageRow === undefined ? undefined : buildEvent(existingMessageRow);
			if (existingMessage !== undefined && existingMessage.type !== "message.completed") {
				throw new Error(`Run ${runId} has an invalid terminal message event.`);
			}
			const message =
				existingMessage?.type === "message.completed" ? existingMessage.payload : input.message;
			if (message.messageId !== row.assistantMessageId) {
				throw new Error(`Run ${runId} persisted terminal message ID is inconsistent.`);
			}
			const terminalStatus = runStatusForMessageStatus(message.status);
			const terminalError = message.status === "failed" ? message.error : undefined;
			if (terminalStatus === "failed" && terminalError === undefined) {
				throw new Error(`Run ${runId} failed terminal message is missing its error.`);
			}
			if (terminalRunStatuses.has(row.status) && row.status !== terminalStatus) {
				throw new Error(
					`Run ${runId} terminal status ${row.status} conflicts with message status ${message.status}.`,
				);
			}

			const nowMs = this.clock.now();
			const source = input.source ?? { kind: "system" as const };
			const events: ChatRunEvent[] = [];
			if (existingMessage === undefined) {
				events.push(
					buildEvent(
						this.insertEvent({
							runId,
							sessionId: row.sessionId,
							type: "message.completed",
							source: { kind: "assistant" },
							visibility: "user",
							payload: message,
							createdAtMs: nowMs,
						}),
					),
				);
			}
			if (
				terminalStatus === "failed" &&
				terminalError !== undefined &&
				!this.hasEventType(runId, "run.error")
			) {
				events.push(
					buildEvent(
						this.insertEvent({
							runId,
							sessionId: row.sessionId,
							type: "run.error",
							source,
							visibility: "user",
							payload: { error: terminalError },
							createdAtMs: nowMs,
						}),
					),
				);
			}

			let updatedRow = row;
			if (!terminalRunStatuses.has(row.status)) {
				this.orm
					.update(chatRunsTable)
					.set({
						status: terminalStatus,
						assistantContent: message.content,
						lastErrorJson: terminalError === undefined ? null : serializeError(terminalError),
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
							payload: { previousStatus: row.status, status: terminalStatus },
							createdAtMs: nowMs,
						}),
					),
				);
				updatedRow = {
					...row,
					status: terminalStatus,
					assistantContent: message.content,
					lastErrorJson: terminalError === undefined ? null : serializeError(terminalError),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				};
			} else if (row.assistantContent !== message.content) {
				this.orm
					.update(chatRunsTable)
					.set({
						assistantContent: message.content,
						lastErrorJson: terminalError === undefined ? null : serializeError(terminalError),
						updatedAtMs: nowMs,
					})
					.where(eq(chatRunsTable.id, runId))
					.run();
				updatedRow = {
					...row,
					assistantContent: message.content,
					lastErrorJson: terminalError === undefined ? null : serializeError(terminalError),
					updatedAtMs: nowMs,
				};
			}
			if (events.length > 0) {
				this.touchSession(row.sessionId, nowMs, true);
			}
			return {
				run: buildRun(updatedRow),
				events,
				committed: events.length > 0 || updatedRow !== row,
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
				status: "cancelling",
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

	listEventPage(input: ListRunEventPageInput): ListRunEventPageOutput {
		const runId = uuidV7Schema.parse(input.runId);
		const afterSeq = input.afterSeq ?? 0;
		if (!Number.isInteger(afterSeq) || afterSeq < 0) {
			throw new Error("afterSeq must be a non-negative integer.");
		}
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maxRunEventPageSize) {
			throw new Error(`Event page limit must be between 1 and ${maxRunEventPageSize}.`);
		}
		const rows = this.orm
			.select()
			.from(chatRunEventsTable)
			.where(and(eq(chatRunEventsTable.runId, runId), gt(chatRunEventsTable.seq, afterSeq)))
			.orderBy(asc(chatRunEventsTable.seq))
			.limit(input.limit + 1)
			.all();
		return {
			events: rows.slice(0, input.limit).map(buildEvent),
			hasMore: rows.length > input.limit,
		};
	}

	deleteSessionAndRetireRuns(sessionId: string): {
		sessionId: string;
	} {
		const parsedSessionId = uuidV7Schema.parse(sessionId);
		return this.inTransaction(() => {
			const retiredAtMs = this.clock.now();
			this.orm
				.delete(retiredChatSessionsTable)
				.where(
					sql`${retiredChatSessionsTable.retiredAtMs} <= ${
						retiredAtMs - retiredSessionTombstoneTtlMs
					}`,
				)
				.run();
			const existingRetirement = this.orm
				.select({ sessionId: retiredChatSessionsTable.sessionId })
				.from(retiredChatSessionsTable)
				.where(eq(retiredChatSessionsTable.sessionId, parsedSessionId))
				.get();
			if (existingRetirement !== undefined) {
				return {
					...deleteChatSessionOutputSchema.parse({ sessionId: parsedSessionId }),
				};
			}
			this.assertSessionExists(parsedSessionId);
			const retainedCount =
				this.orm.select({ count: sql<number>`count(*)` }).from(retiredChatSessionsTable).get()
					?.count ?? 0;
			if (retainedCount >= maxRetiredSessionTombstones) {
				throw new Error(
					`Retired Session recovery capacity is full (${maxRetiredSessionTombstones}); Session deletion is temporarily unavailable.`,
				);
			}
			this.orm
				.insert(retiredChatSessionsTable)
				.values({ sessionId: parsedSessionId, retiredAtMs })
				.run();
			const checkpointDeletionCount =
				this.orm.select({ count: sql<number>`count(*)` }).from(checkpointDeletionOutboxTable).get()
					?.count ?? 0;
			if (checkpointDeletionCount >= maxCheckpointDeletionJobs) {
				throw new Error(
					`Checkpoint deletion recovery capacity is full (${maxCheckpointDeletionJobs}); Session deletion is temporarily unavailable.`,
				);
			}
			this.orm
				.insert(checkpointDeletionOutboxTable)
				.values({
					sessionId: parsedSessionId,
					createdAtMs: retiredAtMs,
					nextAttemptAtMs: retiredAtMs,
				})
				.onConflictDoNothing()
				.run();
			this.orm.delete(chatSessionsTable).where(eq(chatSessionsTable.id, parsedSessionId)).run();
			return {
				...deleteChatSessionOutputSchema.parse({ sessionId: parsedSessionId }),
			};
		});
	}

	isSessionRetired(sessionId: string): boolean {
		const cutoffMs = this.clock.now() - retiredSessionTombstoneTtlMs;
		return (
			this.orm
				.select({ sessionId: retiredChatSessionsTable.sessionId })
				.from(retiredChatSessionsTable)
				.where(
					and(
						eq(retiredChatSessionsTable.sessionId, uuidV7Schema.parse(sessionId)),
						gt(retiredChatSessionsTable.retiredAtMs, cutoffMs),
					),
				)
				.get() !== undefined
		);
	}

	getReplayCursorSupport(): ReplayCursorSupport {
		const serverTimeMs = this.clock.now();
		return {
			serverTimeMs,
			oldestSupportedCursorIssuedAtMs: serverTimeMs - retiredSessionTombstoneTtlMs,
			tombstoneTtlMs: retiredSessionTombstoneTtlMs,
		};
	}

	listPendingCheckpointDeletions(limit: number, includeDeferred = false): CheckpointDeletionJob[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxCheckpointDeletionBatchSize) {
			throw new Error(
				`Checkpoint deletion batch limit must be between 1 and ${maxCheckpointDeletionBatchSize}.`,
			);
		}
		const nowMs = this.clock.now();
		return this.orm
			.select()
			.from(checkpointDeletionOutboxTable)
			.where(
				includeDeferred
					? undefined
					: sql`${checkpointDeletionOutboxTable.nextAttemptAtMs} <= ${nowMs}`,
			)
			.orderBy(
				asc(checkpointDeletionOutboxTable.nextAttemptAtMs),
				asc(checkpointDeletionOutboxTable.createdAtMs),
				asc(checkpointDeletionOutboxTable.sessionId),
			)
			.limit(limit)
			.all()
			.map((row) => ({
				sessionId: row.sessionId,
				createdAtMs: row.createdAtMs,
				attemptCount: row.attemptCount,
				nextAttemptAtMs: row.nextAttemptAtMs,
				...(row.lastAttemptAtMs === null ? {} : { lastAttemptAtMs: row.lastAttemptAtMs }),
				...(row.lastError === null ? {} : { lastError: row.lastError }),
			}));
	}

	recordCheckpointDeletionFailure(sessionId: string, error: string, nextAttemptAtMs: number): void {
		if (!Number.isSafeInteger(nextAttemptAtMs) || nextAttemptAtMs < 0) {
			throw new TypeError("Checkpoint deletion retry time must be a non-negative safe integer.");
		}
		this.orm
			.update(checkpointDeletionOutboxTable)
			.set({
				attemptCount: sql`${checkpointDeletionOutboxTable.attemptCount} + 1`,
				lastAttemptAtMs: this.clock.now(),
				lastError: error.slice(0, 2_000),
				nextAttemptAtMs,
			})
			.where(eq(checkpointDeletionOutboxTable.sessionId, uuidV7Schema.parse(sessionId)))
			.run();
	}

	ackCheckpointDeletion(sessionId: string): void {
		this.orm
			.delete(checkpointDeletionOutboxTable)
			.where(eq(checkpointDeletionOutboxTable.sessionId, uuidV7Schema.parse(sessionId)))
			.run();
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
			throw new ChatSessionNotFoundError(sessionId);
		}
	}

	private hasEventType(runId: string, type: ChatRunEvent["type"]): boolean {
		return (
			this.orm
				.select({ id: chatRunEventsTable.id })
				.from(chatRunEventsTable)
				.where(and(eq(chatRunEventsTable.runId, runId), eq(chatRunEventsTable.type, type)))
				.get() !== undefined
		);
	}

	private getLastEventSeq(runId: string): number {
		return (
			this.orm
				.select({ value: sql<number>`coalesce(max(${chatRunEventsTable.seq}), 0)` })
				.from(chatRunEventsTable)
				.where(eq(chatRunEventsTable.runId, runId))
				.get()?.value ?? 0
		);
	}

	private selectRun(runId: string): RunRow {
		const row = this.orm.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId)).get();
		if (row === undefined) {
			throw new ChatRunNotFoundError(runId);
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
