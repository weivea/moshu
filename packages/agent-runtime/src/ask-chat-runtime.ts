import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { createDeepAgent } from "@moshu/deepagents/browser";
import { createMiddleware } from "langchain";
import type { AskProviderConfigStore, AskProviderConfiguration } from "./ask-provider-config";

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

export interface AskAgentStreamInput {
	messages: BaseMessage[];
}

export interface AskAgentStreamOptions {
	streamMode: "messages";
	signal: AbortSignal;
	configurable: {
		thread_id: string;
		checkpoint_ns: string;
		run_id: string;
	};
}

export interface AskAgent {
	stream(
		input: AskAgentStreamInput,
		options: AskAgentStreamOptions,
	): Promise<AsyncIterable<unknown>>;
}

export type AskAgentFactory = (
	configuration: AskProviderConfiguration,
) => AskAgent | Promise<AskAgent>;

export type AskModelFactory = (
	configuration: AskProviderConfiguration,
) => BaseLanguageModel | Promise<BaseLanguageModel>;

export interface AskChatRuntime {
	run(input: AskChatRunInput): Promise<AskChatRunResult>;
	stream(input: AskChatRunInput): AskChatRunStream;
	cancel(runId: string, reason?: string): boolean;
	getThreadMessages(threadId: string): Promise<AskChatMessage[]>;
	deleteThread(threadId: string): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AskChatRuntimeOptions {
	providerConfigStore: AskProviderConfigStore;
	checkpointer?: BaseCheckpointSaver;
	agentFactory?: AskAgentFactory;
	modelFactory?: AskModelFactory;
}

export type AskChatErrorKind =
	| "not_configured"
	| "duplicate_run_id"
	| "cancelled"
	| "provider_authentication"
	| "provider_rate_limited"
	| "provider_network"
	| "provider_model"
	| "provider_failure";

export class AskChatRuntimeError extends Error {
	readonly kind: AskChatErrorKind;
	readonly retryable: boolean;
	readonly runId?: string;
	readonly statusCode?: number;

	constructor(options: {
		kind: AskChatErrorKind;
		message: string;
		retryable: boolean;
		runId?: string;
		statusCode?: number;
	}) {
		super(options.message);
		this.name = "AskChatRuntimeError";
		this.kind = options.kind;
		this.retryable = options.retryable;

		if (options.runId !== undefined) {
			this.runId = options.runId;
		}

		if (options.statusCode !== undefined) {
			this.statusCode = options.statusCode;
		}
	}
}

export class AskChatCancelledError extends AskChatRuntimeError {
	readonly reason?: string;

	constructor(runId: string, reason?: string) {
		super({
			kind: "cancelled",
			message: "Ask chat run was cancelled.",
			retryable: false,
			runId,
		});
		this.name = "AskChatCancelledError";
		if (reason !== undefined) {
			this.reason = reason;
		}
	}
}

export class DeepAgentsAskChatRuntime implements AskChatRuntime {
	readonly #providerConfigStore: AskProviderConfigStore;
	readonly #agentFactory: AskAgentFactory;
	readonly #checkpointer: BaseCheckpointSaver | undefined;
	readonly #activeRuns = new Map<string, ActiveRun>();

	constructor(options: AskChatRuntimeOptions) {
		this.#providerConfigStore = options.providerConfigStore;
		this.#checkpointer = options.checkpointer;
		this.#agentFactory =
			options.agentFactory ??
			((configuration) =>
				createDefaultAskAgent(
					configuration,
					options.checkpointer,
					options.modelFactory ?? createOpenAiCompatibleModel,
				));
	}

	run(input: AskChatRunInput): Promise<AskChatRunResult> {
		const activeRun = this.#startRun(input, input.onEvent);
		return activeRun.result;
	}

