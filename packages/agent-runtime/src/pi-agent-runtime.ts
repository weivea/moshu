import { contentText, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type AgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { executorToolNames, type ThinkingLevel } from "@moshu/contracts";
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { ResolvedProviderConfiguration } from "./provider-registry";
import {
	assertExecutorToolDefinitions,
	createExecutorToolDefinitions,
	type ExecutorToolGateway,
} from "./executor-tools";

export interface AskChatMessage {
	role: "user" | "assistant";
	content: string;
	id?: string;
}

export interface AskChatUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface AskChatMessageDeltaEvent {
	type: "message.delta";
	runId: string;
	delta: string;
}

export interface AskChatRunInput {
	runId: string;
	threadId?: string;
	provider: ResolvedProviderConfiguration;
	messages: readonly AskChatMessage[];
	signal?: AbortSignal;
	onEvent?: (event: AskChatMessageDeltaEvent) => void | Promise<void>;
}

export interface AskChatRunResult {
	runId: string;
	text: string;
	usage?: AskChatUsage;
}

export interface AskChatRunStream extends AsyncIterable<AskChatMessageDeltaEvent> {
	readonly runId: string;
	readonly result: Promise<AskChatRunResult>;
	cancel(reason?: string): void;
}

export interface AskChatRuntime {
	run(input: AskChatRunInput): Promise<AskChatRunResult>;
	stream(input: AskChatRunInput): AskChatRunStream;
	cancel(runId: string, reason?: string): boolean;
	getThreadMessages(threadId: string): Promise<AskChatMessage[]>;
	deleteThread(threadId: string, signal?: AbortSignal): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AskChatRuntimeOptions {
	agentDataDirectory: string;
	modelRuntime: ModelRuntime;
	executorGateway: ExecutorToolGateway;
	workspaceDirectory?: string;
}

export type AskChatErrorKind =
	| "not_configured"
	| "duplicate_run_id"
	| "cancelled"
	| "provider_authentication"
	| "provider_rate_limited"
	| "provider_network"
	| "provider_model"
	| "provider_failure"
	| "thread_busy"
	| "runtime_shutdown"
	| "unexpected_tool_activity";

export class AskChatRuntimeError extends Error {
	readonly kind: AskChatErrorKind;
	readonly retryable: boolean;
	readonly runId: string | undefined;
	readonly statusCode: number | undefined;

	constructor(options: {
		kind: AskChatErrorKind;
		message: string;
		retryable: boolean;
		runId?: string;
		statusCode?: number;
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AskChatRuntimeError";
		this.kind = options.kind;
		this.retryable = options.retryable;
		this.runId = options.runId;
		this.statusCode = options.statusCode;
	}
}

export class AskChatCancelledError extends AskChatRuntimeError {
	readonly reason: string | undefined;

	constructor(runId: string, reason?: string) {
		super({
			kind: "cancelled",
			message: "Ask chat run was cancelled.",
			retryable: false,
			runId,
		});
		this.name = "AskChatCancelledError";
		this.reason = reason;
	}
}

interface ActiveRun {
	controller: AbortController;
	session?: AgentSession;
	reason: string | undefined;
}

export class PiAgentRuntime implements AskChatRuntime {
	readonly #modelRuntime: ModelRuntime;
	readonly #executorGateway: ExecutorToolGateway;
	readonly #agentDirectory: string;
	readonly #sessionDirectory: string;
	readonly #workspaceDirectory: string;
	readonly #activeRuns = new Map<string, ActiveRun>();
	readonly #activeThreads = new Set<string>();
	readonly #runIdByThread = new Map<string, string>();
	readonly #sessions = new Map<string, AgentSession>();
	#shuttingDown = false;

	constructor(options: AskChatRuntimeOptions) {
		this.#modelRuntime = options.modelRuntime;
		this.#executorGateway = options.executorGateway;
		this.#agentDirectory = resolve(options.agentDataDirectory);
		this.#sessionDirectory = join(this.#agentDirectory, "sessions");
		this.#workspaceDirectory = resolve(
			options.workspaceDirectory ?? join(this.#agentDirectory, "workspace"),
		);
		mkdirSync(this.#agentDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(this.#sessionDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(this.#workspaceDirectory, { recursive: true, mode: 0o700 });
	}

	run(input: AskChatRunInput): Promise<AskChatRunResult> {
		return this.#start(input, input.onEvent);
	}

	stream(input: AskChatRunInput): AskChatRunStream {
		const queue = new AsyncEventQueue<AskChatMessageDeltaEvent>();
		const result = this.#start(input, async (event) => {
			queue.push(event);
			await input.onEvent?.(event);
		});
		void result.then(
			() => queue.close(),
			(error: unknown) => queue.fail(error),
		);
		return {
			runId: input.runId,
			result,
			cancel: (reason) => {
				this.cancel(input.runId, reason);
			},
			[Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
		};
	}

	cancel(runId: string, reason?: string): boolean {
		const active = this.#activeRuns.get(runId);
		if (active === undefined) {
			return false;
		}
		active.reason = reason;
		active.controller.abort(new AskChatCancelledError(runId, reason));
		void active.session?.abort();
		return true;
	}

	async getThreadMessages(threadId: string): Promise<AskChatMessage[]> {
		requirePiSessionId(threadId);
		const loaded = this.#sessions.get(threadId);
		const messages =
			loaded?.messages ??
			(await this.#openSessionManager(threadId))?.buildSessionContext().messages ??
			[];
		return messages.flatMap((message): AskChatMessage[] => {
			if (message.role !== "user" && message.role !== "assistant") {
				return [];
			}
			const content =
				typeof message.content === "string" ? message.content : contentText(message.content);
			if (
				message.role === "assistant" &&
				content.length === 0 &&
				Array.isArray(message.content) &&
				message.content.some((block) => block.type === "toolCall")
			) {
				return [];
			}
			return [{ role: message.role, content }];
		});
	}

	async deleteThread(threadId: string, signal?: AbortSignal): Promise<void> {
		requirePiSessionId(threadId);
		if (this.#activeThreads.has(threadId)) {
			throw runtimeError("thread_busy", "The chat session is currently in use.", false);
		}
		signal?.throwIfAborted();
		const loaded = this.#sessions.get(threadId);
		loaded?.dispose();
		this.#sessions.delete(threadId);
		const info = (await SessionManager.list(this.#workspaceDirectory, this.#sessionDirectory)).find(
			(session) => session.id === threadId,
		);
		if (info === undefined) {
			return;
		}
		const sessionRoot = realpathSync(this.#sessionDirectory);
		const file = realpathSync(info.path);
		const child = relative(sessionRoot, file);
		if (child.startsWith("..") || child === "" || resolve(sessionRoot, child) !== file) {
			throw new Error("Refusing to delete a session outside the app-owned session directory.");
		}
		const metadata = lstatSync(file);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Refusing to delete a non-regular session file.");
		}
		signal?.throwIfAborted();
		unlinkSync(file);
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) {
			return;
		}
		this.#shuttingDown = true;
		const aborts = [...this.#activeRuns.entries()].map(async ([runId, active]) => {
			active.controller.abort(new AskChatCancelledError(runId, "Runtime shutdown."));
			await active.session?.abort();
		});
		await Promise.allSettled(aborts);
		for (const session of this.#sessions.values()) {
			session.dispose();
		}
		this.#sessions.clear();
	}

	async #start(
		input: AskChatRunInput,
		onEvent?: (event: AskChatMessageDeltaEvent) => void | Promise<void>,
	): Promise<AskChatRunResult> {
		if (this.#shuttingDown) {
			throw runtimeError("runtime_shutdown", "The agent runtime is shutting down.", false);
		}
		if (this.#activeRuns.has(input.runId)) {
			throw runtimeError("duplicate_run_id", "The run ID is already active.", false, input.runId);
		}
		const threadId = input.threadId ?? input.runId;
		requirePiSessionId(threadId);
		if (this.#activeThreads.has(threadId)) {
			throw runtimeError("thread_busy", "The chat session already has an active run.", false);
		}
		const prompt = input.messages.findLast((message) => message.role === "user")?.content;
		if (prompt === undefined) {
			throw new TypeError("An Agent run requires a user message.");
		}
		const model = this.#modelRuntime.getModel(input.provider.providerId, input.provider.model);
		if (model === undefined) {
			throw runtimeError("provider_model", "The selected provider model is unavailable.", false);
		}
		const active: ActiveRun = { controller: new AbortController(), reason: undefined };
		this.#activeRuns.set(input.runId, active);
		this.#activeThreads.add(threadId);
		this.#runIdByThread.set(threadId, input.runId);
		const externalAbort = () => this.cancel(input.runId, "Request aborted.");
		input.signal?.addEventListener("abort", externalAbort, { once: true });
		if (input.signal?.aborted) {
			externalAbort();
		}
		const throwIfCancelled = (): void => {
			if (active.controller.signal.aborted) {
				throw new AskChatCancelledError(input.runId, active.reason);
			}
		};
		try {
			const session = await this.#getOrCreateSession(threadId, model, input.provider.thinkingLevel);
			active.session = session;
			throwIfCancelled();
			await session.setModel(model);
			throwIfCancelled();
			if (input.provider.thinkingLevel !== undefined) {
				session.setThinkingLevel(input.provider.thinkingLevel);
			}
			const before = session.messages.length;
			let callbackTail = Promise.resolve();
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					const delta = event.assistantMessageEvent.delta;
					callbackTail = callbackTail.then(() =>
						onEvent?.({ type: "message.delta", runId: input.runId, delta }),
					);
				}
			});
			try {
				await session.prompt(prompt, {
					expandPromptTemplates: false,
					preflightResult: throwIfCancelled,
				});
				await callbackTail;
			} finally {
				unsubscribe();
			}
			if (active.controller.signal.aborted) {
				throw new AskChatCancelledError(input.runId, active.reason);
			}
			const assistant = session.messages
				.slice(before)
				.findLast((message): message is AssistantMessage => message.role === "assistant");
			if (assistant === undefined) {
				throw runtimeError("provider_failure", "The provider returned no assistant reply.", true);
			}
			if (assistant.stopReason === "aborted") {
				throw new AskChatCancelledError(input.runId, active.reason);
			}
			if (assistant.stopReason === "error") {
				throw mapProviderError(assistant.errorMessage, input.runId);
			}
			return {
				runId: input.runId,
				text: contentText(assistant.content),
				usage: {
					inputTokens: assistant.usage.input,
					outputTokens: assistant.usage.output,
					totalTokens: assistant.usage.totalTokens,
				},
			};
		} catch (error) {
			if (error instanceof AskChatRuntimeError) {
				throw error;
			}
			throw mapProviderError(error, input.runId);
		} finally {
			input.signal?.removeEventListener("abort", externalAbort);
			this.#activeRuns.delete(input.runId);
			this.#activeThreads.delete(threadId);
			if (this.#runIdByThread.get(threadId) === input.runId) {
				this.#runIdByThread.delete(threadId);
			}
		}
	}

	async #getOrCreateSession(
		threadId: string,
		model?: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
		thinkingLevel?: ThinkingLevel,
	): Promise<AgentSession> {
		const loaded = this.#sessions.get(threadId);
		if (loaded !== undefined) {
			return loaded;
		}
		if (model === undefined) {
			throw runtimeError("not_configured", "A model is required to restore the session.", false);
		}
		const manager =
			(await this.#openSessionManager(threadId)) ??
			SessionManager.create(this.#workspaceDirectory, this.#sessionDirectory, { id: threadId });
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			packages: [],
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});
		const resources = new DefaultResourceLoader({
			cwd: this.#workspaceDirectory,
			agentDir: this.#agentDirectory,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt:
				`You are Moshu Agent. Complete the user's request directly and accurately. ` +
				`You have exactly seven tools: ${executorToolNames.join(", ")}. ` +
				`All tool execution happens in the trusted local executor. Relative paths resolve from ${this.#workspaceDirectory}. ` +
				"Do not assume any other tools, skills, extensions, or execution capabilities exist.",
		});
		await resources.reload();
		const customTools = createExecutorToolDefinitions({
			gateway: this.#executorGateway,
			cwd: this.#workspaceDirectory,
			getRunId: () => this.#runIdByThread.get(threadId),
		});
		assertExecutorToolDefinitions(customTools);
		const created = await createAgentSession({
			agentDir: this.#agentDirectory,
			cwd: this.#workspaceDirectory,
			modelRuntime: this.#modelRuntime,
			model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			noTools: "builtin",
			customTools,
			resourceLoader: resources,
			sessionManager: manager,
			settingsManager: settings,
		});
		const activeToolNames = created.session.getActiveToolNames();
		const configuredTools = created.session.getAllTools();
		if (
			activeToolNames.length !== executorToolNames.length ||
			executorToolNames.some((name) => !activeToolNames.includes(name)) ||
			configuredTools.length !== executorToolNames.length ||
			configuredTools.some((tool) => tool.sourceInfo.source !== "sdk")
		) {
			created.session.dispose();
			throw runtimeError(
				"unexpected_tool_activity",
				"Agent session did not load exactly the executor-backed tool set.",
				false,
			);
		}

		this.#sessions.set(threadId, created.session);
		return created.session;
	}

	async #openSessionManager(threadId: string): Promise<SessionManager | undefined> {
		const info = (await SessionManager.list(this.#workspaceDirectory, this.#sessionDirectory)).find(
			(session) => session.id === threadId,
		);
		return info === undefined
			? undefined
			: SessionManager.open(info.path, this.#sessionDirectory, this.#workspaceDirectory);
	}
}

