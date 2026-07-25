import {
	AskChatCancelledError,
	AskChatRuntimeError,
	type AskChatMessage,
	type AskChatRuntime,
	type AskProviderConfiguration,
	type AskProviderConfigStore,
	normalizeAskProviderConfiguration,
} from "@moshu/agent-runtime";
import {
	appErrorSchema,
	type AppError,
	type CancelChatRunInput,
	type CancelChatRunOutput,
	type ChatProviderStatus,
	type ChatMessage,
	chatMessageSchema,
	type ChatRun,
	type ChatRunEvent,
	type ChatSendAcceptedOutput,
	chatProviderStatusSchema,
	chatSendAcceptedOutputSchema,
	type ConfigureChatProviderInput,
	configureChatProviderInputSchema,
	type CreateChatSessionOutput,
	type DeleteChatSessionInput,
	type DeleteChatSessionOutput,
	deleteChatSessionInputSchema,
	type GetChatSessionInput,
	type GetChatSessionOutput,
	type GetChatSessionSnapshotOutput,
	getChatSessionSnapshotOutputSchema,
	getChatSessionInputSchema,
	type ListChatSessionsInput,
	type ListChatSessionsOutput,
	listChatSessionsInputSchema,
	type SetChatSessionArchivedInput,
	type SetChatSessionArchivedOutput,
	setChatSessionArchivedInputSchema,
	type TestChatProviderInput,
	type TestChatProviderOutput,
	testChatProviderInputSchema,
	testChatProviderOutputSchema,
	type UpdateChatSessionInput,
	type UpdateChatSessionOutput,
	updateChatSessionInputSchema,
} from "@moshu/contracts";
import { createUuidV7, type RunJournalRepository, type SessionRepository } from "@moshu/database";

const DEFAULT_PROVIDER_BASE_URL = "https://api.openai.com/v1";

type ChatEventListener = (event: ChatRunEvent) => void;
type ChatTaskScheduler = (task: () => void) => void;
type ProviderConnectionTester = (configuration: AskProviderConfiguration) => Promise<void>;

interface ChatServiceLogger {
	error(message: string, error: unknown): void;
}

export interface DesktopChatServiceOptions {
	sessions: SessionRepository;
	runs: RunJournalRepository;
	providerConfigStore: AskProviderConfigStore;
	runtime: AskChatRuntime;
	schedule?: ChatTaskScheduler;
	logger?: ChatServiceLogger;
	testProviderConnection?: ProviderConnectionTester;
}

export interface SendDesktopChatMessageInput {
	sessionId: string;
	content: string;
}

interface ActiveChatRun {
	runId: string;
	sessionId: string;
	assistantMessageId: string;
	messages: AskChatMessage[];
	partialAssistantContent: string;
	cancelRequested: boolean;
}

export class DesktopChatService {
	readonly #sessions: SessionRepository;
	readonly #runs: RunJournalRepository;
	readonly #providerConfigStore: AskProviderConfigStore;
	readonly #runtime: AskChatRuntime;
	readonly #schedule: ChatTaskScheduler;
	readonly #logger: ChatServiceLogger;
	readonly #testProviderConnection: ProviderConnectionTester;
	readonly #providerId = createUuidV7();
	readonly #listeners = new Set<ChatEventListener>();
	readonly #activeRuns = new Map<string, ActiveChatRun>();
	readonly #activeSessions = new Map<string, string>();
	readonly #executions = new Set<Promise<void>>();

	constructor(options: DesktopChatServiceOptions) {
		this.#sessions = options.sessions;
		this.#runs = options.runs;
		this.#providerConfigStore = options.providerConfigStore;
		this.#runtime = options.runtime;
		this.#schedule = options.schedule ?? ((task) => setTimeout(task, 0));
		this.#logger = options.logger ?? console;
		this.#testProviderConnection = options.testProviderConnection ?? testOpenAiCompatibleProvider;
	}

