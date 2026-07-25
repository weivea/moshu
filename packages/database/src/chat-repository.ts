import type Database from "bun:sqlite";
import {
	appErrorSchema,
	type AppError,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	type ChatMessage,
	chatMessageSchema,
	type ChatRun,
	type ChatRunEvent,
	type ChatRunEventSource,
	chatRunEventSchema,
	chatRunSchema,
	type ChatRunStatus,
	chatRunStatusSchema,
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
	type GetChatSessionOutput,
	type GetChatSessionSnapshotOutput,
	getChatSessionInputSchema,
	getChatSessionOutputSchema,
	getChatSessionSnapshotOutputSchema,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	listChatSessionsInputSchema,
	listChatSessionsOutputSchema,
	type OpenAiCompatibleProviderConfigInput,
	type OpenAiCompatibleProviderState,
	openAiCompatibleProviderStateSchema,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	setChatSessionArchivedInputSchema,
	setChatSessionArchivedOutputSchema,
	type SendChatMessageInput,
	type SendChatMessageOutput,
	sendChatMessageInputSchema,
	sendChatMessageOutputSchema,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	updateChatSessionInputSchema,
	updateChatSessionOutputSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import { and, asc, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { chatMessagesTable, chatRunEventsTable, chatRunsTable, chatSessionsTable } from "./schema";

type UserChatMessage = Extract<ChatMessage, { role: "user" }>;
type AssistantOrSystemSource = { kind: "assistant" | "system"; id?: string };
type AnyEventSource = ChatRunEventSource;

interface ChatRepositoryClock {
	now(): number;
}

interface ChatRepositoryIdGenerator {
	create(nowMs?: number): string;
}

interface TextRecord {
	schemaVersion: 1;
	text: string;
}

interface ErrorRecord {
	schemaVersion: 1;
	error: AppError;
}

export interface CreateAssistantMessageInput {
	runId: string;
	source?: ChatRunEventSource;
}

export interface AppendAssistantMessageDeltaInput {
	runId: string;
	messageId: string;
	delta: string;
	source?: ChatRunEventSource;
}

export interface CompleteAssistantMessageInput {
	runId: string;
	messageId: string;
	content: string;
	source?: ChatRunEventSource;
}

export interface CancelAssistantMessageInput {
	runId: string;
	messageId: string;
	source?: ChatRunEventSource;
}

export interface FailRunInput {
	runId: string;
	error: AppError;
	messageId?: string;
	content?: string;
	source?: ChatRunEventSource;
}

export interface UpdateRunStatusInput {
	runId: string;
	status: ChatRunStatus;
	source?: ChatRunEventSource;
}

export interface ListMessagesInput {
	sessionId: string;
}

export interface GetMessageInput {
	sessionId: string;
	messageId: string;
}

export interface ListRunEventsInput {
	runId: string;
	afterSeq?: number;
}

export interface AssistantMessageMutationResult {
	message: ChatMessage;
	event: ChatRunEvent;
}

export interface RunStatusMutationResult {
	run: ChatRun;
	event: ChatRunEvent;
}

export interface FailRunResult {
	run: ChatRun;
	events: ChatRunEvent[];
	message?: ChatMessage;
}

export interface ChatRepository {
	createSession(input: CreateChatSessionInput): CreateChatSessionOutput;
	listSessions(input?: ListChatSessionsInput): ListChatSessionsOutput;
	updateSession(input: UpdateChatSessionInput): UpdateChatSessionOutput;
	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput;
	deleteSession(input: DeleteChatSessionInput): DeleteChatSessionOutput;
	getSession(input: GetChatSessionInput): GetChatSessionOutput;
	getSessionSnapshot(input: GetChatSessionInput): GetChatSessionSnapshotOutput;
	listMessages(input: ListMessagesInput): ChatMessage[];
	getMessage(input: GetMessageInput): ChatMessage;
	createUserMessageRun(input: SendChatMessageInput): SendChatMessageOutput;
	createAssistantMessage(input: CreateAssistantMessageInput): AssistantMessageMutationResult;
	appendAssistantMessageDelta(
		input: AppendAssistantMessageDeltaInput,
	): AssistantMessageMutationResult;
	completeAssistantMessage(input: CompleteAssistantMessageInput): AssistantMessageMutationResult;
	cancelAssistantMessage(input: CancelAssistantMessageInput): AssistantMessageMutationResult;
	updateRunStatus(input: UpdateRunStatusInput): RunStatusMutationResult;
	failRun(input: FailRunInput): FailRunResult;
	cancelRun(input: CancelChatRunInput): CancelChatRunOutput;
	replayRunEvents(input: ListRunEventsInput): ChatRunEvent[];
}

type SessionRow = typeof chatSessionsTable.$inferSelect;
type MessageRow = typeof chatMessagesTable.$inferSelect;
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

function assertStringLength(
	value: string,
	label: string,
	minLength: number,
	maxLength: number,
): string {
	if (value.length < minLength || value.length > maxLength) {
		throw new Error(`${label} must be between ${minLength} and ${maxLength} characters.`);
	}

	return value;
}

function parseAssistantOrSystemSource(
	source: ChatRunEventSource | undefined,
): AssistantOrSystemSource | undefined {
	if (source === undefined) {
		return undefined;
	}

	if (source.kind !== "assistant" && source.kind !== "system") {
		throw new Error("Assistant mutations only accept assistant or system event sources.");
	}

	return source.id === undefined
		? { kind: source.kind }
		: { kind: source.kind, id: uuidV7Schema.parse(source.id) };
}

function parseAnyEventSource(source: ChatRunEventSource | undefined): AnyEventSource | undefined {
	if (source === undefined) {
		return undefined;
	}

	if (source.id !== undefined) {
		uuidV7Schema.parse(source.id);
	}

	if (source.kind !== "assistant" && source.kind !== "system" && source.kind !== "user") {
		throw new Error("Unsupported event source kind.");
	}

	return source;
}

function parseTextRecordObject(value: unknown): TextRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Text record must be an object.");
	}

	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.text !== "string") {
		throw new Error("Invalid text record.");
	}

	assertStringLength(record.text, "Message text", 0, 200_000);

	return {
		schemaVersion: 1,
		text: record.text,
	};
}

