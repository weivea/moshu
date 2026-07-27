import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRuntime,
	AskChatRuntimeError,
	normalizeReasoningSelection,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
	type ProviderRecord,
	type ProviderRegistry,
	type ResolvedProviderConfiguration,
	resolveModelProtocol,
	resolveReasoningCapability,
	toProviderSummary,
} from "@moshu/agent-runtime";
import {
	type AppError,
	type AvailableModel,
	appErrorSchema,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatMessage,
	type ChatRun,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	type CreateChatSessionOutput,
	type CreateProcessChatSessionInput,
	type CreateProviderInput,
	chatMessageSchema,
	chatSendAcceptedOutputSchema,
	createProviderInputSchema,
	type DefaultModelSelection,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	type DeleteProviderInput,
	type DeleteProviderOutput,
	deleteChatSessionInputSchema,
	deleteProviderInputSchema,
	deleteProviderOutputSchema,
	type FetchProviderModelsInput,
	type FetchProviderModelsOutput,
	fetchProviderModelsInputSchema,
	fetchProviderModelsOutputSchema,
	type GetChatSessionInput,
	type GetChatSessionOutput,
	type GetChatSessionPageInput,
	type GetChatSessionPageOutput,
	type GetChatSessionSnapshotOutput,
	type GetDefaultModelOutput,
	getChatSessionInputSchema,
	getChatSessionPageInputSchema,
	getChatSessionPageOutputSchema,
	getChatSessionSnapshotOutputSchema,
	getDefaultModelOutputSchema,
	type ListAvailableModelsOutput,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	type ListProvidersOutput,
	listAvailableModelsOutputSchema,
	listChatSessionsInputSchema,
	listProvidersOutputSchema,
	maxAssistantMessageContentCharacters,
	maxChatDeltaCharacters,
	maxReplayEventBytesPerPage,
	maxReplayEventsPerPage,
	normalizeAppErrorSafeMessage,
	type ProcessPeerIdentity,
	type ProviderModel,
	type ProviderMutationOutput,
	providerMutationOutputSchema,
	type ReplayChatEventsInput,
	type ReplayChatEventsOutput,
	replayChatEventsInputSchema,
	replayChatEventsOutputSchema,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	type SetChatSessionModelInput,
	type SetChatSessionModelOutput,
	type SetDefaultModelInput,
	type SetDefaultModelOutput,
	type SetProviderModelsEnabledInput,
	type SetProviderModelsEnabledOutput,
	setChatSessionArchivedInputSchema,
	setChatSessionModelInputSchema,
	setDefaultModelInputSchema,
	setDefaultModelOutputSchema,
	setProviderModelsEnabledInputSchema,
	setProviderModelsEnabledOutputSchema,
	type TestProviderInput,
	type TestProviderOutput,
	testProviderInputSchema,
	testProviderOutputSchema,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	type UpdateProviderInput,
	updateChatSessionInputSchema,
	updateProviderInputSchema,
} from "@moshu/contracts";
import {
	ChatRunNotFoundError,
	ChatSessionNotFoundError,
	createUuidV7,
	type ListRunPageOutput,
	maxCheckpointDeletionBatchSize,
	maxRunEventPageSize,
	type RunJournalPageItem,
	type RunJournalRepository,
	type RunPageCursor,
	type SessionRepository,
} from "@moshu/database";
import {
	anthropicApiVersion,
	fetchProviderModelCatalog,
	type ProviderCatalogRequest,
} from "./provider-catalog";

const STREAMED_DELTA_FLUSH_LATENCY_MS = 20;
const replayTextEncoder = new TextEncoder();

type ChatEventListener = (event: ChatRunEvent) => void | PromiseLike<void>;
type ChatTaskScheduler = (task: () => void) => void;
type ProviderConnectionTester = (configuration: ResolvedProviderConfiguration) => Promise<void>;
type ProviderModelCatalogFetcher = (
	request: ProviderCatalogRequest,
) => Promise<readonly ProviderModel[]>;

interface ChatServiceLogger {
	error(message: string, error: unknown): void;
	info?(message: string): void;
}

export interface CheckpointDeletionRetryResult {
	attempted: number;
	succeeded: number;
	failed: number;
	remaining: number;
}

type CheckpointDeletionAttemptOutcome =
	| "succeeded"
	| "failed"
	| "ineligible"
	| "retry-state-persistence-failed"
	| "stopped";

const checkpointDeletionStartupBatchSize = 64;
const defaultCheckpointDeletionRetryBaseMs = 1_000;
const defaultCheckpointDeletionRetryMaxMs = 60_000;
const defaultCheckpointDeletionAttemptTimeoutMs = 5_000;
const defaultCheckpointDeletionMaxInFlightAttempts = 4;
const defaultCheckpointDeletionStartupTimeoutMs = 2_000;
const defaultCheckpointDeletionStartupMaxAttempts = 64;
const defaultShutdownTimeoutMs = 5_000;

export interface ChatApplicationServiceOptions {
	sessions: SessionRepository;
	runs: RunJournalRepository;
	providers: ProviderRegistry;
	runtime: AskChatRuntime;
	fetchProviderModels?: ProviderModelCatalogFetcher;
	schedule?: ChatTaskScheduler;
	logger?: ChatServiceLogger;
	testProviderConnection?: ProviderConnectionTester;
	isRuntimeReady?: () => boolean;
	checkpointDeletionRetryBaseMs?: number;
	checkpointDeletionRetryMaxMs?: number;
	checkpointDeletionAttemptTimeoutMs?: number;
	checkpointDeletionMaxInFlightAttempts?: number;
	checkpointDeletionStartupTimeoutMs?: number;
	checkpointDeletionStartupMaxAttempts?: number;
	shutdownTimeoutMs?: number;
}

export interface SendChatMessageInput {
	requestId?: string;
	sessionId: string;
	content: string;
}

interface ActiveChatRun {
	runId: string;
	sessionId: string;
	assistantMessageId: string;
	provider: ResolvedProviderConfiguration;
	messages: AskChatMessage[];
	durableAssistantContent: string;
	pendingAssistantDelta: string;
	pendingDeltaFlushTimer: ReturnType<typeof setTimeout> | undefined;
	abortController: AbortController;
	cancelRequested: boolean;
	executionStarted: boolean;
	terminalCommitted: boolean;
	persistenceFailure: unknown | undefined;
	retainFence: boolean;
}

export class ChatApplicationService {
	readonly #sessions: SessionRepository;
	readonly #runs: RunJournalRepository;
	readonly #providers: ProviderRegistry;
	readonly #fetchProviderModels: ProviderModelCatalogFetcher;
	readonly #runtime: AskChatRuntime;
	readonly #schedule: ChatTaskScheduler;
	readonly #logger: ChatServiceLogger;
	readonly #testProviderConnection: ProviderConnectionTester;
	readonly #isRuntimeReady: () => boolean;
	readonly #providerId = createUuidV7();
	readonly #listeners = new Set<ChatEventListener>();
	readonly #publicationQueue: ChatRunEvent[][] = [];
	readonly #activeRuns = new Map<string, ActiveChatRun>();
	readonly #activeSessions = new Map<string, string>();
	readonly #startingSessions = new Map<string, symbol>();
	readonly #deletingSessions = new Set<string>();
	readonly #sessionDeletions = new Map<string, Promise<DeleteChatSessionOutput>>();
	readonly #executions = new Set<Promise<void>>();
	readonly #checkpointCleanupExecutions = new Set<Promise<unknown>>();
	readonly #checkpointDeletionRetryBaseMs: number;
	readonly #checkpointDeletionRetryMaxMs: number;
	readonly #checkpointDeletionAttemptTimeoutMs: number;
	readonly #checkpointDeletionMaxInFlightAttempts: number;
	readonly #checkpointDeletionStartupTimeoutMs: number;
	readonly #checkpointDeletionStartupMaxAttempts: number;
	readonly #shutdownTimeoutMs: number;
	readonly #checkpointDeletionAttempts = new Map<
		string,
		Promise<CheckpointDeletionAttemptOutcome>
	>();
	readonly #checkpointDeletionOperations = new Map<string, Promise<void>>();
	readonly #shutdownController = new AbortController();
	#checkpointRecoveryExecution: Promise<void> | undefined;
	#checkpointWorkerExecution: Promise<void> | undefined;
	#checkpointRetryWait:
		| { timer: ReturnType<typeof setTimeout>; resolve: () => void; wakeable: boolean }
		| undefined;
	#checkpointRetryStatePersistenceFailureCount = 0;
	#checkpointRetryStatePersistenceBackoffUntilMs = 0;
	#shutdownExecution: Promise<void> | undefined;
	#publishing = false;
	#shuttingDown = false;
	#dataPlaneFatal = false;

