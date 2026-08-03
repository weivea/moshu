import type Database from "bun:sqlite";
import {
	type AppError,
	appErrorSchema,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatRun,
	type ChatRunEvent,
	type ChatRunEventSource,
	type ChatRunPart,
	type ChatRunStatus,
	type ChatRunToolPart,
	type ChatUserMessage,
	chatRunToolPayloadBudgetBytes,
	cancelChatRunInputSchema,
	cancelChatRunOutputSchema,
	chatRunEventSchema,
	chatRunPartSchema,
	chatRunSchema,
	chatRunStatusSchema,
	chatRunTextPartSchema,
	chatRunToolPartSchema,
	chatUserMessageSchema,
	deleteChatSessionOutputSchema,
	maxRetiredSessionsPerRecoveryPage,
	normalizeAppErrorSafeMessage,
	type ProjectRootAgentsIssueCode,
	type ProjectRunContext,
	projectRunContextSchema,
	type RunProviderConfigInput,
	type RunProviderState,
	retiredSessionTombstoneTtlMs,
	runProviderStateSchema,
	sendAskChatMessageInputSchema,
	type ToolPublicPayload,
	toolPublicPayloadSchema,
	uuidV7Schema,
} from "@moshu/contracts";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import { buildRunTerminalAttentionInput } from "./mobile-attention-copy";
import type { MobileAttentionOutboxWriter } from "./mobile-attention-outbox-repository";
import {
	agentSessionCleanupOutboxTable,
	chatRunEventsTable,
	chatRunPartsTable,
	chatRunsTable,
	chatSessionsTable,
	retiredChatSessionsTable,
	runTimelineOutboxTable,
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
	projectContext?: ProjectRunContext;
	rootAgentsWarning?: ProjectRootAgentsIssueCode;
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

export type AppendRunEventInput = ChatRunEvent extends infer TEvent
	? TEvent extends ChatRunEvent
		? {
				runId: string;
				type: TEvent["type"];
				source: ChatRunEventSource;
				visibility?: TEvent["visibility"];
				payload: TEvent["payload"];
			}
		: never
	: never;

export interface FailRunInput {
	runId: string;
	error: AppError;
	source?: ChatRunEventSource;
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
export const maxAgentSessionCleanupBatchSize = 100;
export const maxAgentSessionCleanupJobs = 10_000;

export class SessionRetirementCapacityError extends Error {
	constructor(readonly capacity: "tombstones" | "cleanup_outbox") {
		super(
			capacity === "tombstones"
				? `Retired Session recovery capacity is full (${maxRetiredSessionTombstones}); Session deletion is temporarily unavailable.`
				: `Agent session cleanup recovery capacity is full (${maxAgentSessionCleanupJobs}); Session deletion is temporarily unavailable.`,
		);
		this.name = "SessionRetirementCapacityError";
	}
}

export interface ReplayCursorSupport {
	serverTimeMs: number;
	oldestSupportedCursorIssuedAtMs: number;
	tombstoneTtlMs: typeof retiredSessionTombstoneTtlMs;
}

export interface AgentSessionCleanupJob {
	sessionId: string;
	createdAtMs: number;
	attemptCount: number;
	nextAttemptAtMs: number;
	lastAttemptAtMs?: number;
	lastError?: string;
}

export interface ListRetiredSessionPageInput {
	cursor?: string | undefined;
	limit: number;
}

export interface ListRetiredSessionPageOutput {
	sessionIds: string[];
	nextCursor?: string;
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
	userMessage: ChatUserMessage;
	timeline: ChatRunPart[];
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

export interface CommitRunTerminalInput {
	runId: string;
	status: Extract<ChatRunStatus, "completed" | "failed" | "cancelled">;
	error?: AppError;
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
	listParts(runId: string): ChatRunPart[];
	drainTimelineOutbox(limit?: number): ChatRunEvent[];
	hasPendingTimelineOutbox(): boolean;
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
	listRetiredSessionPage(input: ListRetiredSessionPageInput): ListRetiredSessionPageOutput;
	getReplayCursorSupport(): ReplayCursorSupport;
	listPendingAgentSessionCleanups(
		limit: number,
		includeDeferred?: boolean,
	): AgentSessionCleanupJob[];
	recordAgentSessionCleanupFailure(sessionId: string, error: string, nextAttemptAtMs: number): void;
	ackAgentSessionCleanup(sessionId: string): void;
	hasNonTerminalForProject(projectId: string): boolean;
}

export class ChatRunNotFoundError extends Error {
	constructor(readonly runId: string) {
		super(`Chat run ${runId} was not found.`);
		this.name = "ChatRunNotFoundError";
	}
}

type RunRow = typeof chatRunsTable.$inferSelect;
type EventRow = typeof chatRunEventsTable.$inferSelect;
type PartRow = typeof chatRunPartsTable.$inferSelect;
type PartInsert = typeof chatRunPartsTable.$inferInsert;
type TimelineOutboxRow = typeof runTimelineOutboxTable.$inferSelect;

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

function toSafeProviderState(provider: RunProviderConfigInput): RunProviderState {
	return runProviderStateSchema.parse({
		schemaVersion: 1,
		providerId: provider.providerId,
		name: provider.name,
		source: provider.source,
		api: provider.api,
		model: provider.model,
		thinkingLevel: provider.thinkingLevel,
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
	return runProviderStateSchema.parse(value);
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
		runtimeBoxId: row.runtimeBoxId,
		...(row.projectId === null
			? {}
			: {
					projectContext: {
						projectId: row.projectId,
						runtimeBoxId: row.runtimeBoxId,
						projectPath: row.projectPath,
						projectPathRevision: row.projectPathRevision,
						...(row.projectGitRootPath === null ? {} : { gitRootPath: row.projectGitRootPath }),
						...(row.projectGitBranch === null ? {} : { gitBranch: row.projectGitBranch }),
						...(row.projectRootAgentsHash === null
							? {}
							: { rootAgentsHash: row.projectRootAgentsHash }),
					},
				}),
		mode: row.mode,
		status: row.status,
		provider: parseRunProviderState(row.providerJson),
		userMessageId: row.userMessageId,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
		completedAt: row.completedAtMs === null ? undefined : toIsoDateTime(row.completedAtMs),
		lastError: parseError(row.lastErrorJson),
	});
}

function buildUserMessage(row: RunRow): ChatUserMessage {
	return chatUserMessageSchema.parse({
		schemaVersion: 1,
		id: row.userMessageId,
		sessionId: row.sessionId,
		runId: row.id,
		role: "user",
		content: row.userContent,
		createdAt: toIsoDateTime(row.createdAtMs),
	});
}

function parseOptionalPublicPayload(raw: string | null, description: string) {
	return raw === null ? undefined : toolPublicPayloadSchema.parse(parseJsonValue(raw, description));
}

function buildPart(row: PartRow): ChatRunPart {
	const common = {
		schemaVersion: 1 as const,
		id: row.id,
		runId: row.runId,
		position: row.position,
		assistantTurnId: row.assistantTurnId,
		revision: row.revision,
		createdAt: toIsoDateTime(row.createdAtMs),
		updatedAt: toIsoDateTime(row.updatedAtMs),
	};
	if (row.kind === "text") {
		return chatRunTextPartSchema.parse({
			...common,
			kind: "text",
			status: row.status,
			content: row.textContent,
		});
	}

	const tool =
		row.toolKind === "mcp"
			? {
					kind: "mcp" as const,
					name: row.toolName,
					mcpServerId: row.mcpServerId,
					stableToolId: row.mcpToolId,
				}
			: {
					kind: "builtin" as const,
					name: row.toolName,
				};
	return chatRunToolPartSchema.parse({
		...common,
		kind: "tool",
		toolCallId: row.toolCallId,
		tool,
		status: row.status,
		summary: row.summary,
		input: parseOptionalPublicPayload(row.inputJson, "ToolPart input"),
		progress: parseOptionalPublicPayload(row.progressJson, "ToolPart progress"),
		output: parseOptionalPublicPayload(row.outputJson, "ToolPart output"),
		payloadsTruncated: row.payloadsTruncated ?? undefined,
		error:
			row.errorJson === null
				? undefined
				: appErrorSchema.parse(parseJsonValue(row.errorJson, "ToolPart error")),
		approvalId: row.approvalId ?? undefined,
		startedAt: row.startedAtMs === null ? undefined : toIsoDateTime(row.startedAtMs),
		completedAt: row.completedAtMs === null ? undefined : toIsoDateTime(row.completedAtMs),
		durationMs: row.durationMs ?? undefined,
	});
}

function projectAuthoritativeToolTransition(
	current: ChatRunToolPart,
	transition: TimelineOutboxRow,
): ChatRunToolPart {
	let status = current.status;
	if (transition.authority === "approval") {
		if (transition.status === "waiting_approval" && current.status === "queued") {
			status = "waiting_approval";
		} else if (
			(transition.status === "denied" || transition.status === "cancelled") &&
			(current.status === "queued" || current.status === "waiting_approval")
		) {
			status = transition.status;
		}
	} else if (transition.status === "running") {
		if (!isTerminalToolStatus(current.status)) {
			status = "running";
		}
	} else if (isTerminalToolStatus(transition.status)) {
		if (!isTerminalToolStatus(current.status) || current.status === "outcome_unknown") {
			status = transition.status;
		}
	}

	const approvalId = transition.approvalId ?? current.approvalId;
	const output =
		transition.publicOutputJson === null
			? current.output
			: toolPublicPayloadSchema.parse(
					parseJsonValue(transition.publicOutputJson, "Run timeline public output"),
				);
	if (
		status === current.status &&
		approvalId === current.approvalId &&
		JSON.stringify(output) === JSON.stringify(current.output)
	) {
		return current;
	}
	const updatedAtMs = Math.max(transition.createdAtMs, toEpochMs(current.updatedAt));
	const updatedAt = toIsoDateTime(updatedAtMs);
	const enteringRunning = status === "running" && current.status !== "running";
	const enteringTerminal = isTerminalToolStatus(status) && status !== current.status;
	const startedAt = enteringRunning ? (current.startedAt ?? updatedAt) : current.startedAt;
	const completedAt = enteringTerminal ? updatedAt : current.completedAt;
	const error = enteringTerminal
		? buildAuthoritativeToolError(status, transition.safeError, current.runId)
		: current.error;
	return chatRunToolPartSchema.parse({
		...current,
		status,
		...(approvalId === undefined ? {} : { approvalId }),
		...(output === undefined ? {} : { output }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(completedAt === undefined ? {} : { completedAt }),
		...(startedAt === undefined || completedAt === undefined
			? {}
			: { durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) }),
		error,
		revision: current.revision + 1,
		updatedAt,
	});
}

function buildAuthoritativeToolError(
	status: ChatRunToolPart["status"],
	safeError: string | null,
	runId: string,
): AppError | undefined {
	if (status === "completed") {
		return undefined;
	}
	const defaults: Partial<Record<ChatRunToolPart["status"], string>> = {
		cancelled: "Tool execution was cancelled.",
		denied: "Tool execution was denied.",
		failed: "Tool execution failed.",
		outcome_unknown: "The Tool outcome could not be confirmed.",
	};
	const fallback = defaults[status];
	if (fallback === undefined) {
		return undefined;
	}
	return appErrorSchema.parse({
		code: `TOOL_${status.toUpperCase()}`,
		category: "tool",
		messageKey: `chat.tool.${status}`,
		safeMessage: normalizeAppErrorSafeMessage(safeError, fallback),
		retryable: false,
		details: { runId },
	});
}

function isTerminalToolStatus(status: ChatRunToolPart["status"]): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "denied" ||
		status === "cancelled" ||
		status === "outcome_unknown"
	);
}

function toEpochMs(value: string): number {
	const epochMs = Date.parse(value);
	if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
		throw new Error("Timeline Part timestamp must be a valid non-negative ISO timestamp.");
	}
	return epochMs;
}