	stream(input: AskChatRunInput): AskChatRunStream {
		const queue = new AsyncEventQueue<AskChatMessageDeltaEvent>();
		const activeRun = this.#startRun(input, async (event) => {
			queue.push(event);

			if (input.onEvent !== undefined) {
				await input.onEvent(event);
			}
		});

		activeRun.result.then(
			() => queue.close(),
			(error: unknown) => queue.fail(error),
		);

		return {
			runId: input.runId,
			result: activeRun.result,
			cancel: (reason?: string) => {
				this.cancel(input.runId, reason);
			},
			[Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
		};
	}

	cancel(runId: string, reason?: string): boolean {
		const activeRun = this.#activeRuns.get(runId);

		if (activeRun === undefined) {
			return false;
		}

		activeRun.controller.abort(new AskChatCancelledError(runId, reason));
		return true;
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.#checkpointer?.deleteThread(createCheckpointThreadId(threadId));
	}

	async getThreadMessages(threadId: string): Promise<AskChatMessage[]> {
		const checkpoint = await this.#checkpointer?.getTuple({
			configurable: {
				thread_id: createCheckpointThreadId(threadId),
				checkpoint_ns: "",
			},
		});
		const values = checkpoint?.checkpoint.channel_values;
		if (!isRecord(values) || !Array.isArray(values.messages)) {
			return [];
		}

		return values.messages.flatMap((message): AskChatMessage[] => {
			if (!BaseMessage.isInstance(message)) {
				return [];
			}

			const content = extractTextContent(message.content);
			const id = typeof message.id === "string" ? message.id : undefined;
			if (HumanMessage.isInstance(message)) {
				return [{ role: "user", content, ...(id === undefined ? {} : { id }) }];
			}
			if (AIMessage.isInstance(message) || AIMessageChunk.isInstance(message)) {
				return [{ role: "assistant", content, ...(id === undefined ? {} : { id }) }];
			}

			return [];
		});
	}

	async shutdown(): Promise<void> {
		const activeRuns = [...this.#activeRuns.values()];

		for (const activeRun of activeRuns) {
			activeRun.controller.abort(new AskChatCancelledError(activeRun.runId));
		}

		await Promise.allSettled(activeRuns.map((activeRun) => activeRun.result));
	}

	#startRun(input: AskChatRunInput, onEvent: DeltaEventHandler | undefined): ActiveRun {
		if (this.#activeRuns.has(input.runId)) {
			throw new AskChatRuntimeError({
				kind: "duplicate_run_id",
				message: `An ask chat run with id "${input.runId}" is already active.`,
				retryable: false,
				runId: input.runId,
			});
		}

		const controller = new AbortController();
		const detachAbortRelay = relayAbortSignal(input.signal, controller, input.runId);

		const result = this.#executeRun(input, controller.signal, onEvent).finally(() => {
			detachAbortRelay();
			this.#activeRuns.delete(input.runId);
		});

		const activeRun: ActiveRun = {
			runId: input.runId,
			controller,
			result,
		};

		this.#activeRuns.set(input.runId, activeRun);
		return activeRun;
	}

	async #executeRun(
		input: AskChatRunInput,
		signal: AbortSignal,
		onEvent: DeltaEventHandler | undefined,
	): Promise<AskChatRunResult> {
		try {
			throwIfCancelled(signal, input.runId);

			const providerConfiguration = this.#providerConfigStore.get();
			if (providerConfiguration === null) {
				throw new AskChatRuntimeError({
					kind: "not_configured",
					message: "Ask provider is not configured.",
					retryable: false,
					runId: input.runId,
				});
			}

			const agent = await this.#agentFactory(providerConfiguration);
			const messageHistory = toLangChainMessages(input.messages);
			const stream = await agent.stream(
				{ messages: messageHistory },
				{
					streamMode: "messages",
					signal,
					configurable: {
						thread_id: createCheckpointThreadId(input.threadId ?? input.runId),
						checkpoint_ns: "",
						run_id: input.runId,
					},
				},
			);

			const state: StreamAggregationState = {
				text: "",
				usage: undefined,
			};

			for await (const streamItem of stream) {
				throwIfCancelled(signal, input.runId);
				await consumeStreamItem(streamItem, state, input.runId, onEvent);
			}

			throwIfCancelled(signal, input.runId);

			return {
				runId: input.runId,
				text: state.text,
				...(state.usage === undefined ? {} : { usage: state.usage }),
			};
		} catch (error) {
			throw mapAskChatError(error, input.runId, signal);
		}
	}
}

