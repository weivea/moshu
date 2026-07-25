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
import { type ChatRepository, createUuidV7 } from "@moshu/database";

const DEFAULT_PROVIDER_BASE_URL = "https://api.openai.com/v1";

type ChatEventListener = (event: ChatRunEvent) => void;
type ChatTaskScheduler = (task: () => void) => void;
type ProviderConnectionTester = (configuration: AskProviderConfiguration) => Promise<void>;

interface ChatServiceLogger {
	error(message: string, error: unknown): void;
}

export interface DesktopChatServiceOptions {
	repository: ChatRepository;
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
	cancelRequested: boolean;
}

export class DesktopChatService {
	readonly #repository: ChatRepository;
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
		this.#repository = options.repository;
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
		return this.#repository.createSession({
			title: "New chat",
			defaultMode: "ask",
		});
	}

	listSessions(input: ListChatSessionsInput = {}): ListChatSessionsOutput {
		return this.#repository.listSessions(listChatSessionsInputSchema.parse(input));
	}

	updateSession(input: UpdateChatSessionInput): UpdateChatSessionOutput {
		return this.#repository.updateSession(updateChatSessionInputSchema.parse(input));
	}

	setSessionArchived(input: SetChatSessionArchivedInput): SetChatSessionArchivedOutput {
		const parsedInput = setChatSessionArchivedInputSchema.parse(input);
		if (parsedInput.archived) {
			this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		}
		return this.#repository.setSessionArchived(parsedInput);
	}

	deleteSession(input: DeleteChatSessionInput): DeleteChatSessionOutput {
		const parsedInput = deleteChatSessionInputSchema.parse(input);
		this.#assertSessionCanBeRemovedFromActiveList(parsedInput.sessionId);
		return this.#repository.deleteSession(parsedInput);
	}

	getSession(input: GetChatSessionInput): GetChatSessionOutput {
		return this.#repository.getSession(getChatSessionInputSchema.parse(input));
	}

	getSessionSnapshot(input: GetChatSessionInput): GetChatSessionSnapshotOutput {
		return getChatSessionSnapshotOutputSchema.parse(
			this.#repository.getSessionSnapshot(getChatSessionInputSchema.parse(input)),
		);
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

		const currentSession = this.#repository.getSession({ sessionId: input.sessionId });
		if (currentSession.session.archivedAt !== undefined) {
			throw new AskChatRuntimeError({
				kind: "provider_failure",
				message: "Archived chat Sessions cannot send new messages.",
				retryable: false,
			});
		}
		if (currentSession.messages.length === 0 && currentSession.session.title === "New chat") {
			this.#repository.updateSession({
				sessionId: input.sessionId,
				title: createSessionTitle(input.content),
			});
		}

		const sendResult = this.#repository.createUserMessageRun({
			sessionId: input.sessionId,
			content: input.content,
			mode: "ask",
			provider: {
				schemaVersion: 1,
				providerId: this.#providerId,
				name: provider.baseUrl === DEFAULT_PROVIDER_BASE_URL ? "OpenAI" : "OpenAI-compatible",
				baseUrl: provider.baseUrl ?? DEFAULT_PROVIDER_BASE_URL,
				model: provider.model,
				apiKey: provider.apiKey,
			},
		});
		const assistant = this.#repository.createAssistantMessage({
			runId: sendResult.run.id,
		});
		const snapshot = this.#repository.getSession({ sessionId: input.sessionId });
		const activeRun: ActiveChatRun = {
			runId: sendResult.run.id,
			sessionId: input.sessionId,
			assistantMessageId: assistant.message.id,
			messages: snapshot.messages
				.filter(
					(message) =>
						message.id !== assistant.message.id &&
						(message.role === "user" || message.status === "complete"),
				)
				.map((message) => ({
					role: message.role,
					content: message.content,
				})),
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

		return chatSendAcceptedOutputSchema.parse({
			run: sendResult.run,
			userMessage: sendResult.userMessage,
			assistantMessage: assistant.message,
		});
	}

	cancel(input: CancelChatRunInput): CancelChatRunOutput {
		const activeRun = this.#activeRuns.get(input.runId);
		if (activeRun !== undefined) {
			activeRun.cancelRequested = true;
		}

		const result = this.#repository.cancelRun(input);
		if (result.run.status === "completed" || result.run.status === "failed") {
			return result;
		}

		if (result.run.status === "cancelled") {
			if (activeRun !== undefined) {
				this.#emitLatestEvent(result.run.id);
				const message = this.#repository.getMessage({
					sessionId: activeRun.sessionId,
					messageId: activeRun.assistantMessageId,
				});
				if (message.status === "streaming") {
					const cancelledMessage = this.#repository.cancelAssistantMessage({
						runId: activeRun.runId,
						messageId: activeRun.assistantMessageId,
					});
					this.#emit(cancelledMessage.event);
				}
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

			const running = this.#repository.updateRunStatus({
				runId: activeRun.runId,
				status: "running",
			});
			this.#emit(running.event);

			const result = await this.#runtime.run({
				runId: activeRun.runId,
				threadId: activeRun.sessionId,
				messages: activeRun.messages,
				onEvent: async (event) => {
					const mutation = this.#repository.appendAssistantMessageDelta({
						runId: activeRun.runId,
						messageId: activeRun.assistantMessageId,
						delta: event.delta,
					});
					this.#emit(mutation.event);
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

			const completedMessage = this.#repository.completeAssistantMessage({
				runId: activeRun.runId,
				messageId: activeRun.assistantMessageId,
				content: result.text,
			});
			this.#emit(completedMessage.event);

			const completedRun = this.#repository.updateRunStatus({
				runId: activeRun.runId,
				status: "completed",
			});
			this.#emit(completedRun.event);
		} catch (error) {
			if (isCancellation(error) || activeRun.cancelRequested) {
				await this.#finishCancelledRun(activeRun);
				return;
			}

			const failed = this.#repository.failRun({
				runId: activeRun.runId,
				messageId: activeRun.assistantMessageId,
				error: toAppError(error, activeRun.runId),
			});
			for (const event of failed.events) {
				this.#emit(event);
			}
		} finally {
			this.#releaseRun(activeRun);
		}
	}

	async #finishCancelledRun(activeRun: ActiveChatRun): Promise<void> {
		const snapshot = this.#repository.getSession({ sessionId: activeRun.sessionId });
		const message = snapshot.messages.find(
			(candidate) => candidate.id === activeRun.assistantMessageId,
		);
		if (message?.status === "streaming") {
			const cancelledMessage = this.#repository.cancelAssistantMessage({
				runId: activeRun.runId,
				messageId: activeRun.assistantMessageId,
			});
			this.#emit(cancelledMessage.event);
		}

		let run = findRun(snapshot.runs, activeRun.runId);
		if (run.status === "queued" || run.status === "running") {
			run = this.#repository.cancelRun({
				runId: activeRun.runId,
				reason: "Chat response cancelled.",
			}).run;
			this.#emitLatestEvent(run.id);
		}

		if (run.status === "cancelling") {
			const cancelledRun = this.#repository.updateRunStatus({
				runId: activeRun.runId,
				status: "cancelled",
			});
			this.#emit(cancelledRun.event);
		}

		await Promise.resolve();
	}

	#emitLatestEvent(runId: string): void {
		const events = this.#repository.replayRunEvents({ runId });
		const event = events.at(-1);
		if (event !== undefined) {
			this.#emit(event);
		}
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

		const snapshot = this.#repository.getSession({ sessionId });
		for (const run of snapshot.runs) {
			if (
				(run.status === "queued" || run.status === "running" || run.status === "cancelling") &&
				!this.#activeRuns.has(run.id)
			) {
				this.#finalizeOrphanedRun(run);
			}
		}

		const hasRemainingActiveRun = this.#repository
			.getSession({ sessionId })
			.runs.some(
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
			currentRun = this.#repository.cancelRun({
				runId: currentRun.id,
				reason: "The application restarted before this response completed.",
			}).run;
			this.#emitLatestEvent(currentRun.id);
		}

		if (currentRun.assistantMessageId !== undefined) {
			const message = this.#repository.getMessage({
				sessionId: currentRun.sessionId,
				messageId: currentRun.assistantMessageId,
			});
			if (message.status === "streaming") {
				const cancelledMessage = this.#repository.cancelAssistantMessage({
					runId: currentRun.id,
					messageId: currentRun.assistantMessageId,
				});
				this.#emit(cancelledMessage.event);
			}
		}

		if (currentRun.status === "cancelling") {
			const cancelledRun = this.#repository.updateRunStatus({
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

function findRun(runs: ChatRun[], runId: string): ChatRun {
	const run = runs.find((candidate) => candidate.id === runId);
	if (run === undefined) {
		throw new Error(`Chat run ${runId} was not found.`);
	}
	return run;
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