export { PiAgentRuntime as PiAskChatRuntime };

const piSessionIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function requirePiSessionId(value: string): string {
	if (!piSessionIdPattern.test(value)) {
		throw new TypeError(
			"Pi session IDs must start and end with an alphanumeric character and contain only alphanumerics, dots, underscores, or hyphens.",
		);
	}
	return value;
}

function mapProviderError(error: unknown, runId?: string): AskChatRuntimeError {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const normalized = message.toLowerCase();
	if (normalized.includes("auth") || normalized.includes("api key") || normalized.includes("401")) {
		return runtimeError("provider_authentication", "Provider authentication failed.", false, runId);
	}
	if (normalized.includes("rate") || normalized.includes("429")) {
		return runtimeError(
			"provider_rate_limited",
			"The provider rate limit was reached.",
			true,
			runId,
		);
	}
	if (
		normalized.includes("network") ||
		normalized.includes("fetch") ||
		normalized.includes("timeout")
	) {
		return runtimeError("provider_network", "The provider could not be reached.", true, runId);
	}
	if (normalized.includes("model") || normalized.includes("404")) {
		return runtimeError(
			"provider_model",
			"The selected provider model is unavailable.",
			false,
			runId,
		);
	}
	return runtimeError("provider_failure", "The provider request failed.", true, runId);
}

function runtimeError(
	kind: AskChatErrorKind,
	message: string,
	retryable: boolean,
	runId?: string,
): AskChatRuntimeError {
	return new AskChatRuntimeError({
		kind,
		message,
		retryable,
		...(runId === undefined ? {} : { runId }),
	});
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
	readonly #values: T[] = [];
	readonly #waiters: Array<{
		resolve(value: IteratorResult<T>): void;
		reject(error: unknown): void;
	}> = [];
	#closed = false;
	#error: unknown;

	push(value: T): void {
		const waiter = this.#waiters.shift();
		if (waiter === undefined) this.#values.push(value);
		else waiter.resolve({ done: false, value });
	}

	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	fail(error: unknown): void {
		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.#values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.#error !== undefined) return Promise.reject(this.#error);
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
			},
		};
	}
}