export { DeepAgentsAskChatRuntime as InMemoryAskChatRuntime };

export function createAskChatRuntime(options: AskChatRuntimeOptions): DeepAgentsAskChatRuntime {
	return new DeepAgentsAskChatRuntime(options);
}

function createCheckpointThreadId(threadId: string): string {
	return `ask:${encodeURIComponent(threadId)}`;
}

async function createDefaultAskAgent(
	configuration: AskProviderConfiguration,
	checkpointer: BaseCheckpointSaver | undefined,
	modelFactory: AskModelFactory,
): Promise<AskAgent> {
	const model = await modelFactory(configuration);
	const agent = createDeepAgent({
		model,
		tools: [],
		subagents: [],
		systemPrompt: {
			base: "You are Moshu's Ask assistant. Answer the user directly using the supplied conversation. You do not have access to external tools, commands, or the host filesystem.",
		},
		middleware: [
			createMiddleware({ name: "todoListMiddleware" }),
			createMiddleware({ name: "FilesystemMiddleware" }),
			createMiddleware({ name: "subAgentMiddleware" }),
			createAskToolPolicyMiddleware(),
		],
		...(checkpointer === undefined ? {} : { checkpointer }),
		name: "moshu-ask",
	});

	return {
		stream: (input, options) =>
			agent.stream(
				{
					messages: [...input.messages],
				},
				options,
			),
	};
}

function createOpenAiCompatibleModel(configuration: AskProviderConfiguration): ChatOpenAI {
	return new ChatOpenAI({
		apiKey: configuration.apiKey,
		model: configuration.model,
		maxRetries: 0,
		useResponsesApi: false,
		...(configuration.baseUrl === undefined
			? {}
			: { configuration: { baseURL: configuration.baseUrl } }),
	});
}

function createAskToolPolicyMiddleware() {
	return createMiddleware({
		name: "MoshuAskToolPolicyMiddleware",
		wrapModelCall: (request, handler) =>
			handler({
				...request,
				tools: [],
			}),
		wrapToolCall: async (request) => {
			throw new Error(`Ask mode rejected tool "${request.toolCall.name}".`);
		},
	});
}

async function consumeStreamItem(
	streamItem: unknown,
	state: StreamAggregationState,
	runId: string,
	onEvent: DeltaEventHandler | undefined,
): Promise<void> {
	const payload = unwrapStreamPayload(streamItem);

	if (hasTextStream(payload)) {
		for await (const delta of payload.text) {
			await emitDelta(state, runId, delta, onEvent);
		}

		const usage = await resolveUsageStream(payload);
		if (usage !== undefined) {
			state.usage = usage;
		}

		return;
	}

	if (
		BaseMessage.isInstance(payload) &&
		(AIMessageChunk.isInstance(payload) || payload._getType() === "generic")
	) {
		const usage = normalizeUsage(isRecord(payload) ? payload.usage_metadata : undefined);
		if (usage !== undefined) {
			state.usage = usage;
		}

		await emitDelta(state, runId, extractTextDelta(payload.content, state.text), onEvent);
	}
}

async function emitDelta(
	state: StreamAggregationState,
	runId: string,
	delta: string,
	onEvent: DeltaEventHandler | undefined,
): Promise<void> {
	if (delta.length === 0) {
		return;
	}

	state.text += delta;

	if (onEvent === undefined) {
		return;
	}

	await onEvent({
		type: "message.delta",
		runId,
		delta,
	});
}