function serializeOptional(value: unknown): string | null {
	return value === undefined ? null : JSON.stringify(value);
}

function utf8Bytes(value: string | null): number {
	return value === null ? 0 : new TextEncoder().encode(value).byteLength;
}

function createRunBudgetTruncationPayload(payload: ToolPublicPayload): ToolPublicPayload {
	return toolPublicPayloadSchema.parse({
		format: "text",
		value: "Payload omitted because this Run reached its public Tool payload limit.",
		truncated: true,
		originalBytes: payload.originalBytes ?? utf8Bytes(JSON.stringify(payload.value)),
		redactionCount: payload.redactionCount,
	});
}

function buildPartInsert(part: ChatRunPart, sessionId: string, lastEventSeq: number): PartInsert {
	const common = {
		id: part.id,
		sessionId,
		runId: part.runId,
		position: part.position,
		assistantTurnId: part.assistantTurnId,
		status: part.status,
		revision: part.revision,
		lastEventSeq,
		createdAtMs: toEpochMs(part.createdAt),
		updatedAtMs: toEpochMs(part.updatedAt),
	};
	if (part.kind === "text") {
		return {
			...common,
			kind: "text",
			textContent: part.content,
		};
	}
	return {
		...common,
		kind: "tool",
		textContent: null,
		toolCallId: part.toolCallId,
		toolKind: part.tool.kind,
		toolName: part.tool.name,
		mcpServerId: part.tool.kind === "mcp" ? part.tool.mcpServerId : null,
		mcpToolId: part.tool.kind === "mcp" ? part.tool.stableToolId : null,
		summary: part.summary,
		inputJson: serializeOptional(part.input),
		progressJson: serializeOptional(part.progress),
		outputJson: serializeOptional(part.output),
		payloadsTruncated: part.payloadsTruncated ?? null,
		errorJson: serializeOptional(part.error),
		approvalId: part.approvalId ?? null,
		startedAtMs: part.startedAt === undefined ? null : toEpochMs(part.startedAt),
		completedAtMs: part.completedAt === undefined ? null : toEpochMs(part.completedAt),
		durationMs: part.durationMs ?? null,
	};
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

function assertRunProjectContext(
	session: { runtimeBoxId: string; projectId: string | null },
	context: ProjectRunContext | undefined,
): void {
	if (session.projectId === null) {
		if (context !== undefined) {
			throw new Error("Global Sessions cannot create Runs with Project context.");
		}
		return;
	}
	if (context === undefined) {
		throw new Error("Project Sessions require an immutable Project Run context.");
	}
	if (context.projectId !== session.projectId || context.runtimeBoxId !== session.runtimeBoxId) {
		throw new Error("Project Run context did not match the Session ownership.");
	}
}

function assertTransitionAllowed(currentStatus: ChatRunStatus, nextStatus: ChatRunStatus): void {
	if (currentStatus === nextStatus) {
		throw new Error(`Run is already ${currentStatus}.`);
	}
	if (!allowedRunTransitions[currentStatus].has(nextStatus)) {
		throw new Error(`Run status cannot transition from ${currentStatus} to ${nextStatus}.`);
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
		// Optional transactional outbox. When present, a Run's single terminal transition enqueues a
		// desensitized Mobile attention row in the SAME transaction as the status write, so a crash
		// between the two can never permanently lose the phone's unread signal.
		private readonly attentionOutbox?: MobileAttentionOutboxWriter,
	) {}

	create(input: CreateRunInput): CreateRunResult {
		const clientRequestId = requireRequestId(input.clientRequestId);
		const sessionId = uuidV7Schema.parse(input.sessionId);
		const userMessageId = uuidV7Schema.parse(input.userMessageId);
		const userContent = sendAskChatMessageInputSchema.parse({
			requestId: clientRequestId,
			sessionId,
			content: input.userContent,
		}).content;
		const provider = toSafeProviderState(input.provider);
		const projectContext =
			input.projectContext === undefined
				? undefined
				: projectRunContextSchema.parse(input.projectContext);

		return this.inTransaction(() => {
			const placement = this.getSessionPlacement(sessionId);
			assertRunProjectContext(placement, projectContext);
			if (input.rootAgentsWarning !== undefined && projectContext === undefined) {
				throw new Error("Global Sessions cannot create Project root AGENTS.md warnings.");
			}
			const runtimeBoxId = placement.runtimeBoxId;
			const nowMs = this.clock.now();
			const row: RunRow = {
				id: this.idGenerator.create(nowMs),
				clientRequestId,
				sessionId,
				runtimeBoxId,
				mode: input.mode,
				status: "queued",
				providerJson: JSON.stringify(provider),
				userMessageId,
				userContent,
				publicToolPayloadBytes: 0,
				lastErrorJson: null,
				projectId: projectContext?.projectId ?? null,
				projectPath: projectContext?.projectPath ?? null,
				projectPathRevision: projectContext?.projectPathRevision ?? null,
				projectGitRootPath: projectContext?.gitRootPath ?? null,
				projectGitBranch: projectContext?.gitBranch ?? null,
				projectRootAgentsHash: projectContext?.rootAgentsHash ?? null,
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
			const warningEvent =
				input.rootAgentsWarning === undefined
					? undefined
					: this.insertEvent({
							runId: row.id,
							sessionId,
							type: "run.warning",
							source: { kind: "system" },
							visibility: "user",
							payload: {
								code: "ROOT_AGENTS_SKIPPED",
								reason: input.rootAgentsWarning,
							},
							createdAtMs: nowMs,
						});
			this.touchSession(sessionId, nowMs, true);
			const event = buildEvent(queuedEvent);
			return {
				run: buildRun(row),
				event,
				events: [event, ...(warningEvent === undefined ? [] : [buildEvent(warningEvent)])],
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
			userMessage: buildUserMessage(row),
			timeline: this.listParts(row.id),
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

	hasNonTerminalForProject(projectId: string): boolean {
		const parsedProjectId = uuidV7Schema.parse(projectId);
		return (
			this.orm
				.select({ id: chatRunsTable.id })
				.from(chatRunsTable)
				.where(
					and(
						eq(chatRunsTable.projectId, parsedProjectId),
						inArray(chatRunsTable.status, ["queued", "running", "cancelling"]),
					),
				)
				.get() !== undefined
		);
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
		const partsByRun = new Map<string, ChatRunPart[]>();
		if (pageRows.length > 0) {
			for (const part of this.orm
				.select()
				.from(chatRunPartsTable)
				.where(
					inArray(
						chatRunPartsTable.runId,
						pageRows.map((row) => row.id),
					),
				)
				.orderBy(asc(chatRunPartsTable.runId), asc(chatRunPartsTable.position))
				.all()
				.map(buildPart)) {
				const parts = partsByRun.get(part.runId) ?? [];
				parts.push(part);
				partsByRun.set(part.runId, parts);
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
				userMessage: buildUserMessage(row),
				timeline: partsByRun.get(row.id) ?? [],
				lastEventSeq: lastSeqByRun.get(row.id) ?? 0,
			})),
			...(rows.length > input.limit && last !== undefined
				? { nextCursor: { createdAtMs: last.createdAtMs, id: last.id } }
				: {}),
		};
	}

	listParts(runId: string): ChatRunPart[] {
		return this.orm
			.select()
			.from(chatRunPartsTable)
			.where(eq(chatRunPartsTable.runId, uuidV7Schema.parse(runId)))
			.orderBy(asc(chatRunPartsTable.position))
			.all()
			.map(buildPart);
	}

	drainTimelineOutbox(limit = 1_000): ChatRunEvent[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("Run timeline outbox drain limit must be between 1 and 1000.");
		}

		return this.inTransaction(() => {
			const rows = this.orm
				.select()
				.from(runTimelineOutboxTable)
				.orderBy(asc(runTimelineOutboxTable.sequence))
				.limit(limit)
				.all();
			const events: ChatRunEvent[] = [];
			for (const row of rows) {
				const run = this.selectRun(row.runId);
				const current = this.selectToolPartByCallId(row.runId, row.toolCallId);
				const next = this.applyToolPayloadBudget(
					projectAuthoritativeToolTransition(current, row),
					current,
				);
				if (JSON.stringify(current) !== JSON.stringify(next)) {
					const eventAtMs = toEpochMs(next.updatedAt);
					const event = buildEvent(
						this.insertEvent({
							runId: run.id,
							sessionId: run.sessionId,
							type: "timeline.tool.updated",
							source: { kind: "system" },
							visibility: "user",
							payload: { part: next },
							createdAtMs: eventAtMs,
						}),
					);
					this.projectTimelineEvent(event, eventAtMs);
					this.touchSession(run.sessionId, eventAtMs, true);
					events.push(event);
				}
				this.orm
					.delete(runTimelineOutboxTable)
					.where(eq(runTimelineOutboxTable.sequence, row.sequence))
					.run();
			}
			return events;
		});
	}

	hasPendingTimelineOutbox(): boolean {
		return (
			this.orm
				.select({ sequence: runTimelineOutboxTable.sequence })
				.from(runTimelineOutboxTable)
				.get() !== undefined
		);
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
			const prepared = this.prepareTimelineEvent(input);
			const event = buildEvent(
				this.insertEvent({
					runId: row.id,
					sessionId: row.sessionId,
					type: prepared.type,
					source: prepared.source,
					visibility: prepared.visibility ?? "user",
					payload: prepared.payload,
					createdAtMs: nowMs,
				}),
			);
			this.projectTimelineEvent(event, nowMs);
			this.touchSession(row.sessionId, nowMs, input.type.startsWith("timeline."));
			return event;
		});
	}

	fail(input: FailRunInput): FailRunResult {
		const error = appErrorSchema.parse(input.error);
		const result = this.commitTerminal({
			runId: input.runId,
			status: "failed",
			error,
			...(input.source === undefined ? {} : { source: input.source }),
		});
		return { run: result.run, events: result.events };
	}

	commitTerminal(input: CommitRunTerminalInput): CommitRunTerminalOutput {
		const runId = uuidV7Schema.parse(input.runId);
		const terminalStatus = input.status;
		const terminalError =
			terminalStatus === "failed"
				? appErrorSchema.parse(input.error)
				: input.error === undefined
					? undefined
					: appErrorSchema.parse(input.error);
		if (terminalStatus === "failed" && terminalError === undefined) {
			throw new Error(`Run ${runId} failed terminal transition is missing its error.`);
		}
		if (terminalStatus !== "failed" && terminalError !== undefined) {
			throw new Error(`Run ${runId} ${terminalStatus} transition cannot include an error.`);
		}
		return this.inTransaction(() => {
			const row = this.selectRun(runId);
			if (terminalRunStatuses.has(row.status) && row.status !== terminalStatus) {
				throw new Error(
					`Run ${runId} terminal status ${row.status} conflicts with ${terminalStatus}.`,
				);
			}
			if (row.status === terminalStatus) {
				return { run: buildRun(row), events: [], committed: false };
			}

			const nowMs = this.clock.now();
			const source = input.source ?? { kind: "system" as const };
			const events: ChatRunEvent[] = [];
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
			this.orm
				.update(chatRunsTable)
				.set({
					status: terminalStatus,
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
				lastErrorJson: terminalError === undefined ? null : serializeError(terminalError),
				updatedAtMs: nowMs,
				completedAtMs: nowMs,
			};
			this.enqueueTerminalAttention(terminalStatus, runId, row.sessionId, nowMs);
			this.touchSession(row.sessionId, nowMs, true);
			return {
				run: buildRun(updatedRow),
				events,
				committed: true,
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
			const agentSessionId = this.orm
				.select({ id: chatSessionsTable.piSessionId })
				.from(chatSessionsTable)
				.where(eq(chatSessionsTable.id, parsedSessionId))
				.get()?.id;
			if (agentSessionId === undefined) {
				throw new Error("Chat session is missing its agent session mapping.");
			}
			const retainedCount =
				this.orm.select({ count: sql<number>`count(*)` }).from(retiredChatSessionsTable).get()
					?.count ?? 0;
			if (retainedCount >= maxRetiredSessionTombstones) {
				throw new SessionRetirementCapacityError("tombstones");
			}
			this.orm
				.insert(retiredChatSessionsTable)
				.values({ sessionId: parsedSessionId, retiredAtMs })
				.run();
			const agentSessionCleanupCount =
				this.orm.select({ count: sql<number>`count(*)` }).from(agentSessionCleanupOutboxTable).get()
					?.count ?? 0;
			if (agentSessionCleanupCount >= maxAgentSessionCleanupJobs) {
				throw new SessionRetirementCapacityError("cleanup_outbox");
			}
			this.orm
				.insert(agentSessionCleanupOutboxTable)
				.values({
					sessionId: agentSessionId,
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

	listRetiredSessionPage(input: ListRetiredSessionPageInput): ListRetiredSessionPageOutput {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > maxRetiredSessionsPerRecoveryPage
		) {
			throw new Error(
				`Retired Session page limit must be between 1 and ${maxRetiredSessionsPerRecoveryPage}.`,
			);
		}
		const cursor = input.cursor === undefined ? undefined : uuidV7Schema.parse(input.cursor);
		const cutoffMs = this.clock.now() - retiredSessionTombstoneTtlMs;
		const rows = this.orm
			.select({ sessionId: retiredChatSessionsTable.sessionId })
			.from(retiredChatSessionsTable)
			.where(
				and(
					gt(retiredChatSessionsTable.retiredAtMs, cutoffMs),
					cursor === undefined ? undefined : gt(retiredChatSessionsTable.sessionId, cursor),
				),
			)
			.orderBy(asc(retiredChatSessionsTable.sessionId))
			.limit(input.limit + 1)
			.all();
		const sessionIds = rows.slice(0, input.limit).map((row) => row.sessionId);
		const nextCursor = rows.length > input.limit ? sessionIds.at(-1) : undefined;
		if (rows.length > input.limit && nextCursor === undefined) {
			throw new Error("Retired Session page was unexpectedly empty.");
		}
		return {
			sessionIds,
			...(nextCursor === undefined ? {} : { nextCursor }),
		};
	}

	getReplayCursorSupport(): ReplayCursorSupport {
		const serverTimeMs = this.clock.now();
		return {
			serverTimeMs,
			oldestSupportedCursorIssuedAtMs: serverTimeMs - retiredSessionTombstoneTtlMs,
			tombstoneTtlMs: retiredSessionTombstoneTtlMs,
		};
	}

	listPendingAgentSessionCleanups(
		limit: number,
		includeDeferred = false,
	): AgentSessionCleanupJob[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxAgentSessionCleanupBatchSize) {
			throw new Error(
				`Agent session cleanup batch limit must be between 1 and ${maxAgentSessionCleanupBatchSize}.`,
			);
		}
		const nowMs = this.clock.now();
		return this.orm
			.select()
			.from(agentSessionCleanupOutboxTable)
			.where(
				includeDeferred
					? undefined
					: sql`${agentSessionCleanupOutboxTable.nextAttemptAtMs} <= ${nowMs}`,
			)
			.orderBy(
				asc(agentSessionCleanupOutboxTable.nextAttemptAtMs),
				asc(agentSessionCleanupOutboxTable.createdAtMs),
				asc(agentSessionCleanupOutboxTable.sessionId),
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

	recordAgentSessionCleanupFailure(
		sessionId: string,
		error: string,
		nextAttemptAtMs: number,
	): void {
		if (!Number.isSafeInteger(nextAttemptAtMs) || nextAttemptAtMs < 0) {
			throw new TypeError("Agent session cleanup retry time must be a non-negative safe integer.");
		}
		this.orm
			.update(agentSessionCleanupOutboxTable)
			.set({
				attemptCount: sql`${agentSessionCleanupOutboxTable.attemptCount} + 1`,
				lastAttemptAtMs: this.clock.now(),
				lastError: error.slice(0, 2_000),
				nextAttemptAtMs,
			})
			.where(eq(agentSessionCleanupOutboxTable.sessionId, uuidV7Schema.parse(sessionId)))
			.run();
	}

	ackAgentSessionCleanup(sessionId: string): void {
		this.orm
			.delete(agentSessionCleanupOutboxTable)
			.where(eq(agentSessionCleanupOutboxTable.sessionId, uuidV7Schema.parse(sessionId)))
			.run();
	}

	// Enqueue the desensitized Mobile attention outbox row for a Run's single terminal transition,
	// inside the caller's transaction so it is atomic with the status write. `buildRunTerminalAttentionInput`
	// only returns undefined for non-terminal statuses, which never reach this helper.
	private enqueueTerminalAttention(
		status: ChatRunStatus,
		runId: string,
		sessionId: string,
		nowMs: number,
	): void {
		if (this.attentionOutbox === undefined) {
			return;
		}
		const attention = buildRunTerminalAttentionInput({
			status,
			runId,
			sessionId,
			createdAtMs: nowMs,
		});
		if (attention !== undefined) {
			this.attentionOutbox.enqueue(attention);
		}
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

	private getSessionPlacement(sessionId: string): {
		runtimeBoxId: string;
		projectId: string | null;
	} {
		const row = this.orm
			.select({
				runtimeBoxId: chatSessionsTable.runtimeBoxId,
				projectId: chatSessionsTable.projectId,
			})
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.id, sessionId))
			.get();
		if (row === undefined) {
			throw new ChatSessionNotFoundError(sessionId);
		}
		return row;
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

	private prepareTimelineEvent(input: AppendRunEventInput): AppendRunEventInput {
		switch (input.type) {
			case "timeline.part.created": {
				const part = chatRunPartSchema.parse(input.payload.part);
				if (part.kind !== "tool") {
					return input;
				}
				return {
					...input,
					payload: { part: this.applyToolPayloadBudget(part) },
				};
			}
			case "timeline.tool.updated": {
				const part = chatRunToolPartSchema.parse(input.payload.part);
				const current = buildPart(this.selectPart(input.runId, part.id));
				if (current.kind !== "tool") {
					throw new Error("A ToolPart update cannot target a TextPart.");
				}
				return {
					...input,
					payload: { part: this.applyToolPayloadBudget(part, current) },
				};
			}
			case "timeline.tool.progress": {
				const current = buildPart(this.selectPart(input.runId, input.payload.partId));
				if (current.kind !== "tool") {
					throw new Error("Tool progress cannot target a TextPart.");
				}
				const next = this.applyToolPayloadBudget(
					chatRunToolPartSchema.parse({
						...current,
						progress: input.payload.progress,
						payloadsTruncated:
							current.payloadsTruncated || input.payload.payloadsTruncated || undefined,
						revision: input.payload.revision,
					}),
					current,
				);
				return {
					...input,
					payload: {
						partId: input.payload.partId,
						revision: input.payload.revision,
						...(next.progress === undefined ? {} : { progress: next.progress }),
						...(next.payloadsTruncated ? { payloadsTruncated: true } : {}),
					},
				};
			}
			default:
				return input;
		}
	}

	private applyToolPayloadBudget(
		part: ChatRunToolPart,
		current?: ChatRunToolPart,
	): ChatRunToolPart {
		const run = this.selectRun(part.runId);
		let remainingBytes = chatRunToolPayloadBudgetBytes - run.publicToolPayloadBytes;
		let reservedBytes = 0;
		let payloadsTruncated =
			(part.payloadsTruncated ?? false) || (current?.payloadsTruncated ?? false);
		const keepWithinBudget = (
			payload: ToolPublicPayload | undefined,
			currentPayload: ToolPublicPayload | undefined,
		): ToolPublicPayload | undefined => {
			if (payload === undefined) {
				return undefined;
			}
			const serialized = JSON.stringify(payload);
			const currentSerialized =
				currentPayload === undefined ? undefined : JSON.stringify(currentPayload);
			if (serialized === currentSerialized) {
				return payload;
			}
			const payloadBytes = utf8Bytes(serialized);
			if (payloadBytes <= remainingBytes) {
				remainingBytes -= payloadBytes;
				reservedBytes += payloadBytes;
				return payload;
			}
			payloadsTruncated = true;
			const marker = createRunBudgetTruncationPayload(payload);
			const serializedMarker = JSON.stringify(marker);
			if (serializedMarker === currentSerialized) {
				return currentPayload;
			}
			const markerBytes = utf8Bytes(serializedMarker);
			if (markerBytes > remainingBytes) {
				return undefined;
			}
			remainingBytes -= markerBytes;
			reservedBytes += markerBytes;
			return marker;
		};
		const input = keepWithinBudget(part.input, current?.input);
		const progress = keepWithinBudget(part.progress, current?.progress);
		const output = keepWithinBudget(part.output, current?.output);
		const limited = chatRunToolPartSchema.parse({
			...part,
			input,
			progress,
			output,
			payloadsTruncated: payloadsTruncated || undefined,
		});
		if (reservedBytes > 0) {
			this.orm
				.update(chatRunsTable)
				.set({ publicToolPayloadBytes: run.publicToolPayloadBytes + reservedBytes })
				.where(eq(chatRunsTable.id, part.runId))
				.run();
		}
		return limited;
	}

	private projectTimelineEvent(event: ChatRunEvent, nowMs: number): void {
		switch (event.type) {
			case "timeline.part.created": {
				const part = chatRunPartSchema.parse(event.payload.part);
				if (part.runId !== event.runId) {
					throw new Error("Timeline Part Run ID does not match its event.");
				}
				if (part.revision !== 1) {
					throw new Error("A newly created Timeline Part must start at revision 1.");
				}
				this.orm
					.insert(chatRunPartsTable)
					.values(buildPartInsert(part, event.sessionId, event.seq))
					.run();
				return;
			}
			case "timeline.text.delta": {
				const row = this.selectPart(event.runId, event.payload.partId);
				const current = buildPart(row);
				if (current.kind !== "text") {
					throw new Error("A text delta cannot target a ToolPart.");
				}
				if (current.status !== "streaming") {
					throw new Error("A text delta cannot target a terminal TextPart.");
				}
				this.assertNextPartRevision(current, event.payload.revision);
				const next = chatRunTextPartSchema.parse({
					...current,
					revision: event.payload.revision,
					content: current.content + event.payload.delta,
					updatedAt: toIsoDateTime(nowMs),
				});
				this.orm
					.update(chatRunPartsTable)
					.set({
						status: next.status,
						revision: next.revision,
						textContent: next.content,
						lastEventSeq: event.seq,
						updatedAtMs: nowMs,
					})
					.where(eq(chatRunPartsTable.id, row.id))
					.run();
				return;
			}
			case "timeline.text.completed": {
				const next = chatRunTextPartSchema.parse(event.payload.part);
				if (next.runId !== event.runId) {
					throw new Error("Completed TextPart Run ID does not match its event.");
				}
				if (next.status === "streaming") {
					throw new Error("A completed TextPart event cannot keep streaming status.");
				}
				const row = this.selectPart(event.runId, next.id);
				const current = buildPart(row);
				if (current.kind !== "text") {
					throw new Error("A text completion cannot target a ToolPart.");
				}
				this.assertStablePartIdentity(current, next);
				this.assertNextPartRevision(current, next.revision);
				this.orm
					.update(chatRunPartsTable)
					.set({
						status: next.status,
						revision: next.revision,
						textContent: next.content,
						lastEventSeq: event.seq,
						updatedAtMs: toEpochMs(next.updatedAt),
					})
					.where(eq(chatRunPartsTable.id, row.id))
					.run();
				return;
			}
			case "timeline.tool.updated": {
				const next = chatRunToolPartSchema.parse(event.payload.part);
				if (next.runId !== event.runId) {
					throw new Error("Updated ToolPart Run ID does not match its event.");
				}
				const row = this.selectPart(event.runId, next.id);
				const current = buildPart(row);
				if (current.kind !== "tool") {
					throw new Error("A ToolPart update cannot target a TextPart.");
				}
				this.assertStablePartIdentity(current, next);
				this.assertNextPartRevision(current, next.revision);
				this.orm
					.update(chatRunPartsTable)
					.set({
						status: next.status,
						revision: next.revision,
						summary: next.summary,
						inputJson: serializeOptional(next.input),
						progressJson: serializeOptional(next.progress),
						outputJson: serializeOptional(next.output),
						payloadsTruncated: next.payloadsTruncated ?? null,
						errorJson: serializeOptional(next.error),
						approvalId: next.approvalId ?? null,
						startedAtMs: next.startedAt === undefined ? null : toEpochMs(next.startedAt),
						completedAtMs: next.completedAt === undefined ? null : toEpochMs(next.completedAt),
						durationMs: next.durationMs ?? null,
						lastEventSeq: event.seq,
						updatedAtMs: toEpochMs(next.updatedAt),
					})
					.where(eq(chatRunPartsTable.id, row.id))
					.run();
				return;
			}
			case "timeline.tool.progress": {
				const row = this.selectPart(event.runId, event.payload.partId);
				const current = buildPart(row);
				if (current.kind !== "tool") {
					throw new Error("Tool progress cannot target a TextPart.");
				}
				this.assertNextPartRevision(current, event.payload.revision);
				this.orm
					.update(chatRunPartsTable)
					.set({
						revision: event.payload.revision,
						progressJson: serializeOptional(event.payload.progress),
						payloadsTruncated: event.payload.payloadsTruncated ?? null,
						lastEventSeq: event.seq,
						updatedAtMs: nowMs,
					})
					.where(eq(chatRunPartsTable.id, row.id))
					.run();
				return;
			}
			default:
				return;
		}
	}

	private assertNextPartRevision(current: ChatRunPart, nextRevision: number): void {
		if (nextRevision !== current.revision + 1) {
			throw new Error(
				`Timeline Part ${current.id} revision must advance from ${current.revision} to ${current.revision + 1}.`,
			);
		}
	}

	private assertStablePartIdentity(current: ChatRunPart, next: ChatRunPart): void {
		if (
			current.id !== next.id ||
			current.runId !== next.runId ||
			current.position !== next.position ||
			current.assistantTurnId !== next.assistantTurnId ||
			current.createdAt !== next.createdAt ||
			current.kind !== next.kind
		) {
			throw new Error(`Timeline Part ${current.id} attempted to change stable identity fields.`);
		}
		if (
			current.kind === "tool" &&
			next.kind === "tool" &&
			(current.toolCallId !== next.toolCallId ||
				JSON.stringify(current.tool) !== JSON.stringify(next.tool))
		) {
			throw new Error(`ToolPart ${current.id} attempted to change its Tool identity.`);
		}
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

	private selectPart(runId: string, partId: string): PartRow {
		const row = this.orm
			.select()
			.from(chatRunPartsTable)
			.where(
				and(
					eq(chatRunPartsTable.runId, uuidV7Schema.parse(runId)),
					eq(chatRunPartsTable.id, uuidV7Schema.parse(partId)),
				),
			)
			.get();
		if (row === undefined) {
			throw new Error(`Timeline Part ${partId} was not found in Run ${runId}.`);
		}
		return row;
	}

	private selectToolPartByCallId(runId: string, toolCallId: string): ChatRunToolPart {
		const row = this.orm
			.select()
			.from(chatRunPartsTable)
			.where(
				and(
					eq(chatRunPartsTable.runId, uuidV7Schema.parse(runId)),
					eq(chatRunPartsTable.toolCallId, toolCallId),
				),
			)
			.get();
		if (row === undefined) {
			throw new Error(`ToolPart ${toolCallId} was not found in Run ${runId}.`);
		}
		const part = buildPart(row);
		if (part.kind !== "tool") {
			throw new Error(`Timeline Part for Tool call ${toolCallId} is not a ToolPart.`);
		}
		return part;
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
	attentionOutbox?: MobileAttentionOutboxWriter;
}): RunJournalRepository {
	return new SqliteRunJournalRepository(
		database.client,
		database.orm,
		undefined,
		undefined,
		database.attentionOutbox,
	);
}