	constructor(options: ChatApplicationServiceOptions) {
		this.#sessions = options.sessions;
		this.#runs = options.runs;
		this.#providers = options.providers;
		this.#fetchProviderModels = options.fetchProviderModels ?? fetchProviderModelCatalog;
		this.#runtime = options.runtime;
		this.#schedule = options.schedule ?? ((task) => setTimeout(task, 0));
		this.#logger = options.logger ?? console;
		this.#testProviderConnection = options.testProviderConnection ?? testProviderConnection;
		this.#isRuntimeReady = options.isRuntimeReady ?? (() => true);
		this.#checkpointDeletionRetryBaseMs = requirePositiveSafeInteger(
			options.checkpointDeletionRetryBaseMs ?? defaultCheckpointDeletionRetryBaseMs,
			"checkpointDeletionRetryBaseMs",
		);
		this.#checkpointDeletionRetryMaxMs = requirePositiveSafeInteger(
			options.checkpointDeletionRetryMaxMs ?? defaultCheckpointDeletionRetryMaxMs,
			"checkpointDeletionRetryMaxMs",
		);
		if (this.#checkpointDeletionRetryMaxMs < this.#checkpointDeletionRetryBaseMs) {
			throw new TypeError(
				"checkpointDeletionRetryMaxMs must be greater than or equal to checkpointDeletionRetryBaseMs.",
			);
		}
		this.#checkpointDeletionAttemptTimeoutMs = requirePositiveSafeInteger(
			options.checkpointDeletionAttemptTimeoutMs ?? defaultCheckpointDeletionAttemptTimeoutMs,
			"checkpointDeletionAttemptTimeoutMs",
		);
		this.#checkpointDeletionMaxInFlightAttempts = requirePositiveSafeInteger(
			options.checkpointDeletionMaxInFlightAttempts ?? defaultCheckpointDeletionMaxInFlightAttempts,
			"checkpointDeletionMaxInFlightAttempts",
		);
		this.#checkpointDeletionStartupTimeoutMs = requirePositiveSafeInteger(
			options.checkpointDeletionStartupTimeoutMs ?? defaultCheckpointDeletionStartupTimeoutMs,
			"checkpointDeletionStartupTimeoutMs",
		);
		this.#checkpointDeletionStartupMaxAttempts = requirePositiveSafeInteger(
			options.checkpointDeletionStartupMaxAttempts ?? defaultCheckpointDeletionStartupMaxAttempts,
			"checkpointDeletionStartupMaxAttempts",
		);
		this.#shutdownTimeoutMs = requirePositiveSafeInteger(
			options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
			"shutdownTimeoutMs",
		);
	}

	subscribe(listener: ChatEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	listProviders(): ListProvidersOutput {
		return listProvidersOutputSchema.parse({
			schemaVersion: 1,
			providers: this.#providers.list().map(toProviderSummary),
		});
	}

	createProvider(input: CreateProviderInput): ProviderMutationOutput {
		const parsedInput = createProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		const record = this.#providers.create({
			displayName: parsedInput.displayName,
			type: parsedInput.type,
			baseUrl: parsedInput.baseUrl,
			apiKey: parsedInput.apiKey,
			...(parsedInput.customHeaders === undefined
				? {}
				: { customHeaders: parsedInput.customHeaders }),
		});

		return providerMutationOutputSchema.parse({
			schemaVersion: 1,
			provider: toProviderSummary(record),
		});
	}

	updateProvider(input: UpdateProviderInput): ProviderMutationOutput {
		const parsedInput = updateProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		const record = this.#providers.update(parsedInput);

		return providerMutationOutputSchema.parse({
			schemaVersion: 1,
			provider: toProviderSummary(record),
		});
	}

	deleteProvider(input: DeleteProviderInput): DeleteProviderOutput {
		const parsedInput = deleteProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		this.#providers.delete(parsedInput.providerId);

		return deleteProviderOutputSchema.parse({
			schemaVersion: 1,
			providerId: parsedInput.providerId,
		});
	}

	async testProvider(input: TestProviderInput): Promise<TestProviderOutput> {
		this.#assertDataPlaneAvailable();
		const startedAt = Date.now();

		try {
			await this.#testProviderConnection(this.#resolveTestConfiguration(input));
			return testProviderOutputSchema.parse({
				schemaVersion: 1,
				ok: true,
				latencyMs: Date.now() - startedAt,
			});
		} catch (error) {
			return testProviderOutputSchema.parse({
				schemaVersion: 1,
				ok: false,
				latencyMs: Date.now() - startedAt,
				error: toAppError(error, "provider-connection-test"),
			});
		}
	}

	async fetchProviderModels(input: FetchProviderModelsInput): Promise<FetchProviderModelsOutput> {
		const parsedInput = fetchProviderModelsInputSchema.parse(input);
		this.#assertDataPlaneAvailable();
		const record = this.#requireProvider(parsedInput.providerId);
		const models = await this.#fetchProviderModels({
			type: record.type,
			baseUrl: record.baseUrl,
			apiKey: record.apiKey,
			...(record.customHeaders === undefined ? {} : { customHeaders: record.customHeaders }),
		});
		const updated = this.#providers.setModels(
			record.id,
			models.map((model) => ({ ...model })),
			new Date().toISOString(),
		);

		return fetchProviderModelsOutputSchema.parse({
			schemaVersion: 1,
			provider: toProviderSummary(updated),
		});
	}

	setProviderModelsEnabled(input: SetProviderModelsEnabledInput): SetProviderModelsEnabledOutput {
		const parsedInput = setProviderModelsEnabledInputSchema.parse(input);
		this.#assertDataPlaneAvailable();
		const updated = this.#providers.setModelsEnabled(
			parsedInput.providerId,
			parsedInput.enabledModelIds,
		);

		return setProviderModelsEnabledOutputSchema.parse({
			schemaVersion: 1,
			provider: toProviderSummary(updated),
		});
	}

	listAvailableModels(): ListAvailableModelsOutput {
		const models: AvailableModel[] = [];
		for (const record of this.#providers.list()) {
			if (!record.enabled) {
				continue;
			}
			for (const model of record.models) {
				if (!model.enabled) {
					continue;
				}
				models.push({
					providerId: record.id,
					providerDisplayName: record.displayName,
					providerType: record.type,
					model: { ...model },
					reasoning: resolveReasoningCapability(record.type, model),
				});
			}
		}
		const defaultModel = this.#providers.getDefaultModel();

		return listAvailableModelsOutputSchema.parse({
			schemaVersion: 1,
			models,
			...(defaultModel === null ? {} : { defaultModel }),
		});
	}

	getDefaultModel(): GetDefaultModelOutput {
		const defaultModel = this.#providers.getDefaultModel();
		return getDefaultModelOutputSchema.parse({
			schemaVersion: 1,
			...(defaultModel === null ? {} : { defaultModel }),
		});
	}

	setDefaultModel(input: SetDefaultModelInput): SetDefaultModelOutput {
		const parsedInput = setDefaultModelInputSchema.parse(input);
		this.#assertDataPlaneAvailable();
		const selection =
			parsedInput.defaultModel === null ? null : this.#normalizeSelection(parsedInput.defaultModel);
		const stored = this.#providers.setDefaultModel(selection);

		return setDefaultModelOutputSchema.parse({
			schemaVersion: 1,
			...(stored === null ? {} : { defaultModel: stored }),
		});
	}

	setSessionModel(input: SetChatSessionModelInput): SetChatSessionModelOutput {
		const parsedInput = setChatSessionModelInputSchema.parse(input);
		this.#assertDataPlaneAvailable();
		if (parsedInput.model !== null) {
			this.#requireProviderModel(parsedInput.model.providerId, parsedInput.model.modelId);
		}

		return this.#sessions.setModel({
			sessionId: parsedInput.sessionId,
			model: parsedInput.model === null ? null : this.#normalizeSelection(parsedInput.model),
		});
	}

	createSession(): CreateChatSessionOutput {
		this.#assertDataPlaneAvailable();
		return this.#sessions.create({
			title: "New chat",
			defaultMode: "ask",
		});
	}

	createSessionIdempotently(
		request: CreateProcessChatSessionInput,
		origin: ProcessPeerIdentity,
	): CreateChatSessionOutput {
		this.#assertDataPlaneAvailable();
		return this.#sessions.createIdempotently({ request, origin });
	}

	listSessions(input: ListChatSessionsInput = {}): ListChatSessionsOutput {
		this.#assertDataPlaneAvailable();
		return this.#sessions.list(listChatSessionsInputSchema.parse(input));
	}

	updateSession(input: UpdateChatSessionInput): UpdateChatSessionOutput {
		this.#assertDataPlaneAvailable();
		const parsedInput = updateChatSessionInputSchema.parse(input);
		this.#assertSessionNotDeleting(parsedInput.sessionId);
		return this.#sessions.update(parsedInput);
	}

	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		this.#assertDataPlaneAvailable();
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		this.#assertSessionNotDeleting(parsedInput.sessionId);
		if (parsedInput.archived) {
			this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		}
		return this.#sessions.setArchived(parsedInput);
	}

	deleteSession(input: DeleteChatSessionInput): Promise<DeleteChatSessionOutput> {
		this.#assertDataPlaneAvailable();
		const parsedInput = deleteChatSessionInputSchema.parse(input);
		const existing = this.#sessionDeletions.get(parsedInput.sessionId);
		if (existing !== undefined) {
			return existing;
		}
		if (this.#runs.isSessionRetired(parsedInput.sessionId)) {
			return Promise.resolve({ sessionId: parsedInput.sessionId });
		}
		this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		this.#deletingSessions.add(parsedInput.sessionId);
		let deleted: { sessionId: string };
		try {
			deleted = this.#runs.deleteSessionAndRetireRuns(parsedInput.sessionId);
		} catch (error) {
			this.#deletingSessions.delete(parsedInput.sessionId);
			throw error;
		}
		const result = Promise.resolve({ sessionId: deleted.sessionId });
		this.#sessionDeletions.set(parsedInput.sessionId, result);
		const cleanup = this.#attemptCheckpointDeletion(parsedInput.sessionId, 0);
		this.#checkpointCleanupExecutions.add(cleanup);
		const finishCleanup = (): void => {
			this.#checkpointCleanupExecutions.delete(cleanup);
			this.#deletingSessions.delete(parsedInput.sessionId);
			if (this.#sessionDeletions.get(parsedInput.sessionId) === result) {
				this.#sessionDeletions.delete(parsedInput.sessionId);
			}
			this.#ensureCheckpointDeletionWorker();
		};
		void cleanup.then(finishCleanup, finishCleanup);
		return result;
	}

	async getSession(input: GetChatSessionInput): Promise<GetChatSessionOutput> {
		this.#assertDataPlaneAvailable();
		const parsedInput = getChatSessionInputSchema.parse(input);
		this.#assertSessionNotDeleting(parsedInput.sessionId);
		const session = this.#sessions.get(parsedInput);
		const items = this.#readAllRunItems(parsedInput.sessionId);
		return {
			session,
			messages: this.#buildJournalMessages(items),
			runs: items.map((item) => item.run).reverse(),
		};
	}

	async getSessionSnapshot(input: GetChatSessionInput): Promise<GetChatSessionSnapshotOutput> {
		this.#assertDataPlaneAvailable();
		const parsedInput = getChatSessionInputSchema.parse(input);
		const session = this.#sessions.get(parsedInput);
		const items = this.#readAllRunItems(parsedInput.sessionId);
		return getChatSessionSnapshotOutputSchema.parse({
			session,
			messages: this.#buildJournalMessages(items),
			runs: items.map((item) => item.run).reverse(),
			eventCursors: items.map((item) => ({
				runId: item.run.id,
				lastSeq: item.lastEventSeq,
			})),
		});
	}

	async getSessionPage(input: GetChatSessionPageInput): Promise<GetChatSessionPageOutput> {
		this.#assertDataPlaneAvailable();
		const parsedInput = getChatSessionPageInputSchema.parse(input);
		this.#assertSessionNotDeleting(parsedInput.sessionId);
		const session = this.#sessions.get({ sessionId: parsedInput.sessionId });
		const page = this.#readRunPage({
			sessionId: parsedInput.sessionId,
			...(parsedInput.cursor === undefined
				? {}
				: { after: decodeRunPageCursor(parsedInput.cursor) }),
			limit: parsedInput.limit,
		});
		return getChatSessionPageOutputSchema.parse({
			session,
			messages: this.#buildJournalMessages(page.items),
			runs: page.items.map((item) => item.run),
			eventCursors: page.items.map((item) => ({
				runId: item.run.id,
				lastSeq: item.lastEventSeq,
			})),
			...(page.nextCursor === undefined
				? {}
				: { nextCursor: encodeRunPageCursor(page.nextCursor) }),
		});
	}

	sendMessage(input: SendChatMessageInput): ChatSendAcceptedOutput {
		this.#assertDataPlaneAvailable();
		this.#assertSessionNotDeleting(input.sessionId);
		const clientRequestId = input.requestId ?? crypto.randomUUID();
		const existing = this.#runs.getByClientRequestId(clientRequestId);
		if (existing !== undefined) {
			if (existing.run.sessionId !== input.sessionId || existing.userContent !== input.content) {
				throw new AskChatRuntimeError({
					kind: "duplicate_run_id",
					message: "Chat send request ID was already used for different content.",
					retryable: false,
				});
			}
			let reservation: symbol | undefined;
			try {
				if (isNonTerminalRun(existing.run) && !this.#activeRuns.has(existing.run.id)) {
					reservation = this.#reserveSessionStart(input.sessionId);
					this.#finalizeOrphanedRun(existing.run);
				}
				const restored =
					this.#runs.getByClientRequestId(clientRequestId) ??
					fail(`Run for request ${clientRequestId} disappeared during recovery.`);
				const chronologicalRuns = this.#runs.listBySession(input.sessionId).reverse();
				const runIndex = chronologicalRuns.findIndex((run) => run.id === restored.run.id);
				const sequence = Math.max(0, runIndex) * 2 + 1;
				const assistantMessage =
					this.#buildJournalMessages([restored]).find((message) => message.role === "assistant") ??
					fail(`Run ${restored.run.id} has no assistant projection.`);
				return chatSendAcceptedOutputSchema.parse({
					run: restored.run,
					userMessage: createUserMessage(restored.run, restored.userContent, sequence),
					assistantMessage: { ...assistantMessage, sequence: sequence + 1 },
				});
			} finally {
				if (reservation !== undefined) {
					this.#releaseSessionStart(input.sessionId, reservation);
				}
			}
		}
		this.#assertRuntimeReady();
		const provider = this.#resolveSessionProvider(input.sessionId);

		const reservation = this.#reserveSessionStart(input.sessionId);
		let convertedReservation = false;
		try {
			const currentSession = this.#sessions.get({ sessionId: input.sessionId });
			const existingRuns = this.#runs.listBySession(input.sessionId);
			for (const run of existingRuns) {
				if (isNonTerminalRun(run) && !this.#activeRuns.has(run.id)) {
					this.#finalizeOrphanedRun(run);
				}
			}
			if (currentSession.archivedAt !== undefined) {
				throw new AskChatRuntimeError({
					kind: "provider_failure",
					message: "Archived chat Sessions cannot send new messages.",
					retryable: false,
				});
			}
			if (existingRuns.length === 0 && currentSession.title === "New chat") {
				this.#sessions.update({
					sessionId: input.sessionId,
					title: createSessionTitle(input.content),
				});
			}

			this.#revalidateSessionStart(input.sessionId, reservation);
			const userMessageId = createUuidV7();
			const assistantMessageId = createUuidV7();
			const created = this.#runs.create({
				clientRequestId,
				sessionId: input.sessionId,
				mode: "ask",
				provider: {
					schemaVersion: 1,
					providerId: provider.providerId,
					name: provider.providerName,
					type: provider.type,
					baseUrl: provider.baseUrl,
					model: provider.model,
					apiKey: provider.apiKey,
					...(provider.customHeaders === undefined
						? {}
						: { customHeaders: provider.customHeaders }),
					...(provider.reasoning?.effort === undefined
						? {}
						: { reasoningEffort: provider.reasoning.effort }),
					...(provider.reasoning?.budgetTokens === undefined
						? {}
						: { reasoningBudgetTokens: provider.reasoning.budgetTokens }),
				},
				userMessageId,
				userContent: input.content,
				assistantMessageId,
			});
			const activeRun: ActiveChatRun = {
				runId: created.run.id,
				sessionId: input.sessionId,
				assistantMessageId,
				messages: [{ role: "user", content: input.content, id: userMessageId }],
				durableAssistantContent: "",
				pendingAssistantDelta: "",
				pendingDeltaFlushTimer: undefined,
				provider,
				abortController: new AbortController(),
				cancelRequested: false,
				executionStarted: false,
				terminalCommitted: false,
				persistenceFailure: undefined,
				retainFence: false,
			};

			this.#activeRuns.set(activeRun.runId, activeRun);
			this.#activeSessions.set(activeRun.sessionId, activeRun.runId);
			this.#startingSessions.delete(activeRun.sessionId);
			convertedReservation = true;
			this.#publish(created.events);
			this.#schedule(() => {
				if (this.#activeRuns.get(activeRun.runId) !== activeRun) {
					return;
				}

				activeRun.executionStarted = true;
				const execution = this.#executeRun(activeRun);
				this.#executions.add(execution);
				void execution
					.catch((error: unknown) => {
						this.#logger.error(
							`Chat run ${activeRun.runId} failed outside its recovery path.`,
							error,
						);
					})
					.finally(() => {
						this.#executions.delete(execution);
					});
			});

			const sequence = existingRuns.length * 2 + 1;
			return chatSendAcceptedOutputSchema.parse({
				run: created.run,
				userMessage: createUserMessage(created.run, input.content, sequence),
				assistantMessage: createAssistantMessage(created.run, "streaming", "", sequence + 1),
			});
		} finally {
			if (!convertedReservation) {
				this.#releaseSessionStart(input.sessionId, reservation);
			}
		}
	}

	cancel(input: CancelChatRunInput): CancelChatRunOutput {
		this.#assertDataPlaneAvailable();
		const activeRun = this.#activeRuns.get(input.runId);
		const run = this.#runs.get(input.runId);
		if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
			return { run };
		}
		const reservation =
			activeRun === undefined ? this.#reserveSessionStart(run.sessionId) : undefined;
		try {
			if (activeRun !== undefined) {
				activeRun.cancelRequested = true;
				activeRun.abortController.abort(new AskChatCancelledError(input.runId, input.reason));
				this.#runtime.cancel(input.runId, input.reason);
				try {
					this.#flushPendingAssistantDelta(activeRun);
				} catch (error) {
					this.#handleFailedRun(activeRun, error);
					if (activeRun.terminalCommitted) {
						return { run: this.#runs.get(activeRun.runId) };
					}
					this.#assertDataPlaneAvailable();
				}
			}
			const partial =
				activeRun === undefined
					? this.#readPartialAssistantContent(run.id)
					: { content: activeRun.durableAssistantContent, exceeded: false };
			const outputLimitError = partial.exceeded ? createOutputLimitAppError(run.id) : undefined;
			let terminal: ReturnType<RunJournalRepository["commitTerminal"]>;
			try {
				terminal = this.#runs.commitTerminal({
					runId: run.id,
					message:
						outputLimitError === undefined
							? {
									messageId:
										run.assistantMessageId ??
										fail(`Run ${run.id} is missing its assistant message ID.`),
									status: "cancelled",
									content: partial.content,
								}
							: {
									messageId:
										run.assistantMessageId ??
										fail(`Run ${run.id} is missing its assistant message ID.`),
									status: "failed",
									content: partial.content,
									error: outputLimitError,
								},
					source: { kind: "user" },
				});
			} catch (error) {
				if (activeRun !== undefined) {
					this.#markDataPlaneFatal(activeRun, error);
				} else {
					this.#markDataPlanePersistenceFatal(run.id);
				}
				throw this.#createDataPlaneUnavailableError();
			}
			if (activeRun !== undefined) {
				activeRun.terminalCommitted = true;
			}
			this.#publish(terminal.events);
			if (activeRun !== undefined && !activeRun.executionStarted) {
				this.#releaseRun(activeRun);
			}
			return { run: terminal.run };
		} finally {
			if (reservation !== undefined) {
				this.#releaseSessionStart(run.sessionId, reservation);
			}
		}
	}

	replayEvents(input: ReplayChatEventsInput): ReplayChatEventsOutput {
		this.#assertDataPlaneAvailable();
		const parsedInput = replayChatEventsInputSchema.parse(input);
		const events: ChatRunEvent[] = [];
		const retiredSessionIds: string[] = [];
		const resnapshotSessionIds: string[] = [];
		let hasMore = false;
		const cursorSupport = this.#runs.getReplayCursorSupport();
		for (const cursor of parsedInput.cursors) {
			let run: ChatRun;
			try {
				run = this.#runs.get(cursor.runId);
			} catch (error) {
				if (!(error instanceof ChatRunNotFoundError)) {
					throw error;
				}
				if (this.#runs.isSessionRetired(cursor.sessionId)) {
					retiredSessionIds.push(cursor.sessionId);
					continue;
				}
				if (cursor.issuedAtMs <= cursorSupport.oldestSupportedCursorIssuedAtMs) {
					try {
						this.#sessions.get({ sessionId: cursor.sessionId });
					} catch (sessionError) {
						if (sessionError instanceof ChatSessionNotFoundError) {
							resnapshotSessionIds.push(cursor.sessionId);
							continue;
						}
						throw sessionError;
					}
				}
				throw error;
			}
			if (run.sessionId !== cursor.sessionId) {
				throw new Error(`Run ${run.id} does not belong to Session ${cursor.sessionId}.`);
			}
			if (isNonTerminalRun(run) && !this.#activeRuns.has(run.id)) {
				this.#finalizeOrphanedRun(run, false);
			}
			const page = this.#runs.listEventPage({
				runId: run.id,
				afterSeq: cursor.lastSeq,
				limit: maxReplayEventsPerPage,
			});
			const boundedEvents = takeReplayEventsWithinByteBudget(page.events);
			events.push(...boundedEvents);
			hasMore ||= page.hasMore || boundedEvents.length < page.events.length;
		}
		return replayChatEventsOutputSchema.parse({
			events,
			retiredSessionIds,
			resnapshotSessionIds,
			cursorSupport: { schemaVersion: 1, ...cursorSupport },
			hasMore,
		});
	}

	async retryPendingCheckpointDeletions(
		options: { limit?: number; includeDeferred?: boolean } = {},
	): Promise<CheckpointDeletionRetryResult> {
		const limit = options.limit ?? checkpointDeletionStartupBatchSize;
		const jobs = this.#listEligibleCheckpointDeletionJobs(limit, options.includeDeferred ?? false);
		let succeeded = 0;
		let failed = 0;
		for (const job of jobs) {
			if (this.#shuttingDown) {
				break;
			}
			const outcome = await this.#attemptCheckpointDeletion(job.sessionId, job.attemptCount);
			if (outcome === "succeeded") {
				succeeded += 1;
			} else if (outcome !== "ineligible") {
				failed += 1;
			}
			if (outcome === "retry-state-persistence-failed" || outcome === "stopped") {
				break;
			}
		}
		const remaining = this.#runs.listPendingCheckpointDeletions(
			checkpointDeletionStartupBatchSize,
			true,
		).length;
		const result = { attempted: succeeded + failed, succeeded, failed, remaining };
		if (remaining > 0) {
			this.#ensureCheckpointDeletionWorker();
		}
		this.#logger.info?.(
			`Checkpoint deletion recovery attempted ${result.attempted} job(s): ${succeeded} succeeded, ${failed} failed, at least ${remaining} remain.`,
		);
		return result;
	}

	drainPendingCheckpointDeletions(options: { batchSize?: number } = {}): Promise<void> {
		if (this.#checkpointRecoveryExecution !== undefined) {
			return this.#checkpointRecoveryExecution;
		}
		const batchSize = options.batchSize ?? checkpointDeletionStartupBatchSize;
		const execution = this.#runInitialCheckpointDeletionSweep(batchSize);
		this.#checkpointRecoveryExecution = execution;
		this.#checkpointCleanupExecutions.add(execution);
		const cleanup = (): void => {
			if (this.#checkpointRecoveryExecution === execution) {
				this.#checkpointRecoveryExecution = undefined;
			}
			this.#checkpointCleanupExecutions.delete(execution);
		};
		void execution.then(cleanup, cleanup);
		return execution;
	}

	getClientRequestId(runId: string): string {
		return this.#runs.getClientRequestId(runId);
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.#executions]);
	}

	shutdown(): Promise<void> {
		if (this.#shutdownExecution !== undefined) {
			return this.#shutdownExecution;
		}
		const execution = this.#performShutdown();
		this.#shutdownExecution = execution;
		return execution;
	}

	async #performShutdown(): Promise<void> {
		this.#shuttingDown = true;
		this.#shutdownController.abort();
		this.#wakeCheckpointRetry(true);
		for (const runId of [...this.#activeRuns.keys()]) {
			try {
				this.cancel({
					runId,
					reason: "Application shutdown.",
				});
			} catch (error) {
				this.#logger.error(`Failed to request cancellation for chat run ${runId}.`, error);
			}
		}

		const checkpointCleanup = Promise.allSettled([...this.#checkpointCleanupExecutions]);
		const runtimeShutdown = Promise.resolve().then(() => this.#runtime.shutdown());
		const shutdown = Promise.allSettled([checkpointCleanup, runtimeShutdown]).then((results) => {
			const runtimeResult = results[1];
			if (runtimeResult?.status === "rejected") {
				this.#logger.error("Chat runtime shutdown failed.", runtimeResult.reason);
			}
		});
		if (!(await settlesWithin(shutdown, this.#shutdownTimeoutMs))) {
			this.#logger.error(
				"Chat runtime shutdown exceeded its bounded deadline.",
				new Error("Chat runtime shutdown deadline exceeded."),
			);
		}
	}

	async #runInitialCheckpointDeletionSweep(batchSize: number): Promise<void> {
		const jobs = this.#listEligibleCheckpointDeletionJobs(batchSize, true).slice(
			0,
			this.#checkpointDeletionStartupMaxAttempts,
		);
		const deadline = Date.now() + this.#checkpointDeletionStartupTimeoutMs;
		for (const job of jobs) {
			if (this.#shuttingDown) {
				return;
			}
			const attempt = this.#getOrStartCheckpointDeletion(job.sessionId, job.attemptCount);
			const outcome = await this.#waitForCheckpointAttempt(attempt, deadline);
			if (
				outcome === undefined ||
				outcome === "retry-state-persistence-failed" ||
				outcome === "stopped"
			) {
				break;
			}
		}
		this.#ensureCheckpointDeletionWorker();
	}

	async #attemptCheckpointDeletion(
		sessionId: string,
		attemptCount: number,
	): Promise<CheckpointDeletionAttemptOutcome> {
		return this.#getOrStartCheckpointDeletion(sessionId, attemptCount);
	}

	#getOrStartCheckpointDeletion(
		sessionId: string,
		attemptCount: number,
	): Promise<CheckpointDeletionAttemptOutcome> {
		const existing = this.#checkpointDeletionAttempts.get(sessionId);
		if (existing !== undefined) {
			return existing;
		}
		if (this.#checkpointDeletionOperations.has(sessionId)) {
			return Promise.resolve("ineligible");
		}
		const execution = this.#performCheckpointDeletion(sessionId, attemptCount);
		this.#checkpointDeletionAttempts.set(sessionId, execution);
		const cleanup = (): void => {
			if (this.#checkpointDeletionAttempts.get(sessionId) === execution) {
				this.#checkpointDeletionAttempts.delete(sessionId);
			}
			this.#wakeCheckpointRetry();
		};
		void execution.then(cleanup, cleanup);
		return execution;
	}

	async #performCheckpointDeletion(
		sessionId: string,
		attemptCount: number,
	): Promise<CheckpointDeletionAttemptOutcome> {
		if (this.#checkpointDeletionOperations.has(sessionId)) {
			return "ineligible";
		}
		if (this.#checkpointDeletionOperations.size >= this.#checkpointDeletionMaxInFlightAttempts) {
			return this.#recordCheckpointDeletionFailure(
				sessionId,
				attemptCount,
				new Error("Checkpoint deletion attempt capacity is temporarily exhausted."),
			);
		}

		const controller = new AbortController();
		let operation: Promise<void>;
		try {
			operation = Promise.resolve(this.#runtime.deleteThread(sessionId, controller.signal));
		} catch (error) {
			operation = Promise.reject(error);
		}
		this.#checkpointDeletionOperations.set(sessionId, operation);
		const releaseOperation = (): void => {
			if (this.#checkpointDeletionOperations.get(sessionId) === operation) {
				this.#checkpointDeletionOperations.delete(sessionId);
			}
			this.#wakeCheckpointRetry();
		};
		void operation.then(releaseOperation, releaseOperation);

		try {
			await this.#waitForCheckpointDeletionOperation(operation, controller);
			if (this.#shuttingDown) {
				return "stopped";
			}
			this.#runs.ackCheckpointDeletion(sessionId);
			this.#clearCheckpointRetryStatePersistenceBackoff();
			return "succeeded";
		} catch (error) {
			if (this.#shuttingDown || error instanceof CheckpointDeletionShutdownError) {
				return "stopped";
			}
			return this.#recordCheckpointDeletionFailure(sessionId, attemptCount, error);
		}
	}

	#waitForCheckpointDeletionOperation(
		operation: Promise<void>,
		controller: AbortController,
	): Promise<void> {
		if (this.#shuttingDown) {
			controller.abort(new CheckpointDeletionShutdownError());
			return Promise.reject(new CheckpointDeletionShutdownError());
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: unknown): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				this.#shutdownController.signal.removeEventListener("abort", onShutdown);
				if (error === undefined) {
					resolve();
				} else {
					reject(error);
				}
			};
			const onShutdown = (): void => {
				const error = new CheckpointDeletionShutdownError();
				controller.abort(error);
				finish(error);
			};
			const timer = setTimeout(() => {
				const error = new Error(
					`Checkpoint deletion attempt exceeded ${this.#checkpointDeletionAttemptTimeoutMs}ms.`,
				);
				controller.abort(error);
				finish(error);
			}, this.#checkpointDeletionAttemptTimeoutMs);
			this.#shutdownController.signal.addEventListener("abort", onShutdown, { once: true });
			void operation.then(
				() => finish(),
				(error: unknown) => finish(error),
			);
			if (this.#shutdownController.signal.aborted) {
				onShutdown();
			}
		});
	}

	#recordCheckpointDeletionFailure(
		sessionId: string,
		attemptCount: number,
		error: unknown,
	): Exclude<CheckpointDeletionAttemptOutcome, "succeeded"> {
		if (this.#shuttingDown) {
			return "stopped";
		}
		const backoffMs = Math.min(
			this.#checkpointDeletionRetryMaxMs,
			this.#checkpointDeletionRetryBaseMs * 2 ** Math.min(attemptCount, 16),
		);
		try {
			const nowMs = this.#runs.getReplayCursorSupport().serverTimeMs;
			this.#runs.recordCheckpointDeletionFailure(
				sessionId,
				error instanceof Error ? error.message : String(error),
				nowMs + backoffMs,
			);
			this.#clearCheckpointRetryStatePersistenceBackoff();
		} catch (recordError) {
			const persistenceBackoffMs = this.#setCheckpointRetryStatePersistenceBackoff();
			this.#logger.error(
				`Failed to record checkpoint cleanup retry for deleted Session ${sessionId}; pausing cleanup retries for ${persistenceBackoffMs}ms.`,
				recordError,
			);
			return "retry-state-persistence-failed";
		}
		this.#logger.error(`Checkpoint cleanup failed for deleted Session ${sessionId}.`, error);
		return "failed";
	}

	#setCheckpointRetryStatePersistenceBackoff(): number {
		this.#checkpointRetryStatePersistenceFailureCount += 1;
		const backoffMs = Math.min(
			this.#checkpointDeletionRetryMaxMs,
			this.#checkpointDeletionRetryBaseMs *
				2 ** Math.min(this.#checkpointRetryStatePersistenceFailureCount - 1, 16),
		);
		this.#checkpointRetryStatePersistenceBackoffUntilMs = Math.max(
			this.#checkpointRetryStatePersistenceBackoffUntilMs,
			Date.now() + backoffMs,
		);
		return backoffMs;
	}

	#clearCheckpointRetryStatePersistenceBackoff(): void {
		if (
			this.#checkpointRetryStatePersistenceFailureCount === 0 &&
			this.#checkpointRetryStatePersistenceBackoffUntilMs === 0
		) {
			return;
		}
		this.#checkpointRetryStatePersistenceFailureCount = 0;
		this.#checkpointRetryStatePersistenceBackoffUntilMs = 0;
		this.#wakeCheckpointRetry(true);
	}

	#ensureCheckpointDeletionWorker(): void {
		if (this.#shuttingDown || this.#checkpointWorkerExecution !== undefined) {
			return;
		}
		if (
			this.#checkpointRetryStatePersistenceBackoffUntilMs <= Date.now() &&
			this.#runs.listPendingCheckpointDeletions(1, true).length === 0
		) {
			return;
		}
		const execution = this.#runCheckpointDeletionWorker();
		this.#checkpointWorkerExecution = execution;
		this.#checkpointCleanupExecutions.add(execution);
		const cleanup = (): void => {
			if (this.#checkpointWorkerExecution === execution) {
				this.#checkpointWorkerExecution = undefined;
			}
			this.#checkpointCleanupExecutions.delete(execution);
		};
		void execution.then(cleanup, cleanup);
	}

	async #runCheckpointDeletionWorker(): Promise<void> {
		while (!this.#shuttingDown) {
			await this.#waitForCheckpointRetryStatePersistenceBackoff();
			if (this.#shuttingDown) {
				return;
			}
			const dueJobs = this.#runs.listPendingCheckpointDeletions(
				checkpointDeletionStartupBatchSize,
				false,
			);
			const jobs = dueJobs.filter(
				(job) =>
					!this.#checkpointDeletionOperations.has(job.sessionId) &&
					!this.#checkpointDeletionAttempts.has(job.sessionId),
			);
			if (jobs.length > 0) {
				for (const job of jobs) {
					if (this.#shuttingDown) {
						return;
					}
					const attempt = this.#getOrStartCheckpointDeletion(job.sessionId, job.attemptCount);
					const outcome = await this.#waitForCheckpointAttempt(attempt);
					if (outcome === undefined || outcome === "stopped") {
						return;
					}
					if (outcome === "retry-state-persistence-failed") {
						break;
					}
				}
				continue;
			}
			if (dueJobs.length > 0) {
				await this.#waitForCheckpointRetry(this.#checkpointDeletionRetryMaxMs);
				continue;
			}
			const next = this.#runs.listPendingCheckpointDeletions(1, true)[0];
			if (next === undefined) {
				return;
			}
			const nowMs = this.#runs.getReplayCursorSupport().serverTimeMs;
			await this.#waitForCheckpointRetry(Math.max(1, next.nextAttemptAtMs - nowMs));
		}
	}

	#listEligibleCheckpointDeletionJobs(
		limit: number,
		includeDeferred: boolean,
	): ReturnType<RunJournalRepository["listPendingCheckpointDeletions"]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxCheckpointDeletionBatchSize) {
			throw new Error(
				`Checkpoint deletion batch limit must be between 1 and ${maxCheckpointDeletionBatchSize}.`,
			);
		}
		return this.#runs
			.listPendingCheckpointDeletions(maxCheckpointDeletionBatchSize, includeDeferred)
			.filter(
				(job) =>
					!this.#checkpointDeletionOperations.has(job.sessionId) &&
					!this.#checkpointDeletionAttempts.has(job.sessionId),
			)
			.slice(0, limit);
	}

	async #waitForCheckpointRetryStatePersistenceBackoff(): Promise<void> {
		while (!this.#shuttingDown) {
			const delayMs = this.#checkpointRetryStatePersistenceBackoffUntilMs - Date.now();
			if (delayMs <= 0) {
				return;
			}
			await this.#waitForCheckpointRetry(delayMs, false);
		}
	}

	#waitForCheckpointAttempt(
		execution: Promise<CheckpointDeletionAttemptOutcome>,
		deadline?: number,
	): Promise<CheckpointDeletionAttemptOutcome | undefined> {
		if (this.#shuttingDown) {
			return Promise.resolve(undefined);
		}
		const timeoutMs =
			deadline === undefined
				? undefined
				: Math.max(0, Math.min(2_147_483_647, deadline - Date.now()));
		if (timeoutMs === 0) {
			return Promise.resolve(undefined);
		}
		return new Promise<CheckpointDeletionAttemptOutcome | undefined>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: CheckpointDeletionAttemptOutcome | undefined): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				this.#shutdownController.signal.removeEventListener("abort", onShutdown);
				resolve(outcome);
			};
			const onShutdown = (): void => finish(undefined);
			this.#shutdownController.signal.addEventListener("abort", onShutdown, { once: true });
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => finish(undefined), timeoutMs);
			}
			void execution.then(
				(outcome) => finish(outcome),
				() => finish(undefined),
			);
		});
	}

	#waitForCheckpointRetry(delayMs: number, wakeable = true): Promise<void> {
		if (this.#shuttingDown) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const finish = (): void => {
				if (this.#checkpointRetryWait?.resolve === finish) {
					this.#checkpointRetryWait = undefined;
				}
				resolve();
			};
			const timer = setTimeout(finish, Math.min(delayMs, 2_147_483_647));
			this.#checkpointRetryWait = { timer, resolve: finish, wakeable };
		});
	}

	#wakeCheckpointRetry(force = false): void {
		const wait = this.#checkpointRetryWait;
		if (wait === undefined || (!force && !wait.wakeable)) {
			return;
		}
		clearTimeout(wait.timer);
		wait.resolve();
	}

	async #executeRun(activeRun: ActiveChatRun): Promise<void> {
		try {
			this.#assertRuntimeReady();
			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			const running = this.#runs.updateStatus({
				runId: activeRun.runId,
				status: "running",
			});
			this.#publish([running.event]);
			if (activeRun.terminalCommitted) {
				return;
			}
			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			const result = await this.#runtime.run({
				runId: activeRun.runId,
				threadId: activeRun.sessionId,
				provider: activeRun.provider,
				messages: activeRun.messages,
				signal: activeRun.abortController.signal,
				onEvent: async (event) => {
					this.#throwIfRunFenced(activeRun);
					const remaining =
						maxAssistantMessageContentCharacters -
						activeRun.durableAssistantContent.length -
						activeRun.pendingAssistantDelta.length;
					const acceptedDelta = event.delta.slice(0, Math.max(0, remaining));
					if (acceptedDelta.length > 0) {
						let offset = 0;
						while (offset < acceptedDelta.length) {
							this.#throwIfRunFenced(activeRun);
							const availableCharacters =
								maxChatDeltaCharacters - activeRun.pendingAssistantDelta.length;
							const chunk = acceptedDelta.slice(offset, offset + availableCharacters);
							activeRun.pendingAssistantDelta += chunk;
							offset += chunk.length;
							if (activeRun.pendingAssistantDelta.length === maxChatDeltaCharacters) {
								this.#persistPendingAssistantDeltaChunk(activeRun, maxChatDeltaCharacters);
							}
						}
						this.#schedulePendingAssistantDeltaFlush(activeRun);
					}
					this.#throwIfRunFenced(activeRun);
					if (acceptedDelta.length < event.delta.length) {
						this.#flushPendingAssistantDelta(activeRun);
						this.#fenceExecution(activeRun, "Assistant output exceeded the supported limit.");
						this.#commitOutputLimitFailure(activeRun);
						throw new AskChatRuntimeError({
							kind: "provider_failure",
							message: "Assistant output exceeded the supported limit.",
							retryable: true,
							runId: activeRun.runId,
						});
					}
				},
			});

			if (activeRun.terminalCommitted) {
				return;
			}
			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}
			this.#flushPendingAssistantDelta(activeRun);
			if (activeRun.terminalCommitted || activeRun.cancelRequested) {
				return;
			}

			if (result.text.length === 0) {
				throw new AskChatRuntimeError({
					kind: "provider_failure",
					message: "Provider returned an empty response.",
					retryable: true,
					runId: activeRun.runId,
				});
			}

			if (result.text.length > maxAssistantMessageContentCharacters) {
				this.#fenceExecution(activeRun, "Assistant output exceeded the supported limit.");
				this.#commitOutputLimitFailure(
					activeRun,
					result.text.slice(0, maxAssistantMessageContentCharacters),
				);
				return;
			}
			const completed = this.#runs.commitTerminal({
				runId: activeRun.runId,
				message: {
					messageId: activeRun.assistantMessageId,
					status: "complete",
					content: result.text,
				},
			});
			activeRun.terminalCommitted = true;
			this.#publish(completed.events);
		} catch (error) {
			if (activeRun.terminalCommitted) {
				return;
			}
			if (
				activeRun.persistenceFailure === undefined &&
				(isCancellation(error) || activeRun.cancelRequested)
			) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			let failure = activeRun.persistenceFailure ?? error;
			this.#fenceExecution(activeRun, "Chat output persistence failed.");
			if (activeRun.persistenceFailure === undefined) {
				try {
					this.#flushPendingAssistantDelta(activeRun);
				} catch (flushError) {
					failure = flushError;
				}
			}
			this.#handleFailedRun(activeRun, failure);
		} finally {
			if (!activeRun.retainFence) {
				this.#releaseRun(activeRun);
			}
		}
	}

	async #finishCancelledRun(activeRun: ActiveChatRun): Promise<void> {
		if (activeRun.terminalCommitted) {
			return;
		}
		try {
			this.#flushPendingAssistantDelta(activeRun);
		} catch (error) {
			this.#handleFailedRun(activeRun, error);
			return;
		}
		if (activeRun.terminalCommitted) {
			return;
		}
		let terminal: ReturnType<RunJournalRepository["commitTerminal"]>;
		try {
			terminal = this.#runs.commitTerminal({
				runId: activeRun.runId,
				message: {
					messageId: activeRun.assistantMessageId,
					status: "cancelled",
					content: activeRun.durableAssistantContent,
				},
			});
		} catch (error) {
			this.#markDataPlaneFatal(activeRun, error);
			return;
		}
		activeRun.terminalCommitted = true;
		this.#publish(terminal.events);

		await Promise.resolve();
	}

	#commitOutputLimitFailure(
		activeRun: ActiveChatRun,
		terminalContent = activeRun.durableAssistantContent,
	): void {
		if (activeRun.terminalCommitted) {
			return;
		}
		try {
			this.#flushPendingAssistantDelta(activeRun);
		} catch (error) {
			this.#handleFailedRun(activeRun, error);
			return;
		}
		if (activeRun.terminalCommitted) {
			return;
		}
		let terminal: ReturnType<RunJournalRepository["commitTerminal"]>;
		try {
			terminal = this.#runs.commitTerminal({
				runId: activeRun.runId,
				message: {
					messageId: activeRun.assistantMessageId,
					status: "failed",
					content: terminalContent.slice(0, maxAssistantMessageContentCharacters),
					error: createOutputLimitAppError(activeRun.runId),
				},
			});
		} catch (error) {
			this.#markDataPlaneFatal(activeRun, error);
			return;
		}
		activeRun.terminalCommitted = true;
		this.#publish(terminal.events);
	}

	#commitFailedTerminal(
		activeRun: ActiveChatRun,
		error: unknown,
	): ReturnType<RunJournalRepository["commitTerminal"]> {
		const content = activeRun.durableAssistantContent.slice(
			0,
			maxAssistantMessageContentCharacters,
		);
		// The client only ever sees a redacted AppError, so the underlying provider failure has to
		// reach the server log or the failure is undiagnosable.
		this.#logger.error(`Chat run ${activeRun.runId} failed against the Provider.`, error);
		try {
			return this.#runs.commitTerminal({
				runId: activeRun.runId,
				message: {
					messageId: activeRun.assistantMessageId,
					status: "failed",
					content,
					error: toAppError(error, activeRun.runId),
				},
			});
		} catch (commitError) {
			this.#logger.error(
				`Primary failed terminal commit for Run ${activeRun.runId} failed; retrying a bounded fallback.`,
				createLastResortAppError(activeRun.runId),
			);
			void commitError;
			return this.#runs.commitTerminal({
				runId: activeRun.runId,
				message: {
					messageId: activeRun.assistantMessageId,
					status: "failed",
					content,
					error: createLastResortAppError(activeRun.runId),
				},
			});
		}
	}

	#handleFailedRun(activeRun: ActiveChatRun, error: unknown): void {
		if (activeRun.terminalCommitted || activeRun.retainFence) {
			return;
		}
		this.#fenceExecution(activeRun, "Chat run failed.");
		try {
			const failed = this.#commitFailedTerminal(activeRun, error);
			activeRun.terminalCommitted = true;
			this.#publish(failed.events);
		} catch (terminalError) {
			this.#markDataPlaneFatal(activeRun, terminalError);
		}
	}

	#readAllRunItems(sessionId: string): RunJournalPageItem[] {
		const items: RunJournalPageItem[] = [];
		let after: RunPageCursor | undefined;
		do {
			const page = this.#readRunPage({
				sessionId,
				...(after === undefined ? {} : { after }),
				limit: 100,
			});
			items.push(...page.items);
			after = page.nextCursor;
		} while (after !== undefined);
		return items;
	}

	#readRunPage(input: {
		sessionId: string;
		after?: RunPageCursor;
		limit: number;
	}): ListRunPageOutput {
		let page = this.#runs.listPageBySession(input);
		let finalized = false;
		for (const item of page.items) {
			if (isNonTerminalRun(item.run) && !this.#activeRuns.has(item.run.id)) {
				this.#finalizeOrphanedRun(item.run, false);
				finalized = true;
			}
		}
		if (finalized) {
			page = this.#runs.listPageBySession(input);
		}
		return page;
	}

	#buildJournalMessages(items: RunJournalPageItem[]): ChatMessage[] {
		const messages: ChatMessage[] = [];

		for (const item of items) {
			const { run } = item;
			const sequence = messages.length + 1;
			messages.push(createUserMessage(run, item.userContent, sequence));

			const terminalEvent = item.events.findLast((event) => event.type === "message.completed");
			const streamedContent =
				item.assistantContent ??
				item.events.reduce((content, event) => {
					return event.type === "message.delta" ? `${content}${event.payload.delta}` : content;
				}, "");
			const assistantSequence = messages.length + 1;
			const terminalContent =
				item.assistantContent ??
				(terminalEvent?.type === "message.completed"
					? terminalEvent.payload.content
					: streamedContent);

			if (run.status === "completed") {
				if (terminalContent.length > 0) {
					messages.push(
						createAssistantMessage(run, "complete", terminalContent, assistantSequence),
					);
				}
				continue;
			}

			if (run.status === "failed") {
				messages.push(
					createAssistantMessage(run, "failed", terminalContent, assistantSequence, run.lastError),
				);
				continue;
			}

			if (run.status === "cancelled") {
				messages.push(createAssistantMessage(run, "cancelled", terminalContent, assistantSequence));
				continue;
			}

			messages.push(createAssistantMessage(run, "streaming", streamedContent, assistantSequence));
		}

		return messages;
	}

	#readPartialAssistantContent(runId: string): { content: string; exceeded: boolean } {
		let content = "";
		let exceeded = false;
		let afterSeq = 0;
		while (true) {
			const page = this.#runs.listEventPage({
				runId,
				afterSeq,
				limit: maxRunEventPageSize,
			});
			for (const event of page.events) {
				if (event.type !== "message.delta") {
					continue;
				}
				const remaining = maxAssistantMessageContentCharacters - content.length;
				if (remaining <= 0) {
					exceeded = true;
					continue;
				}
				const acceptedDelta = event.payload.delta.slice(0, remaining);
				content += acceptedDelta;
				if (acceptedDelta.length < event.payload.delta.length) {
					exceeded = true;
				}
			}
			if (!page.hasMore) {
				break;
			}
			const nextSeq = page.events.at(-1)?.seq;
			if (nextSeq === undefined || nextSeq <= afterSeq) {
				throw new Error(`Event paging for Run ${runId} did not advance.`);
			}
			afterSeq = nextSeq;
		}
		return { content, exceeded };
	}

	#schedulePendingAssistantDeltaFlush(activeRun: ActiveChatRun): void {
		if (
			activeRun.pendingAssistantDelta.length === 0 ||
			activeRun.pendingDeltaFlushTimer !== undefined ||
			activeRun.cancelRequested ||
			activeRun.terminalCommitted
		) {
			return;
		}
		activeRun.pendingDeltaFlushTimer = setTimeout(() => {
			activeRun.pendingDeltaFlushTimer = undefined;
			if (
				activeRun.cancelRequested ||
				activeRun.terminalCommitted ||
				this.#activeRuns.get(activeRun.runId) !== activeRun
			) {
				return;
			}
			try {
				this.#flushPendingAssistantDelta(activeRun);
			} catch (error) {
				activeRun.persistenceFailure = error;
				this.#handleFailedRun(activeRun, error);
			}
		}, STREAMED_DELTA_FLUSH_LATENCY_MS);
	}

	#flushPendingAssistantDelta(activeRun: ActiveChatRun): void {
		if (activeRun.pendingDeltaFlushTimer !== undefined) {
			clearTimeout(activeRun.pendingDeltaFlushTimer);
			activeRun.pendingDeltaFlushTimer = undefined;
		}
		while (activeRun.pendingAssistantDelta.length > 0 && !activeRun.terminalCommitted) {
			this.#persistPendingAssistantDeltaChunk(
				activeRun,
				Math.min(maxChatDeltaCharacters, activeRun.pendingAssistantDelta.length),
			);
		}
	}

	#persistPendingAssistantDeltaChunk(activeRun: ActiveChatRun, length: number): void {
		const chunk = activeRun.pendingAssistantDelta.slice(0, length);
		let persistedEvent: ChatRunEvent;
		try {
			persistedEvent = this.#runs.appendEvent({
				runId: activeRun.runId,
				type: "message.delta",
				source: { kind: "assistant" },
				payload: {
					messageId: activeRun.assistantMessageId,
					delta: chunk,
				},
			});
		} catch (error) {
			activeRun.persistenceFailure = error;
			this.#handleFailedRun(activeRun, error);
			throw error;
		}
		activeRun.pendingAssistantDelta = activeRun.pendingAssistantDelta.slice(chunk.length);
		activeRun.durableAssistantContent += chunk;
		this.#publish([persistedEvent]);
	}

	#publish(events: readonly ChatRunEvent[]): void {
		if (events.length === 0) {
			return;
		}
		this.#publicationQueue.push([...events]);
		if (this.#publishing) {
			return;
		}
		this.#publishing = true;
		try {
			while (this.#publicationQueue.length > 0) {
				const batch = this.#publicationQueue.shift();
				if (batch === undefined) {
					continue;
				}
				for (const event of batch) {
					for (const listener of [...this.#listeners]) {
						try {
							void Promise.resolve(listener(event)).catch((error: unknown) => {
								this.#logger.error(`Failed to publish chat event ${event.id}.`, error);
							});
						} catch (error) {
							this.#logger.error(`Failed to publish chat event ${event.id}.`, error);
						}
					}
				}
			}
		} finally {
			this.#publishing = false;
		}
	}

	#releaseRun(activeRun: ActiveChatRun): void {
		if (activeRun.pendingDeltaFlushTimer !== undefined) {
			clearTimeout(activeRun.pendingDeltaFlushTimer);
			activeRun.pendingDeltaFlushTimer = undefined;
		}
		if (this.#activeRuns.get(activeRun.runId) === activeRun) {
			this.#activeRuns.delete(activeRun.runId);
		}
		if (this.#activeSessions.get(activeRun.sessionId) === activeRun.runId) {
			this.#activeSessions.delete(activeRun.sessionId);
		}
	}

	#throwIfRunFenced(activeRun: ActiveChatRun): void {
		if (
			!activeRun.cancelRequested &&
			!activeRun.terminalCommitted &&
			!activeRun.abortController.signal.aborted &&
			this.#activeRuns.get(activeRun.runId) === activeRun
		) {
			return;
		}
		const reason = activeRun.abortController.signal.reason;
		if (reason instanceof AskChatCancelledError) {
			throw reason;
		}
		throw new AskChatCancelledError(activeRun.runId, "Chat run no longer accepts output.");
	}

	#fenceExecution(activeRun: ActiveChatRun, reason: string): void {
		if (!activeRun.abortController.signal.aborted) {
			activeRun.abortController.abort(new AskChatCancelledError(activeRun.runId, reason));
		}
		this.#runtime.cancel(activeRun.runId, reason);
	}

	#markDataPlaneFatal(activeRun: ActiveChatRun, error: unknown): void {
		activeRun.retainFence = true;
		this.#fenceExecution(activeRun, "Chat persistence is unavailable.");
		if (activeRun.pendingDeltaFlushTimer !== undefined) {
			clearTimeout(activeRun.pendingDeltaFlushTimer);
			activeRun.pendingDeltaFlushTimer = undefined;
		}
		this.#markDataPlanePersistenceFatal(activeRun.runId);
		void error;
	}

	#markDataPlanePersistenceFatal(runId: string): void {
		if (this.#dataPlaneFatal) {
			return;
		}
		this.#dataPlaneFatal = true;
		this.#logger.error(
			"Chat persistence became unavailable after a bounded terminal commit failure.",
			createLastResortAppError(runId),
		);
	}

	#reserveSessionStart(sessionId: string): symbol {
		this.#assertSessionNotDeleting(sessionId);
		if (this.#startingSessions.has(sessionId) || this.#activeSessions.has(sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "This chat already has an active response.",
				retryable: false,
			});
		}
		const reservation = Symbol(sessionId);
		this.#startingSessions.set(sessionId, reservation);
		return reservation;
	}

	#revalidateSessionStart(sessionId: string, reservation: symbol): void {
		if (this.#startingSessions.get(sessionId) !== reservation) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "This chat response reservation was lost.",
				retryable: false,
			});
		}
		this.#assertSessionNotDeleting(sessionId);
		if (this.#activeSessions.has(sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "This chat already has an active response.",
				retryable: false,
			});
		}
	}

	#releaseSessionStart(sessionId: string, reservation: symbol): void {
		if (this.#startingSessions.get(sessionId) === reservation) {
			this.#startingSessions.delete(sessionId);
		}
	}

	#requireProvider(providerId: string): ProviderRecord {
		const record = this.#providers.get(providerId);
		if (record === null) {
			throw new ProviderNotFoundError(providerId);
		}
		return record;
	}

	#requireProviderModel(providerId: string, modelId: string): ProviderModel {
		const record = this.#requireProvider(providerId);
		const model = record.models.find((candidate) => candidate.id === modelId);
		if (model === undefined) {
			throw new ProviderModelNotFoundError(providerId, modelId);
		}
		return model;
	}

	/** Rebuilds the selection, dropping any reasoning setting the model no longer advertises. */
	#normalizeSelection(selection: {
		providerId: string;
		modelId: string;
		reasoning?: { effort?: string | undefined; budgetTokens?: number | undefined } | undefined;
	}): DefaultModelSelection {
		const record = this.#requireProvider(selection.providerId);
		const model = this.#requireProviderModel(selection.providerId, selection.modelId);
		const reasoning = normalizeReasoningSelection(
			resolveReasoningCapability(record.type, model),
			selection.reasoning,
		);

		return {
			providerId: selection.providerId,
			modelId: selection.modelId,
			...(reasoning === undefined ? {} : { reasoning }),
		};
	}

	/**
	 * Resolves the Provider a Session should run against: its own selection first, then the
	 * global default. Selections pointing at a removed Provider or model fall back too.
	 */
	#resolveSessionProvider(sessionId: string): ResolvedProviderConfiguration {
		const session = this.#sessions.get({ sessionId });
		const candidates = [session.model, this.#providers.getDefaultModel() ?? undefined];
		for (const candidate of candidates) {
			if (candidate === undefined) {
				continue;
			}
			const record = this.#providers.get(candidate.providerId);
			const model = record?.models.find((entry) => entry.id === candidate.modelId);
			if (record === null || record === undefined || !record.enabled) {
				continue;
			}
			if (model === undefined || !model.enabled) {
				continue;
			}
			const reasoning = normalizeReasoningSelection(
				resolveReasoningCapability(record.type, model),
				candidate.reasoning,
			);

			return {
				providerId: record.id,
				providerName: record.displayName,
				type: record.type,
				protocol: resolveModelProtocol(record.type, model),
				baseUrl: record.baseUrl,
				apiKey: record.apiKey,
				...(record.customHeaders === undefined ? {} : { customHeaders: record.customHeaders }),
				model: model.id,
				...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
				...(reasoning === undefined ? {} : { reasoning }),
			};
		}

		throw new AskChatRuntimeError({
			kind: "not_configured",
			message: "No Provider and model are selected for this chat.",
			retryable: false,
		});
	}

	#resolveTestConfiguration(input: TestProviderInput): ResolvedProviderConfiguration {
		const parsedInput = testProviderInputSchema.parse(input);
		if (parsedInput.providerId !== undefined) {
			const record = this.#requireProvider(parsedInput.providerId);
			return {
				providerId: record.id,
				providerName: record.displayName,
				type: record.type,
				protocol: resolveModelProtocol(record.type),
				baseUrl: record.baseUrl,
				apiKey: record.apiKey,
				...(record.customHeaders === undefined ? {} : { customHeaders: record.customHeaders }),
				model: record.models.find((model) => model.enabled)?.id ?? "",
			};
		}

		const draft = parsedInput.draft ?? fail("Provider test input lost its draft.");
		const apiKey = draft.apiKey ?? this.#resolveDraftApiKey(draft.baseUrl);

		return {
			providerId: this.#providerId,
			providerName: draft.displayName,
			type: draft.type,
			protocol: resolveModelProtocol(draft.type),
			baseUrl: draft.baseUrl,
			apiKey,
			...(draft.customHeaders === undefined ? {} : { customHeaders: draft.customHeaders }),
			model: "",
		};
	}

	/** Reuses a stored key only for the same origin so keys never cross Provider hosts. */
	#resolveDraftApiKey(baseUrl: string): string {
		for (const record of this.#providers.list()) {
			if (haveSameOrigin(record.baseUrl, baseUrl)) {
				return record.apiKey;
			}
		}

		throw new AskChatRuntimeError({
			kind: "not_configured",
			message: "A new API key is required to test a Provider on a different Endpoint origin.",
			retryable: false,
		});
	}

	#assertSessionCanBeRemovedFromActiveList(sessionId: string): void {
		if (this.#activeSessions.has(sessionId) || this.#startingSessions.has(sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "Stop the active response before archiving or deleting this Session.",
				retryable: false,
			});
		}

		const runs = this.#runs.listBySession(sessionId);
		for (const run of runs) {
			if (
				(run.status === "queued" || run.status === "running" || run.status === "cancelling") &&
				!this.#activeRuns.has(run.id)
			) {
				this.#finalizeOrphanedRun(run);
			}
		}

		const hasRemainingActiveRun = this.#runs
			.listBySession(sessionId)
			.some(
				(run) => run.status === "queued" || run.status === "running" || run.status === "cancelling",
			);
		if (hasRemainingActiveRun) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "Resolve the active response before archiving or deleting this Session.",
				retryable: false,
			});
		}
	}

	#finalizeOrphanedRun(run: ChatRun, publish = true): ChatRun {
		let reservation: symbol | undefined;
		if (
			publish &&
			!this.#startingSessions.has(run.sessionId) &&
			!this.#deletingSessions.has(run.sessionId)
		) {
			reservation = this.#reserveSessionStart(run.sessionId);
		}
		try {
			const partial = this.#readPartialAssistantContent(run.id);
			const messageId =
				run.assistantMessageId ?? fail(`Run ${run.id} is missing its assistant message ID.`);
			let terminal: ReturnType<RunJournalRepository["commitTerminal"]>;
			try {
				terminal = this.#runs.commitTerminal({
					runId: run.id,
					message: partial.exceeded
						? {
								messageId,
								status: "failed",
								content: partial.content,
								error: createOutputLimitAppError(run.id),
							}
						: {
								messageId,
								status: "cancelled",
								content: partial.content,
							},
				});
			} catch {
				this.#markDataPlanePersistenceFatal(run.id);
				throw this.#createDataPlaneUnavailableError();
			}
			if (publish) {
				this.#publish(terminal.events);
			}
			return terminal.run;
		} finally {
			if (reservation !== undefined) {
				this.#releaseSessionStart(run.sessionId, reservation);
			}
		}
	}

	#assertProviderCanChange(): void {
		this.#assertDataPlaneAvailable();
		if (this.#activeRuns.size > 0 || this.#startingSessions.size > 0) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "Stop active responses before changing the Provider configuration.",
				retryable: false,
			});
		}
	}

	#assertSessionNotDeleting(sessionId: string): void {
		if (this.#deletingSessions.has(sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "This chat Session is being deleted.",
				retryable: false,
			});
		}
	}

	#assertRuntimeReady(): void {
		if (!this.#isRuntimeReady()) {
			throw new AskChatRuntimeError({
				kind: "provider_failure",
				message: "The local executor is not authenticated and ready.",
				retryable: true,
			});
		}
	}

	#assertDataPlaneAvailable(): void {
		if (this.#dataPlaneFatal) {
			throw this.#createDataPlaneUnavailableError();
		}
	}

	#createDataPlaneUnavailableError(): AskChatRuntimeError {
		return new AskChatRuntimeError({
			kind: "provider_failure",
			message: "Chat persistence is unavailable. Restart the local agents service.",
			retryable: true,
		});
	}
}