function parseErrorRecordObject(value: unknown): ErrorRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Error record must be an object.");
	}

	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || !("error" in record)) {
		throw new Error("Invalid error record.");
	}

	return {
		schemaVersion: 1,
		error: appErrorSchema.parse(record.error),
	};
}

function toIsoDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function serializeTextRecord(text: string): string {
	const normalizedText = assertStringLength(text, "Message text", 0, 200_000);

	return JSON.stringify({
		schemaVersion: 1,
		text: normalizedText,
	} satisfies TextRecord);
}

function serializeErrorRecord(error: AppError): string {
	return JSON.stringify({
		schemaVersion: 1,
		error: appErrorSchema.parse(error),
	} satisfies ErrorRecord);
}

function parseJsonValue(raw: string, description: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${description} JSON.`, { cause: error });
	}
}

function parseTextRecord(raw: string): string {
	const parsed = parseTextRecordObject(parseJsonValue(raw, "text record"));

	return parsed.text;
}

function parseErrorRecord(raw: string | null): AppError | undefined {
	if (raw === null) {
		return undefined;
	}

	const parsed = parseErrorRecordObject(parseJsonValue(raw, "error record"));

	return parsed.error;
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

function parseProviderState(raw: string): OpenAiCompatibleProviderState {
	return openAiCompatibleProviderStateSchema.parse(parseJsonValue(raw, "provider state"));
}

function parseEventPayload(raw: string): unknown {
	return parseJsonValue(raw, "event payload");
}

function assertTransitionAllowed(currentStatus: ChatRunStatus, nextStatus: ChatRunStatus): void {
	if (currentStatus === nextStatus) {
		throw new Error(`Run is already ${currentStatus}.`);
	}

	if (!allowedRunTransitions[currentStatus].has(nextStatus)) {
		throw new Error(`Run status cannot transition from ${currentStatus} to ${nextStatus}.`);
	}
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

function buildMessage(row: MessageRow): ChatMessage {
	const base = {
		schemaVersion: 1,
		id: row.id,
		sessionId: row.sessionId,
		runId: row.runId ?? undefined,
		sequence: row.sequence,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
		content: parseTextRecord(row.contentJson),
	};

	const error = parseErrorRecord(row.errorJson);

	if (row.role === "user") {
		return chatMessageSchema.parse({
			...base,
			role: "user",
			status: "complete",
		});
	}

	if (row.status === "failed") {
		return chatMessageSchema.parse({
			...base,
			role: "assistant",
			status: "failed",
			error,
		});
	}

	if (row.status === "cancelled") {
		return chatMessageSchema.parse({
			...base,
			role: "assistant",
			status: "cancelled",
		});
	}

	return chatMessageSchema.parse({
		...base,
		role: "assistant",
		status: row.status,
	});
}

function buildRun(row: RunRow): ChatRun {
	if (row.userMessageId === null) {
		throw new Error(`Chat run ${row.id} is missing its user message reference.`);
	}

	return chatRunSchema.parse({
		schemaVersion: 1,
		id: row.id,
		sessionId: row.sessionId,
		mode: row.mode,
		status: row.status,
		provider: parseProviderState(row.providerJson),
		userMessageId: row.userMessageId,
		assistantMessageId: row.assistantMessageId ?? undefined,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
		completedAt: row.completedAtMs === null ? undefined : toIsoDateTime(row.completedAtMs),
		lastError: parseErrorRecord(row.lastErrorJson),
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
		source: {
			kind: row.sourceKind,
			id: row.sourceId ?? undefined,
		},
		visibility: row.visibility,
		createdAt: toIsoDateTime(row.createdAtMs),
		payload: parseEventPayload(row.payloadJson),
	});
}

function buildUserMessageResult(message: ChatMessage): UserChatMessage {
	if (message.role !== "user") {
		throw new Error("Expected a user message.");
	}

	return message as UserChatMessage;
}

export class SqliteChatRepository implements ChatRepository {
	constructor(
		private readonly client: Database,
		private readonly orm: AppDrizzleDatabase,
		private readonly idGenerator: ChatRepositoryIdGenerator = { create: createUuidV7 },
		private readonly clock: ChatRepositoryClock = { now: () => Date.now() },
	) {}

	createSession(input: CreateChatSessionInput): CreateChatSessionOutput {
		const parsedInput = createChatSessionInputSchema.parse(input);
		const nowMs = this.clock.now();
		const sessionRow: typeof chatSessionsTable.$inferInsert = {
			id: this.idGenerator.create(nowMs),
			title: parsedInput.title,
			defaultMode: parsedInput.defaultMode ?? "ask",
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
			lastMessageAtMs: null,
			archivedAtMs: null,
		};

		this.orm.insert(chatSessionsTable).values(sessionRow).run();

		return createChatSessionOutputSchema.parse({
			session: buildSession(sessionRow as SessionRow),
		});
	}

	listSessions(input: ListChatSessionsInput = {}): ListChatSessionsOutput {
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

		return listChatSessionsOutputSchema.parse({
			items: rows.map(buildSession),
		});
	}

	updateSession(input: UpdateChatSessionInput): UpdateChatSessionOutput {
		const parsedInput = updateChatSessionInputSchema.parse(input);
		this.selectSessionRow(parsedInput.sessionId);
		const nowMs = this.clock.now();

		this.orm
			.update(chatSessionsTable)
			.set({
				title: parsedInput.title,
				updatedAtMs: nowMs,
			})
			.where(eq(chatSessionsTable.id, parsedInput.sessionId))
			.run();

		return updateChatSessionOutputSchema.parse({
			session: buildSession(this.selectSessionRow(parsedInput.sessionId)),
		});
	}

	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		this.selectSessionRow(parsedInput.sessionId);
		const nowMs = this.clock.now();

		this.orm
			.update(chatSessionsTable)
			.set({
				archivedAtMs: parsedInput.archived ? nowMs : null,
				updatedAtMs: nowMs,
			})
			.where(eq(chatSessionsTable.id, parsedInput.sessionId))
			.run();

		return setChatSessionArchivedOutputSchema.parse({
			session: buildSession(this.selectSessionRow(parsedInput.sessionId)),
		});
	}

	deleteSession(input: DeleteChatSessionInput): DeleteChatSessionOutput {
		const parsedInput = deleteChatSessionInputSchema.parse(input);
		this.selectSessionRow(parsedInput.sessionId);
		this.orm.delete(chatSessionsTable).where(eq(chatSessionsTable.id, parsedInput.sessionId)).run();
		return deleteChatSessionOutputSchema.parse({ sessionId: parsedInput.sessionId });
	}

	getSession(input: GetChatSessionInput): GetChatSessionOutput {
		const parsedInput = getChatSessionInputSchema.parse(input);
		const sessionRow = this.selectSessionRow(parsedInput.sessionId);
		const messageRows = this.orm
			.select()
			.from(chatMessagesTable)
			.where(eq(chatMessagesTable.sessionId, parsedInput.sessionId))
			.orderBy(asc(chatMessagesTable.sequence))
			.all();
		const runRows = this.orm
			.select()
			.from(chatRunsTable)
			.where(eq(chatRunsTable.sessionId, parsedInput.sessionId))
			.orderBy(desc(chatRunsTable.createdAtMs), desc(chatRunsTable.id))
			.all();

		return getChatSessionOutputSchema.parse({
			session: buildSession(sessionRow),
			messages: messageRows.map(buildMessage),
			runs: runRows.map(buildRun),
		});
	}

	getSessionSnapshot(input: GetChatSessionInput): GetChatSessionSnapshotOutput {
		const parsedInput = getChatSessionInputSchema.parse(input);

		return this.inReadTransaction(() => {
			const snapshot = this.getSession(parsedInput);
			return getChatSessionSnapshotOutputSchema.parse({
				...snapshot,
				eventCursors: snapshot.runs.map((run) => ({
					runId: run.id,
					lastSeq: this.replayRunEvents({ runId: run.id }).at(-1)?.seq ?? 0,
				})),
			});
		});
	}

	listMessages(input: ListMessagesInput): ChatMessage[] {
		const parsedInput = {
			sessionId: uuidV7Schema.parse(input.sessionId),
		};

		return this.orm
			.select()
			.from(chatMessagesTable)
			.where(eq(chatMessagesTable.sessionId, parsedInput.sessionId))
			.orderBy(asc(chatMessagesTable.sequence))
			.all()
			.map(buildMessage);
	}

	getMessage(input: GetMessageInput): ChatMessage {
		const parsedInput = {
			messageId: uuidV7Schema.parse(input.messageId),
			sessionId: uuidV7Schema.parse(input.sessionId),
		};
		const messageRow = this.orm
			.select()
			.from(chatMessagesTable)
			.where(
				and(
					eq(chatMessagesTable.id, parsedInput.messageId),
					eq(chatMessagesTable.sessionId, parsedInput.sessionId),
				),
			)
			.get();

		if (messageRow === undefined) {
			throw new Error(`Chat message ${parsedInput.messageId} was not found.`);
		}

		return buildMessage(messageRow);
	}

	createUserMessageRun(input: SendChatMessageInput): SendChatMessageOutput {
		const parsedInput = sendChatMessageInputSchema.parse(input);

		return this.inTransaction(() => {
			const sessionRow = this.selectSessionRow(parsedInput.sessionId);
			const nowMs = this.clock.now();
			const runId = this.idGenerator.create(nowMs);
			const userMessageId = this.idGenerator.create(nowMs);
			const sequence = this.nextMessageSequence(parsedInput.sessionId);
			const providerState = toSafeProviderState(parsedInput.provider);

			const runInsert: typeof chatRunsTable.$inferInsert = {
				id: runId,
				sessionId: parsedInput.sessionId,
				mode: parsedInput.mode,
				status: "queued",
				providerJson: JSON.stringify(providerState),
				userMessageId: null,
				assistantMessageId: null,
				lastErrorJson: null,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				completedAtMs: null,
			};

			this.orm.insert(chatRunsTable).values(runInsert).run();

			const messageInsert: typeof chatMessagesTable.$inferInsert = {
				id: userMessageId,
				sessionId: parsedInput.sessionId,
				runId,
				role: "user",
				status: "complete",
				contentJson: serializeTextRecord(parsedInput.content),
				errorJson: null,
				sequence,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};

			this.orm.insert(chatMessagesTable).values(messageInsert).run();

			this.orm
				.update(chatRunsTable)
				.set({ userMessageId, updatedAtMs: nowMs })
				.where(eq(chatRunsTable.id, runId))
				.run();

			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					previousStatus: undefined,
					status: "queued",
				},
				runId,
				sessionId: parsedInput.sessionId,
				source: { kind: "user" },
				type: "run.status",
				visibility: "user",
			});

			this.touchSession(parsedInput.sessionId, nowMs, true);

			const session = buildSession({
				...sessionRow,
				updatedAtMs: nowMs,
				lastMessageAtMs: nowMs,
			});
			const userMessage = buildUserMessageResult(buildMessage(messageInsert as MessageRow));
			const run = buildRun({
				...runInsert,
				userMessageId,
				updatedAtMs: nowMs,
			} as RunRow);
			const event = buildEvent(eventRow);

			return sendChatMessageOutputSchema.parse({
				session,
				userMessage,
				run,
				events: [event],
			});
		});
	}

	createAssistantMessage(input: CreateAssistantMessageInput): AssistantMessageMutationResult {
		const parsedInput = {
			runId: uuidV7Schema.parse(input.runId),
			source: parseAssistantOrSystemSource(input.source),
		};

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			if (runRow.assistantMessageId !== null) {
				throw new Error(`Run ${parsedInput.runId} already has an assistant message.`);
			}

			const nowMs = this.clock.now();
			const messageId = this.idGenerator.create(nowMs);
			const sequence = this.nextMessageSequence(runRow.sessionId);
			const messageInsert: typeof chatMessagesTable.$inferInsert = {
				id: messageId,
				sessionId: runRow.sessionId,
				runId: runRow.id,
				role: "assistant",
				status: "streaming",
				contentJson: serializeTextRecord(""),
				errorJson: null,
				sequence,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			};

			this.orm.insert(chatMessagesTable).values(messageInsert).run();
			this.orm
				.update(chatRunsTable)
				.set({
					assistantMessageId: messageId,
					updatedAtMs: nowMs,
				})
				.where(eq(chatRunsTable.id, runRow.id))
				.run();

			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					messageId,
					role: "assistant",
					status: "streaming",
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "assistant" },
				type: "message.started",
				visibility: "user",
			});

			this.touchSession(runRow.sessionId, nowMs, true);

			return {
				message: buildMessage(messageInsert as MessageRow),
				event: buildEvent(eventRow),
			};
		});
	}

	appendAssistantMessageDelta(
		input: AppendAssistantMessageDeltaInput,
	): AssistantMessageMutationResult {
		const parsedInput = {
			delta: assertStringLength(input.delta, "Delta chunk", 1, 8_000),
			messageId: uuidV7Schema.parse(input.messageId),
			runId: uuidV7Schema.parse(input.runId),
			source: parseAssistantOrSystemSource(input.source),
		};

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			const messageRow = this.selectAssistantMessageRow(runRow.sessionId, parsedInput.messageId);

			if (messageRow.runId !== runRow.id || messageRow.status !== "streaming") {
				throw new Error(
					`Assistant message ${parsedInput.messageId} is not streaming for run ${runRow.id}.`,
				);
			}

			const nextContent = `${parseTextRecord(messageRow.contentJson)}${parsedInput.delta}`;
			const nowMs = this.clock.now();
			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					delta: parsedInput.delta,
					messageId: parsedInput.messageId,
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "assistant" },
				type: "message.delta",
				visibility: "user",
			});

			this.orm
				.update(chatMessagesTable)
				.set({
					contentJson: serializeTextRecord(nextContent),
					updatedAtMs: nowMs,
				})
				.where(eq(chatMessagesTable.id, parsedInput.messageId))
				.run();

			this.touchSession(runRow.sessionId, nowMs, true);

			return {
				message: buildMessage({
					...messageRow,
					contentJson: serializeTextRecord(nextContent),
					updatedAtMs: nowMs,
				}),
				event: buildEvent(eventRow),
			};
		});
	}

	completeAssistantMessage(input: CompleteAssistantMessageInput): AssistantMessageMutationResult {
		const parsedInput = {
			content: assertStringLength(input.content, "Assistant content", 1, 200_000),
			messageId: uuidV7Schema.parse(input.messageId),
			runId: uuidV7Schema.parse(input.runId),
			source: parseAssistantOrSystemSource(input.source),
		};

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			const messageRow = this.selectAssistantMessageRow(runRow.sessionId, parsedInput.messageId);

			if (messageRow.runId !== runRow.id || messageRow.status !== "streaming") {
				throw new Error(
					`Assistant message ${parsedInput.messageId} is not streaming for run ${runRow.id}.`,
				);
			}

			const nowMs = this.clock.now();
			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					content: parsedInput.content,
					messageId: parsedInput.messageId,
					status: "complete",
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "assistant" },
				type: "message.completed",
				visibility: "user",
			});

			this.orm
				.update(chatMessagesTable)
				.set({
					contentJson: serializeTextRecord(parsedInput.content),
					status: "complete",
					errorJson: null,
					updatedAtMs: nowMs,
				})
				.where(eq(chatMessagesTable.id, parsedInput.messageId))
				.run();

			this.touchSession(runRow.sessionId, nowMs, true);

			return {
				message: buildMessage({
					...messageRow,
					contentJson: serializeTextRecord(parsedInput.content),
					status: "complete",
					errorJson: null,
					updatedAtMs: nowMs,
				}),
				event: buildEvent(eventRow),
			};
		});
	}

	cancelAssistantMessage(input: CancelAssistantMessageInput): AssistantMessageMutationResult {
		const parsedInput = {
			messageId: uuidV7Schema.parse(input.messageId),
			runId: uuidV7Schema.parse(input.runId),
			source: parseAssistantOrSystemSource(input.source),
		};

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			const messageRow = this.selectAssistantMessageRow(runRow.sessionId, parsedInput.messageId);

			if (messageRow.runId !== runRow.id || messageRow.status !== "streaming") {
				throw new Error(
					`Assistant message ${parsedInput.messageId} is not streaming for run ${runRow.id}.`,
				);
			}

			const content = parseTextRecord(messageRow.contentJson);
			const nowMs = this.clock.now();
			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					content,
					messageId: parsedInput.messageId,
					status: "cancelled",
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "assistant" },
				type: "message.completed",
				visibility: "user",
			});

			this.orm
				.update(chatMessagesTable)
				.set({
					status: "cancelled",
					errorJson: null,
					updatedAtMs: nowMs,
				})
				.where(eq(chatMessagesTable.id, parsedInput.messageId))
				.run();

			this.touchSession(runRow.sessionId, nowMs, true);

			return {
				message: buildMessage({
					...messageRow,
					status: "cancelled",
					errorJson: null,
					updatedAtMs: nowMs,
				}),
				event: buildEvent(eventRow),
			};
		});
	}

	updateRunStatus(input: UpdateRunStatusInput): RunStatusMutationResult {
		const parsedInput = {
			runId: uuidV7Schema.parse(input.runId),
			source: parseAnyEventSource(input.source),
			status: chatRunStatusSchema.parse(input.status),
		};

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			assertTransitionAllowed(runRow.status, parsedInput.status);

			const nowMs = this.clock.now();
			const completedAtMs = terminalRunStatuses.has(parsedInput.status) ? nowMs : null;

			this.orm
				.update(chatRunsTable)
				.set({
					status: parsedInput.status,
					updatedAtMs: nowMs,
					completedAtMs,
				})
				.where(eq(chatRunsTable.id, parsedInput.runId))
				.run();

			const eventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					previousStatus: runRow.status,
					status: parsedInput.status,
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "system" },
				type: "run.status",
				visibility: "user",
			});

			this.touchSession(runRow.sessionId, nowMs, false);

			return {
				run: buildRun({
					...runRow,
					status: parsedInput.status,
					updatedAtMs: nowMs,
					completedAtMs,
				}),
				event: buildEvent(eventRow),
			};
		});
	}

	failRun(input: FailRunInput): FailRunResult {
		const parsedInput = {
			content:
				input.content === undefined
					? undefined
					: assertStringLength(input.content, "Failed assistant content", 0, 200_000),
			error: appErrorSchema.parse(input.error),
			messageId: input.messageId === undefined ? undefined : uuidV7Schema.parse(input.messageId),
			runId: uuidV7Schema.parse(input.runId),
			source: parseAssistantOrSystemSource(input.source),
		};

		if (parsedInput.content !== undefined && parsedInput.messageId === undefined) {
			throw new Error("content requires messageId.");
		}

		return this.inTransaction(() => {
			const runRow = this.selectRunRow(parsedInput.runId);
			if (terminalRunStatuses.has(runRow.status)) {
				throw new Error(`Run ${runRow.id} is already ${runRow.status}.`);
			}

			const nowMs = this.clock.now();
			const events: ChatRunEvent[] = [];
			let failedMessage: ChatMessage | undefined;

			if (parsedInput.messageId !== undefined) {
				const messageRow = this.selectAssistantMessageRow(runRow.sessionId, parsedInput.messageId);
				if (messageRow.runId !== runRow.id) {
					throw new Error(
						`Assistant message ${parsedInput.messageId} does not belong to run ${runRow.id}.`,
					);
				}

				const content = parsedInput.content ?? parseTextRecord(messageRow.contentJson);
				const messageCompletedEventRow = this.insertRunEvent({
					createdAtMs: nowMs,
					payload: {
						content,
						error: parsedInput.error,
						messageId: parsedInput.messageId,
						status: "failed",
					},
					runId: runRow.id,
					sessionId: runRow.sessionId,
					source: parsedInput.source ?? { kind: "assistant" },
					type: "message.completed",
					visibility: "user",
				});

				this.orm
					.update(chatMessagesTable)
					.set({
						contentJson: serializeTextRecord(content),
						status: "failed",
						errorJson: serializeErrorRecord(parsedInput.error),
						updatedAtMs: nowMs,
					})
					.where(eq(chatMessagesTable.id, parsedInput.messageId))
					.run();

				failedMessage = buildMessage({
					...messageRow,
					contentJson: serializeTextRecord(content),
					status: "failed",
					errorJson: serializeErrorRecord(parsedInput.error),
					updatedAtMs: nowMs,
				});
				events.push(buildEvent(messageCompletedEventRow));
			}

			const errorEventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					error: parsedInput.error,
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "system" },
				type: "run.error",
				visibility: "user",
			});
			events.push(buildEvent(errorEventRow));

			this.orm
				.update(chatRunsTable)
				.set({
					status: "failed",
					lastErrorJson: serializeErrorRecord(parsedInput.error),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				})
				.where(eq(chatRunsTable.id, runRow.id))
				.run();

			const statusEventRow = this.insertRunEvent({
				createdAtMs: nowMs,
				payload: {
					previousStatus: runRow.status,
					status: "failed",
				},
				runId: runRow.id,
				sessionId: runRow.sessionId,
				source: parsedInput.source ?? { kind: "system" },
				type: "run.status",
				visibility: "user",
			});
			events.push(buildEvent(statusEventRow));

			this.touchSession(runRow.sessionId, nowMs, false);

			const result: FailRunResult = {
				run: buildRun({
					...runRow,
					status: "failed",
					lastErrorJson: serializeErrorRecord(parsedInput.error),
					updatedAtMs: nowMs,
					completedAtMs: nowMs,
				}),
				events,
			};

			if (failedMessage !== undefined) {
				result.message = failedMessage;
			}

			return result;
		});
	}

	cancelRun(input: CancelChatRunInput): CancelChatRunOutput {
		const parsedInput = cancelChatRunInputSchema.parse(input);
		const runRow = this.selectRunRow(parsedInput.runId);
		if (terminalRunStatuses.has(runRow.status)) {
			return cancelChatRunOutputSchema.parse({
				run: buildRun(runRow),
			});
		}
		if (runRow.status === "cancelling") {
			return cancelChatRunOutputSchema.parse({
				run: buildRun(runRow),
			});
		}

		const nextStatus: ChatRunStatus = runRow.status === "queued" ? "cancelled" : "cancelling";
		const source: ChatRunEventSource =
			nextStatus === "cancelled" ? { kind: "user" } : { kind: "user" };
		const result = this.updateRunStatus({
			runId: parsedInput.runId,
			source,
			status: nextStatus,
		});

		return cancelChatRunOutputSchema.parse({
			run: result.run,
		});
	}

	replayRunEvents(input: ListRunEventsInput): ChatRunEvent[] {
		const parsedInput = {
			afterSeq:
				input.afterSeq === undefined
					? undefined
					: Number.isInteger(input.afterSeq) && input.afterSeq >= 0
						? input.afterSeq
						: (() => {
								throw new Error("afterSeq must be a non-negative integer.");
							})(),
			runId: uuidV7Schema.parse(input.runId),
		};

		return this.orm
			.select()
			.from(chatRunEventsTable)
			.where(
				parsedInput.afterSeq === undefined
					? eq(chatRunEventsTable.runId, parsedInput.runId)
					: and(
							eq(chatRunEventsTable.runId, parsedInput.runId),
							gt(chatRunEventsTable.seq, parsedInput.afterSeq),
						),
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

	private inReadTransaction<TResult>(callback: () => TResult): TResult {
		this.client.exec("BEGIN");

		try {
			const result = callback();
			this.client.exec("COMMIT");
			return result;
		} catch (error) {
			this.client.exec("ROLLBACK");
			throw error;
		}
	}

	private nextMessageSequence(sessionId: string): number {
		const row = this.orm
			.select({
				value: sql<number>`coalesce(max(${chatMessagesTable.sequence}), 0)`,
			})
			.from(chatMessagesTable)
			.where(eq(chatMessagesTable.sessionId, sessionId))
			.get();

		return (row?.value ?? 0) + 1;
	}

	private nextRunEventSequence(runId: string): number {
		const row = this.orm
			.select({
				value: sql<number>`coalesce(max(${chatRunEventsTable.seq}), 0)`,
			})
			.from(chatRunEventsTable)
			.where(eq(chatRunEventsTable.runId, runId))
			.get();

		return (row?.value ?? 0) + 1;
	}

	private insertRunEvent(args: {
		runId: string;
		sessionId: string;
		type: ChatRunEvent["type"];
		source: ChatRunEventSource;
		visibility: ChatRunEvent["visibility"];
		payload: ChatRunEvent["payload"];
		createdAtMs: number;
	}): EventRow {
		const seq = this.nextRunEventSequence(args.runId);
		const eventId = this.idGenerator.create(args.createdAtMs);
		const event = chatRunEventSchema.parse({
			schemaVersion: 1,
			id: eventId,
			runId: args.runId,
			sessionId: args.sessionId,
			seq,
			type: args.type,
			source: args.source,
			visibility: args.visibility,
			createdAt: toIsoDateTime(args.createdAtMs),
			payload: args.payload,
		});

		const row: EventRow = {
			id: event.id,
			runId: args.runId,
			sessionId: args.sessionId,
			seq: event.seq,
			type: args.type,
			sourceKind: args.source.kind,
			sourceId: args.source.id ?? null,
			visibility: args.visibility,
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

	private selectSessionRow(sessionId: string): SessionRow {
		const sessionRow = this.orm
			.select()
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.id, sessionId))
			.get();

		if (sessionRow === undefined) {
			throw new Error(`Chat session ${sessionId} was not found.`);
		}

		return sessionRow;
	}

	private selectRunRow(runId: string): RunRow {
		const runRow = this.orm.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId)).get();

		if (runRow === undefined) {
			throw new Error(`Chat run ${runId} was not found.`);
		}

		return runRow;
	}

	private selectAssistantMessageRow(sessionId: string, messageId: string): MessageRow {
		const messageRow = this.orm
			.select()
			.from(chatMessagesTable)
			.where(
				and(
					eq(chatMessagesTable.id, messageId),
					eq(chatMessagesTable.sessionId, sessionId),
					eq(chatMessagesTable.role, "assistant"),
				),
			)
			.get();

		if (messageRow === undefined) {
			throw new Error(`Assistant message ${messageId} was not found.`);
		}

		return messageRow;
	}
}

export function createChatRepository(database: {
	client: Database;
	orm: AppDrizzleDatabase;
}): ChatRepository {
	return new SqliteChatRepository(database.client, database.orm);
}