function unwrapStreamPayload(streamItem: unknown): unknown {
	if (Array.isArray(streamItem) && streamItem.length > 0) {
		return streamItem[0];
	}

	return streamItem;
}

function extractTextDelta(content: BaseMessage["content"], currentText: string) {
	const candidateText = extractTextContent(content);

	if (candidateText.length === 0) {
		return "";
	}

	if (candidateText.startsWith(currentText)) {
		return candidateText.slice(currentText.length);
	}

	return candidateText;
}

function extractTextContent(content: BaseMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	let text = "";

	for (const block of content) {
		if (typeof block === "string") {
			text += block;
			continue;
		}

		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			text += block.text;
		}
	}

	return text;
}

function toLangChainMessages(messages: readonly AskChatMessage[]): BaseMessage[] {
	return messages.map((message) =>
		message.role === "user"
			? new HumanMessage({
					content: message.content,
					...(message.id === undefined ? {} : { id: message.id }),
				})
			: new AIMessage({
					content: message.content,
					...(message.id === undefined ? {} : { id: message.id }),
				}),
	);
}

function normalizeUsage(value: unknown): AskChatUsage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const inputTokens = getOptionalNumber(value, "input_tokens");
	const outputTokens = getOptionalNumber(value, "output_tokens");
	const totalTokens = getOptionalNumber(value, "total_tokens");

	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
		return undefined;
	}

	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
	};
}

function getOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
	const candidate = value[key];
	return typeof candidate === "number" ? candidate : undefined;
}

function hasTextStream(value: unknown): value is {
	text: AsyncIterable<string>;
	usage?: PromiseLike<unknown>;
} {
	if (!isRecord(value) || !("text" in value)) {
		return false;
	}

	return isAsyncIterable(value.text);
}