function haveSameOrigin(left: string, right: string): boolean {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}

function createSessionTitle(content: string): string {
	const normalized = content.trim().replace(/\s+/g, " ");
	return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}

function createUserMessage(run: ChatRun, content: string, sequence: number): ChatMessage {
	return chatMessageSchema.parse({
		schemaVersion: 1,
		id: run.userMessageId,
		sessionId: run.sessionId,
		runId: run.id,
		role: "user",
		status: "complete",
		content,
		sequence,
		createdAt: run.createdAt,
		updatedAt: run.createdAt,
	});
}

function createAssistantMessage(
	run: ChatRun,
	status: "streaming" | "complete" | "failed" | "cancelled",
	content: string,
	sequence: number,
	error?: AppError,
): ChatMessage {
	if (run.assistantMessageId === undefined) {
		throw new Error(`Run ${run.id} is missing its assistant message ID.`);
	}
	if (status === "failed" && error === undefined) {
		throw new Error(`Failed run ${run.id} is missing its error projection.`);
	}

	return chatMessageSchema.parse({
		schemaVersion: 1,
		id: run.assistantMessageId,
		sessionId: run.sessionId,
		runId: run.id,
		role: "assistant",
		status,
		content,
		sequence,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(error === undefined ? {} : { error }),
	});
}

