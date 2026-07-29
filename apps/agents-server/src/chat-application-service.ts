import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRuntime,
	type AskChatSkillResource,
	type AgentMcpResource,
	AskChatRuntimeError,
	ProviderModelNotFoundError,
	ProviderNotFoundError,
	type ProviderRecord,
	type ProviderRegistry,
	type ResolvedProviderConfiguration,
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
	defaultLocalRuntimeBoxId,
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
	maxAgentSessionCleanupBatchSize,
	maxRunEventPageSize,
	type RunJournalPageItem,
	type RunJournalRepository,
	type RunPageCursor,
	type SessionRepository,
	type ActionRepository,
} from "@moshu/database";

const STREAMED_DELTA_FLUSH_LATENCY_MS = 20;
const replayTextEncoder = new TextEncoder();

type ChatEventListener = (event: ChatRunEvent) => void | PromiseLike<void>;
type ChatTaskScheduler = (task: () => void) => void;
type ProviderModelCatalogFetcher = (providerId: string) => Promise<readonly ProviderModel[]>;
const defaultProviderModelFetcher: ProviderModelCatalogFetcher = async () => [];

interface ChatServiceLogger {
	error(message: string, error: unknown): void;
	info?(message: string): void;
}

export interface AgentSessionCleanupRetryResult {
	attempted: number;
	succeeded: number;
	failed: number;
	remaining: number;
}

type AgentSessionCleanupAttemptOutcome =
	| "succeeded"
	| "failed"
	| "ineligible"
	| "retry-state-persistence-failed"
	| "stopped";

const agentSessionCleanupStartupBatchSize = 64;
const defaultAgentSessionCleanupRetryBaseMs = 1_000;
const defaultAgentSessionCleanupRetryMaxMs = 60_000;
const defaultAgentSessionCleanupAttemptTimeoutMs = 5_000;
const defaultAgentSessionCleanupMaxInFlightAttempts = 4;
const defaultAgentSessionCleanupStartupTimeoutMs = 2_000;
const defaultAgentSessionCleanupStartupMaxAttempts = 64;
const defaultShutdownTimeoutMs = 5_000;

export interface ChatApplicationServiceOptions {
	sessions: SessionRepository;
	runs: RunJournalRepository;
	providers: ProviderRegistry;
	runtime: AskChatRuntime;
	fetchProviderModels?: ProviderModelCatalogFetcher;
	schedule?: ChatTaskScheduler;
	logger?: ChatServiceLogger;
	isRuntimeReady?: (runtimeBoxId: string) => boolean;
	getActiveRuntimeBoxId?: () => string;
	actions?: ActionRepository;
	resolveRuntimeResources?: (
		runtimeBoxId: string,
		signal: AbortSignal,
	) => Promise<{
		skills: readonly AskChatSkillResource[];
		mcpResources: readonly AgentMcpResource[];
	}>;
	agentSessionCleanupRetryBaseMs?: number;
	agentSessionCleanupRetryMaxMs?: number;
	agentSessionCleanupAttemptTimeoutMs?: number;
	agentSessionCleanupMaxInFlightAttempts?: number;
	agentSessionCleanupStartupTimeoutMs?: number;
	agentSessionCleanupStartupMaxAttempts?: number;
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
	agentSessionId: string;
	runtimeBoxId: string;
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
	readonly #isRuntimeReady: (runtimeBoxId: string) => boolean;
	readonly #getActiveRuntimeBoxId: () => string;
	readonly #actions: ActionRepository | undefined;
	readonly #resolveRuntimeResources:
		| ((
				runtimeBoxId: string,
				signal: AbortSignal,
		  ) => Promise<{
				skills: readonly AskChatSkillResource[];
				mcpResources: readonly AgentMcpResource[];
		  }>)
		| undefined;
	readonly #listeners = new Set<ChatEventListener>();
	readonly #publicationQueue: ChatRunEvent[][] = [];
	readonly #activeRuns = new Map<string, ActiveChatRun>();
	readonly #activeSessions = new Map<string, string>();
	readonly #startingSessions = new Map<string, symbol>();
	readonly #deletingSessions = new Set<string>();
	readonly #sessionDeletions = new Map<string, Promise<DeleteChatSessionOutput>>();
	readonly #executions = new Set<Promise<void>>();
	readonly #agentSessionCleanupExecutions = new Set<Promise<unknown>>();
	readonly #agentSessionCleanupRetryBaseMs: number;
	readonly #agentSessionCleanupRetryMaxMs: number;
	readonly #agentSessionCleanupAttemptTimeoutMs: number;
	readonly #agentSessionCleanupMaxInFlightAttempts: number;
	readonly #agentSessionCleanupStartupTimeoutMs: number;
	readonly #agentSessionCleanupStartupMaxAttempts: number;
	readonly #shutdownTimeoutMs: number;
	readonly #agentSessionCleanupAttempts = new Map<
		string,
		Promise<AgentSessionCleanupAttemptOutcome>
	>();
	readonly #agentSessionCleanupOperations = new Map<string, Promise<void>>();
	readonly #shutdownController = new AbortController();
	#agentSessionRecoveryExecution: Promise<void> | undefined;
	#agentSessionWorkerExecution: Promise<void> | undefined;
	#agentSessionRetryWait:
		| { timer: ReturnType<typeof setTimeout>; resolve: () => void; wakeable: boolean }
		| undefined;
	#agentSessionRetryStatePersistenceFailureCount = 0;
	#agentSessionRetryStatePersistenceBackoffUntilMs = 0;
	#shutdownExecution: Promise<void> | undefined;
	#publishing = false;
	#shuttingDown = false;
	#dataPlaneFatal = false;