	subscribe(listener: ChatEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getProviderStatus(): ChatProviderStatus {
		const status = this.#providerConfigStore.getStatus();

		return chatProviderStatusSchema.parse({
			schemaVersion: 1,
			configured: status.configured,
			baseUrl: status.baseUrl ?? DEFAULT_PROVIDER_BASE_URL,
			model: status.model ?? "",
			...(status.apiKeyMask === undefined ? {} : { apiKeyMask: status.apiKeyMask }),
		});
	}

	configureProvider(input: ConfigureChatProviderInput): ChatProviderStatus {
		const parsedInput = configureChatProviderInputSchema.parse(input);
		this.#assertProviderCanChange();
		const apiKey = this.#resolveApiKey(
			parsedInput.baseUrl,
			parsedInput.apiKey,
			"configure the Provider",
		);
		this.#providerConfigStore.set({
			provider: "openai-compatible",
			apiKey,
			baseUrl: parsedInput.baseUrl,
			model: parsedInput.model,
		});

		return this.getProviderStatus();
	}

	async testProvider(input: TestChatProviderInput): Promise<TestChatProviderOutput> {
		const startedAt = Date.now();

		try {
			const configuration = this.#resolveProviderConfiguration(
				testChatProviderInputSchema.parse(input),
			);
			await this.#testProviderConnection(configuration);
			return testChatProviderOutputSchema.parse({
				schemaVersion: 1,
				ok: true,
				latencyMs: Date.now() - startedAt,
			});
		} catch (error) {
			return testChatProviderOutputSchema.parse({
				schemaVersion: 1,
				ok: false,
				latencyMs: Date.now() - startedAt,
				error: toAppError(error, "provider-connection-test"),
			});
		}
	}

	deleteProvider(): ChatProviderStatus {
		this.#assertProviderCanChange();
		this.#providerConfigStore.clear();
		return this.getProviderStatus();
	}

	createSession(): CreateChatSessionOutput {
		return this.#sessions.create({
			title: "New chat",
			defaultMode: "ask",
		});
	}

	listSessions(input: ListChatSessionsInput = {}): ListChatSessionsOutput {
		return this.#sessions.list(listChatSessionsInputSchema.parse(input));
	}

	updateSession(input: UpdateChatSessionInput): UpdateChatSessionOutput {
		return this.#sessions.update(updateChatSessionInputSchema.parse(input));
	}

	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		if (parsedInput.archived) {
			this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		}
		return this.#sessions.setArchived(parsedInput);
	}

	deleteSession(input: DeleteChatSessionInput): Promise<DeleteChatSessionOutput> {
		const parsedInput = deleteChatSessionInputSchema.parse(input);
		this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		return this.#runtime
			.deleteThread(parsedInput.sessionId)
			.then(() => this.#sessions.delete(parsedInput));
	}

	async getSession(input: GetChatSessionInput): Promise<GetChatSessionOutput> {
		const parsedInput = getChatSessionInputSchema.parse(input);
		const session = this.#sessions.get(parsedInput);
		const runs = this.#runs.listBySession(parsedInput.sessionId);
		const messages = await this.#buildSessionMessages(parsedInput.sessionId, runs);
		return { session, messages, runs };
	}

	async getSessionSnapshot(input: GetChatSessionInput): Promise<GetChatSessionSnapshotOutput> {
		const parsedInput = getChatSessionInputSchema.parse(input);
		const snapshot = await this.getSession(parsedInput);
		return getChatSessionSnapshotOutputSchema.parse({
			...snapshot,
			eventCursors: snapshot.runs.map((run) => ({
				runId: run.id,
				lastSeq: this.#runs.listEvents({ runId: run.id }).at(-1)?.seq ?? 0,
			})),
		});
	}

	sendMessage(input: SendDesktopChatMessageInput): ChatSendAcceptedOutput {
		const provider = this.#providerConfigStore.get();
		if (provider === null) {
			throw new AskChatRuntimeError({
				kind: "not_configured",
				message: "Ask provider is not configured.",
				retryable: false,
			});
		}

		if (this.#activeSessions.has(input.sessionId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "This chat already has an active response.",
				retryable: false,
			});
		}

		const currentSession = this.#sessions.get({ sessionId: input.sessionId });
		const existingRuns = this.#runs.listBySession(input.sessionId);
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

		const userMessageId = createUuidV7();
		const assistantMessageId = createUuidV7();
		const created = this.#runs.create({
			sessionId: input.sessionId,
			mode: "ask",
			provider: {
				schemaVersion: 1,
				providerId: this.#providerId,
				name: provider.baseUrl === DEFAULT_PROVIDER_BASE_URL ? "OpenAI" : "OpenAI-compatible",
				baseUrl: provider.baseUrl ?? DEFAULT_PROVIDER_BASE_URL,
				model: provider.model,
				apiKey: provider.apiKey,
			},
			userMessageId,
			assistantMessageId,
		});
		this.#runs.appendEvent({
			runId: created.run.id,
			type: "message.started",
			source: { kind: "assistant" },
			payload: {
				messageId: assistantMessageId,
				role: "assistant",
				status: "streaming",
			},
		});
		const activeRun: ActiveChatRun = {
			runId: created.run.id,
			sessionId: input.sessionId,
			assistantMessageId,
			messages: [{ role: "user", content: input.content, id: userMessageId }],
			partialAssistantContent: "",
			cancelRequested: false,
		};

		this.#activeRuns.set(activeRun.runId, activeRun);
		this.#activeSessions.set(activeRun.sessionId, activeRun.runId);
		this.#schedule(() => {
			if (this.#activeRuns.get(activeRun.runId) !== activeRun) {
				return;
			}

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
	}

	cancel(input: CancelChatRunInput): CancelChatRunOutput {
		const activeRun = this.#activeRuns.get(input.runId);
		if (activeRun !== undefined) {
			activeRun.cancelRequested = true;
		}

		const result = this.#runs.cancel(input);
		if (result.run.status === "completed" || result.run.status === "failed") {
			return result;
		}

		if (result.run.status === "cancelled") {
			if (activeRun !== undefined) {
				this.#emitLatestEvent(result.run.id);
				this.#emit(this.#appendAssistantTerminalEvent(activeRun, "cancelled"));
				this.#releaseRun(activeRun);
			} else {
				this.#emitLatestEvent(result.run.id);
				return {
					run: this.#finalizeOrphanedRun(result.run),
				};
			}
			return result;
		}

		this.#emitLatestEvent(result.run.id);
		const runtimeCancelled = this.#runtime.cancel(input.runId, input.reason);
		if (!runtimeCancelled && activeRun === undefined) {
			return {
				run: this.#finalizeOrphanedRun(result.run),
			};
		}
		return result;
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.#executions]);
	}

	async shutdown(): Promise<void> {
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

		await this.#runtime.shutdown();
		await this.waitForIdle();
	}

	async #executeRun(activeRun: ActiveChatRun): Promise<void> {
		try {
			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			const running = this.#runs.updateStatus({
				runId: activeRun.runId,
				status: "running",
			});
			this.#emit(running.event);

			const result = await this.#runtime.run({
				runId: activeRun.runId,
				threadId: activeRun.sessionId,
				messages: activeRun.messages,
				onEvent: async (event) => {
					activeRun.partialAssistantContent += event.delta;
					const persistedEvent = this.#runs.appendEvent({
						runId: activeRun.runId,
						type: "message.delta",
						source: { kind: "assistant" },
						payload: {
							messageId: activeRun.assistantMessageId,
							delta: event.delta,
						},
					});
					this.#emit(persistedEvent);
				},
			});

			if (activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
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

			activeRun.partialAssistantContent = result.text;
			this.#emit(this.#appendAssistantTerminalEvent(activeRun, "complete"));

			const completedRun = this.#runs.updateStatus({
				runId: activeRun.runId,
				status: "completed",
			});
			this.#emit(completedRun.event);
		} catch (error) {
			if (isCancellation(error) || activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			const failed = this.#runs.fail({
				runId: activeRun.runId,
				error: toAppError(error, activeRun.runId),
				messageEvent: {
					messageId: activeRun.assistantMessageId,
					content: activeRun.partialAssistantContent,
				},
			});
			for (const event of failed.events) {
				this.#emit(event);
			}
		} finally {
			this.#releaseRun(activeRun);
		}
	}

	async #finishCancelledRun(activeRun: ActiveChatRun): Promise<void> {
		this.#emit(this.#appendAssistantTerminalEvent(activeRun, "cancelled"));
		let run = this.#runs.get(activeRun.runId);
		if (run.status === "queued" || run.status === "running") {
			run = this.#runs.cancel({
				runId: activeRun.runId,
				reason: "Chat response cancelled.",
			}).run;
			this.#emitLatestEvent(run.id);
		}

		if (run.status === "cancelling") {
			const cancelledRun = this.#runs.updateStatus({
				runId: activeRun.runId,
				status: "cancelled",
			});
			this.#emit(cancelledRun.event);
		}

		await Promise.resolve();
	}

	#emitLatestEvent(runId: string): void {
		const events = this.#runs.listEvents({ runId });
		const event = events.at(-1);
		if (event !== undefined) {
			this.#emit(event);
		}
	}

	#appendAssistantTerminalEvent(
		activeRun: ActiveChatRun,
		status: "complete" | "cancelled",
	): ChatRunEvent {
		return this.#appendTerminalEvent(
			this.#runs.get(activeRun.runId),
			status,
			activeRun.partialAssistantContent,
		);
	}

	#appendTerminalEvent(
		run: ChatRun,
		status: "complete" | "cancelled",
		content: string,
	): ChatRunEvent {
		const existing = this.#runs
			.listEvents({ runId: run.id })
			.find((event) => event.type === "message.completed");
		if (existing !== undefined) {
			return existing;
		}
		if (run.assistantMessageId === undefined) {
			throw new Error(`Run ${run.id} is missing its assistant message ID.`);
		}

		return this.#runs.appendEvent({
			runId: run.id,
			type: "message.completed",
			source: { kind: "assistant" },
			payload: {
				messageId: run.assistantMessageId,
				status,
				content,
			},
		});
	}

	async #buildSessionMessages(sessionId: string, runs: ChatRun[]): Promise<ChatMessage[]> {
		const checkpointMessages = await this.#runtime.getThreadMessages(sessionId);
		const orderedRuns = [...runs].sort((left, right) =>
			left.createdAt.localeCompare(right.createdAt),
		);
		const messages: ChatMessage[] = [];

		for (const run of orderedRuns) {
			const activeRun = this.#activeRuns.get(run.id);
			const userIndex = checkpointMessages.findIndex(
				(message) => message.role === "user" && message.id === run.userMessageId,
			);
			const checkpointUser = userIndex < 0 ? undefined : checkpointMessages[userIndex];
			const activeUser = activeRun?.messages.find((message) => message.role === "user");
			const userContent = checkpointUser?.content ?? activeUser?.content;
			const sequence = messages.length + 1;
			if (userContent !== undefined) {
				messages.push(createUserMessage(run, userContent, sequence));
			}

			const events = this.#runs.listEvents({ runId: run.id });
			const terminalEvent = events.findLast((event) => event.type === "message.completed");
			const checkpointAssistant =
				userIndex < 0
					? undefined
					: checkpointMessages.slice(userIndex + 1).find((message) => message.role === "assistant");
			const streamedContent = events.reduce((content, event) => {
				return event.type === "message.delta" ? `${content}${event.payload.delta}` : content;
			}, "");
			const assistantSequence = messages.length + 1;

			if (run.status === "completed") {
				const content =
					checkpointAssistant?.content ??
					(terminalEvent?.type === "message.completed" ? terminalEvent.payload.content : "");
				if (content.length > 0) {
					messages.push(createAssistantMessage(run, "complete", content, assistantSequence));
				}
				continue;
			}

			if (run.status === "failed") {
				const content =
					terminalEvent?.type === "message.completed"
						? terminalEvent.payload.content
						: streamedContent;
				messages.push(
					createAssistantMessage(run, "failed", content, assistantSequence, run.lastError),
				);
				continue;
			}

			if (run.status === "cancelled") {
				const content =
					terminalEvent?.type === "message.completed"
						? terminalEvent.payload.content
						: streamedContent;
				messages.push(createAssistantMessage(run, "cancelled", content, assistantSequence));
				continue;
			}

			messages.push(
				createAssistantMessage(
					run,
					"streaming",
					activeRun?.partialAssistantContent ?? streamedContent,
					assistantSequence,
				),
			);
		}

		return messages;
	}

	#emit(event: ChatRunEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				this.#logger.error(`Failed to publish chat event ${event.id}.`, error);
			}
		}
	}

	#releaseRun(activeRun: ActiveChatRun): void {
		if (this.#activeRuns.get(activeRun.runId) === activeRun) {
			this.#activeRuns.delete(activeRun.runId);
		}
		if (this.#activeSessions.get(activeRun.sessionId) === activeRun.runId) {
			this.#activeSessions.delete(activeRun.sessionId);
		}
	}

	#resolveProviderConfiguration(input: TestChatProviderInput): AskProviderConfiguration {
		const apiKey = this.#resolveApiKey(input.baseUrl, input.apiKey, "test the Provider");

		return normalizeAskProviderConfiguration({
			provider: "openai-compatible",
			apiKey,
			baseUrl: input.baseUrl,
			model: input.model,
		});
	}

	#assertSessionCanBeRemovedFromActiveList(sessionId: string): void {
		if (this.#activeSessions.has(sessionId)) {
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

	#finalizeOrphanedRun(run: ChatRun): ChatRun {
		let currentRun = run;
		if (currentRun.status === "queued" || currentRun.status === "running") {
			currentRun = this.#runs.cancel({
				runId: currentRun.id,
				reason: "The application restarted before this response completed.",
			}).run;
			this.#emitLatestEvent(currentRun.id);
		}

		const partialContent = this.#runs
			.listEvents({ runId: currentRun.id })
			.reduce(
				(content, event) =>
					event.type === "message.delta" ? `${content}${event.payload.delta}` : content,
				"",
			);
		this.#emit(this.#appendTerminalEvent(currentRun, "cancelled", partialContent));

		if (currentRun.status === "cancelling") {
			const cancelledRun = this.#runs.updateStatus({
				runId: currentRun.id,
				status: "cancelled",
			});
			this.#emit(cancelledRun.event);
			currentRun = cancelledRun.run;
		}

		return currentRun;
	}

	#assertProviderCanChange(): void {
		if (this.#activeRuns.size > 0) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: "Stop active responses before changing the Provider configuration.",
				retryable: false,
			});
		}
	}

	#resolveApiKey(baseUrl: string, apiKey: string | undefined, action: string): string {
		if (apiKey !== undefined) {
			return apiKey;
		}

		const storedConfiguration = this.#providerConfigStore.get();
		if (
			storedConfiguration !== null &&
			new URL(storedConfiguration.baseUrl ?? DEFAULT_PROVIDER_BASE_URL).origin ===
				new URL(baseUrl).origin
		) {
			return storedConfiguration.apiKey;
		}

		throw new AskChatRuntimeError({
			kind: "not_configured",
			message: `A new API key is required to ${action} for a different Endpoint origin.`,
			retryable: false,
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

async function testOpenAiCompatibleProvider(
	configuration: AskProviderConfiguration,
): Promise<void> {
	const baseUrl = configuration.baseUrl ?? DEFAULT_PROVIDER_BASE_URL;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetch(`${baseUrl}/models`, {
			method: "GET",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${configuration.apiKey}`,
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
	return (
		error instanceof AskChatCancelledError ||
		(error instanceof AskChatRuntimeError && error.kind === "cancelled")
	);
}

function toAppError(error: unknown, runId: string): AppError {
	if (!(error instanceof AskChatRuntimeError)) {
		return appErrorSchema.parse({
			code: "CHAT_RUN_FAILED",
			category: "unknown",
			messageKey: "errors.chatRunFailed",
			safeMessage: "The chat response failed.",
			retryable: false,
			causeId: runId,
		});
	}

	const details = runtimeErrorDetails[error.kind];
	return appErrorSchema.parse({
		code: details.code,
		category: details.category,
		messageKey: details.messageKey,
		safeMessage: error.message,
		retryable: error.retryable,
		causeId: runId,
	});
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
};