async function resolveUsageStream(value: {
	usage?: PromiseLike<unknown>;
}): Promise<AskChatUsage | undefined> {
	if (value.usage === undefined) {
		return undefined;
	}

	return normalizeUsage(await value.usage);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
	return (
		isRecord(value) &&
		Symbol.asyncIterator in value &&
		typeof Reflect.get(value, Symbol.asyncIterator) === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function throwIfCancelled(signal: AbortSignal, runId: string): void {
	if (!signal.aborted) {
		return;
	}

	const reason = signal.reason;
	if (reason instanceof AskChatCancelledError) {
		throw reason;
	}

	throw new AskChatCancelledError(runId, getAbortReason(reason));
}

function relayAbortSignal(
	source: AbortSignal | undefined,
	target: AbortController,
	runId: string,
): () => void {
	if (source === undefined) {
		return noop;
	}

	if (source.aborted) {
		target.abort(new AskChatCancelledError(runId, getAbortReason(source.reason)));
		return noop;
	}

	const onAbort = () => {
		target.abort(new AskChatCancelledError(runId, getAbortReason(source.reason)));
	};

	source.addEventListener("abort", onAbort, { once: true });
	return () => source.removeEventListener("abort", onAbort);
}

function mapAskChatError(error: unknown, runId: string, signal: AbortSignal): AskChatRuntimeError {
	if (error instanceof AskChatRuntimeError) {
		return error;
	}

	if (signal.aborted) {
		const reason = signal.reason;
		return reason instanceof AskChatCancelledError
			? reason
			: new AskChatCancelledError(runId, getAbortReason(reason));
	}

	const statusCode = getOptionalStatusCode(error);
	if (statusCode === 401 || statusCode === 403 || hasAuthSignal(error)) {
		return new AskChatRuntimeError({
			kind: "provider_authentication",
			message: "Provider authentication failed.",
			retryable: false,
			runId,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (statusCode === 429 || hasRateLimitSignal(error)) {
		return new AskChatRuntimeError({
			kind: "provider_rate_limited",
			message: "Provider rate limited the request.",
			retryable: true,
			runId,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
		return new AskChatRuntimeError({
			kind: "provider_model",
			message: "Provider rejected the configured model request.",
			retryable: false,
			runId,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (isAbortLikeError(error) || hasNetworkSignal(error)) {
		return new AskChatRuntimeError({
			kind: "provider_network",
			message: "Provider request failed due to a network error.",
			retryable: true,
			runId,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	return new AskChatRuntimeError({
		kind: "provider_failure",
		message: "Provider request failed.",
		retryable: statusCode !== undefined && statusCode >= 500,
		runId,
		...(statusCode === undefined ? {} : { statusCode }),
	});
}

function getOptionalStatusCode(error: unknown): number | undefined {
	if (!isRecord(error)) {
		return undefined;
	}

	const directStatus = error.status;
	if (typeof directStatus === "number") {
		return directStatus;
	}

	if (isRecord(error.response) && typeof error.response.status === "number") {
		return error.response.status;
	}

	return undefined;
}

function hasAuthSignal(error: unknown): boolean {
	return matchesErrorText(error, ["authentication", "unauthorized", "invalid api key"]);
}

function hasRateLimitSignal(error: unknown): boolean {
	return matchesErrorText(error, ["rate limit", "too many requests", "quota"]);
}

function hasNetworkSignal(error: unknown): boolean {
	return matchesErrorText(error, [
		"fetch failed",
		"network",
		"timed out",
		"timeout",
		"econnreset",
		"enotfound",
		"econnrefused",
		"socket hang up",
	]);
}

function isAbortLikeError(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === "AbortError";
	}

	if (!isRecord(error) || typeof error.name !== "string") {
		return false;
	}

	return error.name === "AbortError";
}

function matchesErrorText(error: unknown, needles: readonly string[]): boolean {
	const message = getErrorMessage(error);
	if (message === undefined) {
		return false;
	}

	const normalized = message.toLowerCase();
	return needles.some((needle) => normalized.includes(needle));
}

function getErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}

	if (isRecord(error) && typeof error.message === "string") {
		return error.message;
	}

	return undefined;
}

function getAbortReason(reason: unknown): string | undefined {
	if (typeof reason === "string" && reason.trim().length > 0) {
		return reason;
	}

	if (reason instanceof Error && reason.message.trim().length > 0) {
		return reason.message;
	}

	return undefined;
}

function noop(): void {}

interface ActiveRun {
	runId: string;
	controller: AbortController;
	result: Promise<AskChatRunResult>;
}

interface StreamAggregationState {
	text: string;
	usage: AskChatUsage | undefined;
}

type DeltaEventHandler = ((event: AskChatMessageDeltaEvent) => void | Promise<void>) | undefined;

class AsyncEventQueue<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#waiters: Array<{
		resolve: (result: IteratorResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	#closed = false;
	#error: unknown = undefined;

	push(item: T): void {
		if (this.#closed || this.#error !== undefined) {
			return;
		}

		const waiter = this.#waiters.shift();
		if (waiter !== undefined) {
			waiter.resolve({ value: item, done: false });
			return;
		}

		this.#items.push(item);
	}

	close(): void {
		if (this.#closed || this.#error !== undefined) {
			return;
		}

		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) {
			waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.#closed || this.#error !== undefined) {
			return;
		}

		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) {
			waiter.reject(error);
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.#items.length > 0) {
					const value = this.#items.shift();
					if (value === undefined) {
						return Promise.resolve({ value: undefined, done: true });
					}

					return Promise.resolve({ value, done: false });
				}

				if (this.#error !== undefined) {
					return Promise.reject(this.#error);
				}

				if (this.#closed) {
					return Promise.resolve({ value: undefined, done: true });
				}

				return new Promise<IteratorResult<T>>((resolve, reject) => {
					this.#waiters.push({ resolve, reject });
				});
			},
		};
	}
}