	constructor(options: ChatApplicationServiceOptions) {
		this.#sessions = options.sessions;
		this.#runs = options.runs;
		this.#providers = options.providers;
		this.#fetchProviderModels = options.fetchProviderModels ?? defaultProviderModelFetcher;
		this.#runtime = options.runtime;
		this.#schedule = options.schedule ?? ((task) => setTimeout(task, 0));
		this.#logger = options.logger ?? console;
		this.#isRuntimeReady = options.isRuntimeReady ?? (() => true);
		this.#getActiveRuntimeBoxId = options.getActiveRuntimeBoxId ?? (() => defaultLocalRuntimeBoxId);
		this.#actions = options.actions;
		this.#resolveRuntimeResources = options.resolveRuntimeResources;
		this.#agentSessionCleanupRetryBaseMs = requirePositiveSafeInteger(
			options.agentSessionCleanupRetryBaseMs ?? defaultAgentSessionCleanupRetryBaseMs,
			"agentSessionCleanupRetryBaseMs",
		);
		this.#agentSessionCleanupRetryMaxMs = requirePositiveSafeInteger(
			options.agentSessionCleanupRetryMaxMs ?? defaultAgentSessionCleanupRetryMaxMs,
			"agentSessionCleanupRetryMaxMs",
		);
		if (this.#agentSessionCleanupRetryMaxMs < this.#agentSessionCleanupRetryBaseMs) {
			throw new TypeError(
				"agentSessionCleanupRetryMaxMs must be greater than or equal to agentSessionCleanupRetryBaseMs.",
			);
		}
		this.#agentSessionCleanupAttemptTimeoutMs = requirePositiveSafeInteger(
			options.agentSessionCleanupAttemptTimeoutMs ?? defaultAgentSessionCleanupAttemptTimeoutMs,
			"agentSessionCleanupAttemptTimeoutMs",
		);
		this.#agentSessionCleanupMaxInFlightAttempts = requirePositiveSafeInteger(
			options.agentSessionCleanupMaxInFlightAttempts ??
				defaultAgentSessionCleanupMaxInFlightAttempts,
			"agentSessionCleanupMaxInFlightAttempts",
		);
		this.#agentSessionCleanupStartupTimeoutMs = requirePositiveSafeInteger(
			options.agentSessionCleanupStartupTimeoutMs ?? defaultAgentSessionCleanupStartupTimeoutMs,
			"agentSessionCleanupStartupTimeoutMs",
		);
		this.#agentSessionCleanupStartupMaxAttempts = requirePositiveSafeInteger(
			options.agentSessionCleanupStartupMaxAttempts ?? defaultAgentSessionCleanupStartupMaxAttempts,
			"agentSessionCleanupStartupMaxAttempts",
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
			schemaVersion: 2,
			providers: this.#providers.list().map(toProviderSummary),
		});
	}

	async createProvider(input: CreateProviderInput): Promise<ProviderMutationOutput> {
		const parsedInput = createProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		const record = await this.#providers.create({
			displayName: parsedInput.displayName,
			api: parsedInput.api,
			baseUrl: parsedInput.baseUrl,
			...(parsedInput.apiKey === undefined ? {} : { apiKey: parsedInput.apiKey }),
			...(parsedInput.customHeaders === undefined
				? {}
				: { customHeaders: parsedInput.customHeaders }),
		});

		return providerMutationOutputSchema.parse({
			schemaVersion: 2,
			provider: toProviderSummary(record),
		});
	}

	async updateProvider(input: UpdateProviderInput): Promise<ProviderMutationOutput> {
		const parsedInput = updateProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		const record = await this.#providers.update({
			providerId: parsedInput.providerId,
			...(parsedInput.displayName === undefined ? {} : { displayName: parsedInput.displayName }),
			...(parsedInput.api === undefined ? {} : { api: parsedInput.api }),
			...(parsedInput.baseUrl === undefined ? {} : { baseUrl: parsedInput.baseUrl }),
			...(parsedInput.apiKey === undefined ? {} : { apiKey: parsedInput.apiKey }),
			...(parsedInput.customHeaders === undefined
				? {}
				: { customHeaders: parsedInput.customHeaders }),
			...(parsedInput.enabled === undefined ? {} : { enabled: parsedInput.enabled }),
		});

		return providerMutationOutputSchema.parse({
			schemaVersion: 2,
			provider: toProviderSummary(record),
		});
	}

	async deleteProvider(input: DeleteProviderInput): Promise<DeleteProviderOutput> {
		const parsedInput = deleteProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		await this.#providers.delete(parsedInput.providerId);

		return deleteProviderOutputSchema.parse({
			schemaVersion: 2,
			providerId: parsedInput.providerId,
		});
	}

	async testProvider(input: TestProviderInput): Promise<TestProviderOutput> {
		this.#assertDataPlaneAvailable();
		const startedAt = Date.now();

		try {
			const parsed = testProviderInputSchema.parse(input);
			if (parsed.providerId === undefined) {
				throw new AskChatRuntimeError({
					kind: "not_configured",
					message: "Save the custom Provider before testing it.",
					retryable: false,
				});
			}
			const provider = this.#requireProvider(parsed.providerId);
			if (!provider.credential.configured) {
				throw new AskChatRuntimeError({
					kind: "not_configured",
					message: "Provider credentials are not configured.",
					retryable: false,
				});
			}
			return testProviderOutputSchema.parse({
				schemaVersion: 2,
				ok: true,
				latencyMs: Date.now() - startedAt,
			});
		} catch (error) {
			return testProviderOutputSchema.parse({
				schemaVersion: 2,
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
		const updated =
			this.#fetchProviderModels === defaultProviderModelFetcher
				? await this.#providers.refreshModels(record.id)
				: record.source === "custom"
					? await this.#providers.setModels(
							record.id,
							(await this.#fetchProviderModels(record.id)).map((model) => ({ ...model })),
							new Date().toISOString(),
						)
					: record;

		return fetchProviderModelsOutputSchema.parse({
			schemaVersion: 2,
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
			schemaVersion: 2,
			provider: toProviderSummary(updated),
		});
	}

	listAvailableModels(): ListAvailableModelsOutput {
		const models: AvailableModel[] = [];
		for (const record of this.#providers.list()) {
			if (!record.enabled || !record.credential.configured) {
				continue;
			}
			for (const model of record.models) {
				if (!model.enabled) {
					continue;
				}
				models.push({
					providerId: record.id,
					providerDisplayName: record.displayName,
					providerSource: record.source,
					model: { ...model },
				});
			}
		}
		const defaultModel = this.#providers.getDefaultModel();

		return listAvailableModelsOutputSchema.parse({
			schemaVersion: 2,
			models,
			...(defaultModel === null ? {} : { defaultModel }),
		});
	}

	getDefaultModel(): GetDefaultModelOutput {
		const defaultModel = this.#providers.getDefaultModel();
		return getDefaultModelOutputSchema.parse({
			schemaVersion: 2,
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
			schemaVersion: 2,
			...(stored === null ? {} : { defaultModel: stored }),
		});
	}

	setSessionModel(input: SetChatSessionModelInput): SetChatSessionModelOutput {
		const parsedInput = setChatSessionModelInputSchema.parse(input);
		this.#assertDataPlaneAvailable();
		this.#assertSessionRuntimeReady(parsedInput.sessionId);
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
		this.#assertRuntimeReady(this.#getActiveRuntimeBoxId());
		return this.#sessions.create({
			title: "New chat",
			defaultMode: "agent",
		});
	}

	createSessionIdempotently(
		request: CreateProcessChatSessionInput,
		origin: ProcessPeerIdentity,
	): CreateChatSessionOutput {
		this.#assertDataPlaneAvailable();
		const existing = this.#sessions.findIdempotent({ request, origin });
		if (existing !== undefined) {
			return existing;
		}
		this.#assertRuntimeReady(request.runtimeBoxId ?? this.#getActiveRuntimeBoxId());
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
		this.#assertSessionRuntimeReady(parsedInput.sessionId);
		return this.#sessions.update(parsedInput);
	}

	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		this.#assertDataPlaneAvailable();
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		this.#assertSessionNotDeleting(parsedInput.sessionId);
		this.#assertSessionRuntimeReady(parsedInput.sessionId);
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
		if (this.#actions?.hasUnacknowledgedForSession(parsedInput.sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "Reconcile pending Runtime Box Actions before deleting this Session.",
				retryable: true,
			});
		}
		this.#assertSessionRuntimeReady(parsedInput.sessionId);
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
		const cleanup = this.#attemptAgentSessionCleanup(parsedInput.sessionId, 0);
		this.#agentSessionCleanupExecutions.add(cleanup);
		const finishCleanup = (): void => {
			this.#agentSessionCleanupExecutions.delete(cleanup);
			this.#deletingSessions.delete(parsedInput.sessionId);
			if (this.#sessionDeletions.get(parsedInput.sessionId) === result) {
				this.#sessionDeletions.delete(parsedInput.sessionId);
			}
			this.#ensureAgentSessionCleanupWorker();
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
		const reservation = this.#reserveSessionStart(input.sessionId);
		let convertedReservation = false;
		try {
			const currentSession = this.#sessions.get({ sessionId: input.sessionId });
			this.#assertRuntimeReady(currentSession.runtimeBoxId);
			const provider = this.#resolveSessionProvider(input.sessionId);
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
				mode: "agent",
				provider: {
					schemaVersion: 1,
					providerId: provider.providerId,
					name: provider.providerName,
					source: provider.source,
					api: provider.api,
					model: provider.model,
					...(provider.thinkingLevel === undefined
						? {}
						: { thinkingLevel: provider.thinkingLevel }),
				},
				userMessageId,
				userContent: input.content,
				assistantMessageId,
			});
			const activeRun: ActiveChatRun = {
				runId: created.run.id,
				sessionId: input.sessionId,
				agentSessionId: currentSession.agentSessionId,
				runtimeBoxId: currentSession.runtimeBoxId,
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

	async retryPendingAgentSessionCleanups(
		options: { limit?: number; includeDeferred?: boolean } = {},
	): Promise<AgentSessionCleanupRetryResult> {
		const limit = options.limit ?? agentSessionCleanupStartupBatchSize;
		const jobs = this.#listEligibleAgentSessionCleanupJobs(limit, options.includeDeferred ?? false);
		let succeeded = 0;
		let failed = 0;
		for (const job of jobs) {
			if (this.#shuttingDown) {
				break;
			}
			const outcome = await this.#attemptAgentSessionCleanup(job.sessionId, job.attemptCount);
			if (outcome === "succeeded") {
				succeeded += 1;
			} else if (outcome !== "ineligible") {
				failed += 1;
			}
			if (outcome === "retry-state-persistence-failed" || outcome === "stopped") {
				break;
			}
		}
		const remaining = this.#runs.listPendingAgentSessionCleanups(
			agentSessionCleanupStartupBatchSize,
			true,
		).length;
		const result = { attempted: succeeded + failed, succeeded, failed, remaining };
		if (remaining > 0) {
			this.#ensureAgentSessionCleanupWorker();
		}
		this.#logger.info?.(
			`Agent session cleanup recovery attempted ${result.attempted} job(s): ${succeeded} succeeded, ${failed} failed, at least ${remaining} remain.`,
		);
		return result;
	}

	drainPendingAgentSessionCleanups(options: { batchSize?: number } = {}): Promise<void> {
		if (this.#agentSessionRecoveryExecution !== undefined) {
			return this.#agentSessionRecoveryExecution;
		}
		const batchSize = options.batchSize ?? agentSessionCleanupStartupBatchSize;
		const execution = this.#runInitialAgentSessionCleanupSweep(batchSize);
		this.#agentSessionRecoveryExecution = execution;
		this.#agentSessionCleanupExecutions.add(execution);
		const cleanup = (): void => {
			if (this.#agentSessionRecoveryExecution === execution) {
				this.#agentSessionRecoveryExecution = undefined;
			}
			this.#agentSessionCleanupExecutions.delete(execution);
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
		this.#wakeAgentSessionCleanupRetry(true);
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

		const agentSessionCleanup = Promise.allSettled([...this.#agentSessionCleanupExecutions]);
		const runtimeShutdown = Promise.resolve().then(() => this.#runtime.shutdown());
		const shutdown = Promise.allSettled([agentSessionCleanup, runtimeShutdown]).then((results) => {
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

	async #runInitialAgentSessionCleanupSweep(batchSize: number): Promise<void> {
		const jobs = this.#listEligibleAgentSessionCleanupJobs(batchSize, true).slice(
			0,
			this.#agentSessionCleanupStartupMaxAttempts,
		);
		const deadline = Date.now() + this.#agentSessionCleanupStartupTimeoutMs;
		for (const job of jobs) {
			if (this.#shuttingDown) {
				return;
			}
			const attempt = this.#getOrStartAgentSessionCleanup(job.sessionId, job.attemptCount);
			const outcome = await this.#waitForAgentSessionCleanupAttempt(attempt, deadline);
			if (
				outcome === undefined ||
				outcome === "retry-state-persistence-failed" ||
				outcome === "stopped"
			) {
				break;
			}
		}
		this.#ensureAgentSessionCleanupWorker();
	}

	async #attemptAgentSessionCleanup(
		sessionId: string,
		attemptCount: number,
	): Promise<AgentSessionCleanupAttemptOutcome> {
		return this.#getOrStartAgentSessionCleanup(sessionId, attemptCount);
	}

	#getOrStartAgentSessionCleanup(
		sessionId: string,
		attemptCount: number,
	): Promise<AgentSessionCleanupAttemptOutcome> {
		const existing = this.#agentSessionCleanupAttempts.get(sessionId);
		if (existing !== undefined) {
			return existing;
		}
		if (this.#agentSessionCleanupOperations.has(sessionId)) {
			return Promise.resolve("ineligible");
		}
		const execution = this.#performAgentSessionCleanup(sessionId, attemptCount);
		this.#agentSessionCleanupAttempts.set(sessionId, execution);
		const cleanup = (): void => {
			if (this.#agentSessionCleanupAttempts.get(sessionId) === execution) {
				this.#agentSessionCleanupAttempts.delete(sessionId);
			}
			this.#wakeAgentSessionCleanupRetry();
		};
		void execution.then(cleanup, cleanup);
		return execution;
	}

	async #performAgentSessionCleanup(
		sessionId: string,
		attemptCount: number,
	): Promise<AgentSessionCleanupAttemptOutcome> {
		if (this.#agentSessionCleanupOperations.has(sessionId)) {
			return "ineligible";
		}
		if (this.#agentSessionCleanupOperations.size >= this.#agentSessionCleanupMaxInFlightAttempts) {
			return this.#recordAgentSessionCleanupFailure(
				sessionId,
				attemptCount,
				new Error("Agent session cleanup attempt capacity is temporarily exhausted."),
			);
		}

		const controller = new AbortController();
		let operation: Promise<void>;
		try {
			operation = Promise.resolve(this.#runtime.deleteThread(sessionId, controller.signal));
		} catch (error) {
			operation = Promise.reject(error);
		}
		this.#agentSessionCleanupOperations.set(sessionId, operation);
		const releaseOperation = (): void => {
			if (this.#agentSessionCleanupOperations.get(sessionId) === operation) {
				this.#agentSessionCleanupOperations.delete(sessionId);
			}
			this.#wakeAgentSessionCleanupRetry();
		};
		void operation.then(releaseOperation, releaseOperation);

		try {
			await this.#waitForAgentSessionCleanupOperation(operation, controller);
			if (this.#shuttingDown) {
				return "stopped";
			}
			this.#runs.ackAgentSessionCleanup(sessionId);
			this.#clearAgentSessionCleanupRetryStatePersistenceBackoff();
			return "succeeded";
		} catch (error) {
			if (this.#shuttingDown || error instanceof AgentSessionCleanupShutdownError) {
				return "stopped";
			}
			return this.#recordAgentSessionCleanupFailure(sessionId, attemptCount, error);
		}
	}

	#waitForAgentSessionCleanupOperation(
		operation: Promise<void>,
		controller: AbortController,
	): Promise<void> {
		if (this.#shuttingDown) {
			controller.abort(new AgentSessionCleanupShutdownError());
			return Promise.reject(new AgentSessionCleanupShutdownError());
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
				const error = new AgentSessionCleanupShutdownError();
				controller.abort(error);
				finish(error);
			};
			const timer = setTimeout(() => {
				const error = new Error(
					`Agent session cleanup attempt exceeded ${this.#agentSessionCleanupAttemptTimeoutMs}ms.`,
				);
				controller.abort(error);
				finish(error);
			}, this.#agentSessionCleanupAttemptTimeoutMs);
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

	#recordAgentSessionCleanupFailure(
		sessionId: string,
		attemptCount: number,
		error: unknown,
	): Exclude<AgentSessionCleanupAttemptOutcome, "succeeded"> {
		if (this.#shuttingDown) {
			return "stopped";
		}
		const backoffMs = Math.min(
			this.#agentSessionCleanupRetryMaxMs,
			this.#agentSessionCleanupRetryBaseMs * 2 ** Math.min(attemptCount, 16),
		);
		try {
			const nowMs = this.#runs.getReplayCursorSupport().serverTimeMs;
			this.#runs.recordAgentSessionCleanupFailure(
				sessionId,
				error instanceof Error ? error.message : String(error),
				nowMs + backoffMs,
			);
			this.#clearAgentSessionCleanupRetryStatePersistenceBackoff();
		} catch (recordError) {
			const persistenceBackoffMs = this.#setAgentSessionCleanupRetryStatePersistenceBackoff();
			this.#logger.error(
				`Failed to record agent session cleanup retry for deleted Session ${sessionId}; pausing cleanup retries for ${persistenceBackoffMs}ms.`,
				recordError,
			);
			return "retry-state-persistence-failed";
		}
		this.#logger.error(`Agent session cleanup failed for deleted Session ${sessionId}.`, error);
		return "failed";
	}

	#setAgentSessionCleanupRetryStatePersistenceBackoff(): number {
		this.#agentSessionRetryStatePersistenceFailureCount += 1;
		const backoffMs = Math.min(
			this.#agentSessionCleanupRetryMaxMs,
			this.#agentSessionCleanupRetryBaseMs *
				2 ** Math.min(this.#agentSessionRetryStatePersistenceFailureCount - 1, 16),
		);
		this.#agentSessionRetryStatePersistenceBackoffUntilMs = Math.max(
			this.#agentSessionRetryStatePersistenceBackoffUntilMs,
			Date.now() + backoffMs,
		);
		return backoffMs;
	}

	#clearAgentSessionCleanupRetryStatePersistenceBackoff(): void {
		if (
			this.#agentSessionRetryStatePersistenceFailureCount === 0 &&
			this.#agentSessionRetryStatePersistenceBackoffUntilMs === 0
		) {
			return;
		}
		this.#agentSessionRetryStatePersistenceFailureCount = 0;
		this.#agentSessionRetryStatePersistenceBackoffUntilMs = 0;
		this.#wakeAgentSessionCleanupRetry(true);
	}

	#ensureAgentSessionCleanupWorker(): void {
		if (this.#shuttingDown || this.#agentSessionWorkerExecution !== undefined) {
			return;
		}
		if (
			this.#agentSessionRetryStatePersistenceBackoffUntilMs <= Date.now() &&
			this.#runs.listPendingAgentSessionCleanups(1, true).length === 0
		) {
			return;
		}
		const execution = this.#runAgentSessionCleanupWorker();
		this.#agentSessionWorkerExecution = execution;
		this.#agentSessionCleanupExecutions.add(execution);
		const cleanup = (): void => {
			if (this.#agentSessionWorkerExecution === execution) {
				this.#agentSessionWorkerExecution = undefined;
			}
			this.#agentSessionCleanupExecutions.delete(execution);
		};
		void execution.then(cleanup, cleanup);
	}

	async #runAgentSessionCleanupWorker(): Promise<void> {
		while (!this.#shuttingDown) {
			await this.#waitForAgentSessionCleanupRetryStatePersistenceBackoff();
			if (this.#shuttingDown) {
				return;
			}
			const dueJobs = this.#runs.listPendingAgentSessionCleanups(
				agentSessionCleanupStartupBatchSize,
				false,
			);
			const jobs = dueJobs.filter(
				(job) =>
					!this.#agentSessionCleanupOperations.has(job.sessionId) &&
					!this.#agentSessionCleanupAttempts.has(job.sessionId),
			);
			if (jobs.length > 0) {
				for (const job of jobs) {
					if (this.#shuttingDown) {
						return;
					}
					const attempt = this.#getOrStartAgentSessionCleanup(job.sessionId, job.attemptCount);
					const outcome = await this.#waitForAgentSessionCleanupAttempt(attempt);
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
				await this.#waitForAgentSessionCleanupRetry(this.#agentSessionCleanupRetryMaxMs);
				continue;
			}
			const next = this.#runs.listPendingAgentSessionCleanups(1, true)[0];
			if (next === undefined) {
				return;
			}
			const nowMs = this.#runs.getReplayCursorSupport().serverTimeMs;
			await this.#waitForAgentSessionCleanupRetry(Math.max(1, next.nextAttemptAtMs - nowMs));
		}
	}

	#listEligibleAgentSessionCleanupJobs(
		limit: number,
		includeDeferred: boolean,
	): ReturnType<RunJournalRepository["listPendingAgentSessionCleanups"]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxAgentSessionCleanupBatchSize) {
			throw new Error(
				`Agent session cleanup batch limit must be between 1 and ${maxAgentSessionCleanupBatchSize}.`,
			);
		}
		return this.#runs
			.listPendingAgentSessionCleanups(maxAgentSessionCleanupBatchSize, includeDeferred)
			.filter(
				(job) =>
					!this.#agentSessionCleanupOperations.has(job.sessionId) &&
					!this.#agentSessionCleanupAttempts.has(job.sessionId),
			)
			.slice(0, limit);
	}

	async #waitForAgentSessionCleanupRetryStatePersistenceBackoff(): Promise<void> {
		while (!this.#shuttingDown) {
			const delayMs = this.#agentSessionRetryStatePersistenceBackoffUntilMs - Date.now();
			if (delayMs <= 0) {
				return;
			}
			await this.#waitForAgentSessionCleanupRetry(delayMs, false);
		}
	}

	#waitForAgentSessionCleanupAttempt(
		execution: Promise<AgentSessionCleanupAttemptOutcome>,
		deadline?: number,
	): Promise<AgentSessionCleanupAttemptOutcome | undefined> {
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
		return new Promise<AgentSessionCleanupAttemptOutcome | undefined>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: AgentSessionCleanupAttemptOutcome | undefined): void => {
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

	#waitForAgentSessionCleanupRetry(delayMs: number, wakeable = true): Promise<void> {
		if (this.#shuttingDown) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const finish = (): void => {
				if (this.#agentSessionRetryWait?.resolve === finish) {
					this.#agentSessionRetryWait = undefined;
				}
				resolve();
			};
			const timer = setTimeout(finish, Math.min(delayMs, 2_147_483_647));
			this.#agentSessionRetryWait = { timer, resolve: finish, wakeable };
		});
	}

	#wakeAgentSessionCleanupRetry(force = false): void {
		const wait = this.#agentSessionRetryWait;
		if (wait === undefined || (!force && !wait.wakeable)) {
			return;
		}
		clearTimeout(wait.timer);
		wait.resolve();
	}

	async #executeRun(activeRun: ActiveChatRun): Promise<void> {
		try {
			this.#assertRuntimeReady(activeRun.runtimeBoxId);
			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}
			const runtimeResources =
				this.#resolveRuntimeResources === undefined
					? { skills: [], mcpResources: [] }
					: await this.#resolveRuntimeResources(
							activeRun.runtimeBoxId,
							activeRun.abortController.signal,
						);
			if (this.#resolveRuntimeResources !== undefined) {
				this.#throwIfRunFenced(activeRun);
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
				threadId: activeRun.agentSessionId,
				runtimeBoxId: activeRun.runtimeBoxId,
				provider: activeRun.provider,
				messages: activeRun.messages,
				skills: runtimeResources.skills,
				mcpResources: runtimeResources.mcpResources,
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
		if (!record.enabled || model === undefined || !model.enabled) {
			throw new ProviderModelNotFoundError(providerId, modelId);
		}
		return model;
	}

	#normalizeSelection(selection: {
		providerId: string;
		modelId: string;
		thinkingLevel?: DefaultModelSelection["thinkingLevel"];
	}): DefaultModelSelection {
		const model = this.#requireProviderModel(selection.providerId, selection.modelId);
		if (
			selection.thinkingLevel !== undefined &&
			!model.thinkingLevels.includes(selection.thinkingLevel)
		) {
			throw new TypeError("The selected thinking level is not supported by this model.");
		}
		return {
			providerId: selection.providerId,
			modelId: selection.modelId,
			...(selection.thinkingLevel === undefined ? {} : { thinkingLevel: selection.thinkingLevel }),
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
			return {
				providerId: record.id,
				providerName: record.displayName,
				source: record.source,
				api: model.api,
				model: model.id,
				...(candidate.thinkingLevel === undefined ||
				!model.thinkingLevels.includes(candidate.thinkingLevel)
					? {}
					: { thinkingLevel: candidate.thinkingLevel }),
			};
		}

		throw new AskChatRuntimeError({
			kind: "not_configured",
			message: "No Provider and model are selected for this chat.",
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

	#assertRuntimeReady(runtimeBoxId: string): void {
		if (!this.#isRuntimeReady(runtimeBoxId)) {
			throw new AskChatRuntimeError({
				kind: "runtime_box_unavailable",
				message: "The active Runtime Box is not authenticated and ready.",
				retryable: true,
			});
		}
	}

	#assertSessionRuntimeReady(sessionId: string): void {
		this.#assertRuntimeReady(this.#sessions.get({ sessionId }).runtimeBoxId);
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

class AgentSessionCleanupShutdownError extends Error {
	constructor() {
		super("Agent session cleanup stopped during application shutdown.");
		this.name = "AgentSessionCleanupShutdownError";
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
	runtime_box_unavailable: {
		code: "RUNTIME_BOX_UNAVAILABLE",
		category: "runtime",
		messageKey: "errors.runtimeBoxUnavailable",
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
	unexpected_tool_activity: {
		code: "CHAT_UNEXPECTED_TOOL_ACTIVITY",
		category: "tool",
		messageKey: "errors.chatUnexpectedToolActivity",
	},
};