async function testProviderConnection(configuration: ResolvedProviderConfiguration): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	const authenticationHeaders =
		configuration.type === "anthropic-compatible"
			? { "x-api-key": configuration.apiKey, "anthropic-version": anthropicApiVersion }
			: { Authorization: `${"Bearer"} ${configuration.apiKey}` };

	try {
		const response = await fetch(`${configuration.baseUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			redirect: "error",
			headers: {
				...authenticationHeaders,
				...(configuration.customHeaders ?? {}),
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (response.ok) {
			return;
		}
		if (response.status === 401 || response.status === 403) {
			throw new AskChatRuntimeError({
				kind: "provider_authentication",
				message: "Provider authentication failed.",
				retryable: false,
				statusCode: response.status,
			});
		}
		if (response.status === 429) {
			throw new AskChatRuntimeError({
				kind: "provider_rate_limited",
				message: "Provider rate limit reached.",
				retryable: true,
				statusCode: response.status,
			});
		}
		throw new AskChatRuntimeError({
			kind: "provider_failure",
			message: `Provider connection test failed with status ${response.status}.`,
			retryable: response.status >= 500,
			statusCode: response.status,
		});
	} catch (error) {
		if (error instanceof AskChatRuntimeError) {
			throw error;
		}
		throw new AskChatRuntimeError({
			kind: "provider_network",
			message:
				error instanceof Error && error.name === "AbortError"
					? "Provider connection test timed out."
					: "Provider connection test could not reach the endpoint.",
			retryable: true,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function isCancellation(error: unknown): boolean {
	try {
		return (
			error instanceof AskChatCancelledError ||
			(error instanceof AskChatRuntimeError && error.kind === "cancelled")
		);
	} catch {
		return false;
	}
}

function isNonTerminalRun(run: ChatRun): boolean {
	return run.status === "queued" || run.status === "running" || run.status === "cancelling";
}

function takeReplayEventsWithinByteBudget(events: readonly ChatRunEvent[]): ChatRunEvent[] {
	const bounded: ChatRunEvent[] = [];
	let encodedBytes = 2;
	for (const event of events) {
		const eventBytes = replayTextEncoder.encode(JSON.stringify(event)).byteLength;
		const nextBytes = encodedBytes + eventBytes + (bounded.length === 0 ? 0 : 1);
		if (nextBytes > maxReplayEventBytesPerPage && bounded.length > 0) {
			break;
		}
		bounded.push(event);
		encodedBytes = nextBytes;
	}
	return bounded;
}

function encodeRunPageCursor(cursor: RunPageCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeRunPageCursor(value: string): RunPageCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new TypeError("Session page cursor is invalid.", { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("createdAtMs" in parsed) ||
		!("id" in parsed) ||
		typeof parsed.createdAtMs !== "number" ||
		typeof parsed.id !== "string"
	) {
		throw new TypeError("Session page cursor is invalid.");
	}
	return { createdAtMs: parsed.createdAtMs, id: parsed.id };
}

class CheckpointDeletionShutdownError extends Error {
	constructor() {
		super("Checkpoint deletion stopped during application shutdown.");
		this.name = "CheckpointDeletionShutdownError";
	}
}

function settlesWithin(operation: PromiseLike<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (completed: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(completed);
		};
		const timer = setTimeout(() => finish(false), Math.min(timeoutMs, 2_147_483_647));
		void Promise.resolve(operation).then(
			() => finish(true),
			() => finish(true),
		);
	});
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

function fail(message: string): never {
	throw new Error(message);
}

function createOutputLimitAppError(runId: string): AppError {
	return appErrorSchema.parse({
		code: "CHAT_OUTPUT_LIMIT_EXCEEDED",
		category: "provider",
		messageKey: "errors.chatOutputLimitExceeded",
		safeMessage: "The response exceeded the supported output limit.",
		retryable: true,
		causeId: runId,
	});
}

function createLastResortAppError(runId: string): AppError {
	return appErrorSchema.parse({
		code: "CHAT_RUN_FAILED",
		category: "unknown",
		messageKey: "errors.chatRunFailed",
		safeMessage: "The chat response failed.",
		retryable: false,
		causeId: runId.slice(0, 256) || "chat-run",
	});
}

function toAppError(error: unknown, runId: string): AppError {
	try {
		if (!(error instanceof AskChatRuntimeError)) {
			return createLastResortAppError(runId);
		}
		const details = runtimeErrorDetails[error.kind];
		if (details === undefined) {
			return createLastResortAppError(runId);
		}
		return appErrorSchema.parse({
			code: details.code,
			category: details.category,
			messageKey: details.messageKey,
			safeMessage: normalizeAppErrorSafeMessage(error.message, "The chat response failed."),
			retryable: error.retryable === true,
			causeId: runId.slice(0, 256) || "chat-run",
		});
	} catch {
		return createLastResortAppError(runId);
	}
}

const runtimeErrorDetails: Record<
	AskChatRuntimeError["kind"],
	Pick<AppError, "code" | "category" | "messageKey">
> = {
	not_configured: {
		code: "PROVIDER_NOT_CONFIGURED",
		category: "validation",
		messageKey: "errors.providerNotConfigured",
	},
	duplicate_run_id: {
		code: "CHAT_RUN_ALREADY_ACTIVE",
		category: "conflict",
		messageKey: "errors.chatRunAlreadyActive",
	},
	cancelled: {
		code: "CHAT_RUN_CANCELLED",
		category: "runtime",
		messageKey: "errors.chatRunCancelled",
	},
	provider_authentication: {
		code: "PROVIDER_AUTHENTICATION_FAILED",
		category: "authentication",
		messageKey: "errors.providerAuthenticationFailed",
	},
	provider_rate_limited: {
		code: "PROVIDER_RATE_LIMITED",
		category: "rate_limit",
		messageKey: "errors.providerRateLimited",
	},
	provider_network: {
		code: "PROVIDER_NETWORK_FAILED",
		category: "network",
		messageKey: "errors.providerNetworkFailed",
	},
	provider_model: {
		code: "PROVIDER_MODEL_FAILED",
		category: "provider",
		messageKey: "errors.providerModelFailed",
	},
	provider_failure: {
		code: "PROVIDER_REQUEST_FAILED",
		category: "provider",
		messageKey: "errors.providerRequestFailed",
	},
	thread_busy: {
		code: "CHAT_THREAD_BUSY",
		category: "conflict",
		messageKey: "errors.chatThreadBusy",
	},
	runtime_shutdown: {
		code: "CHAT_RUNTIME_UNAVAILABLE",
		category: "runtime",
		messageKey: "errors.chatRuntimeUnavailable",
	},
	shutdown_timeout: {
		code: "CHAT_RUNTIME_SHUTDOWN_TIMEOUT",
		category: "runtime",
		messageKey: "errors.chatRuntimeShutdownTimeout",
	},
};
