import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
	AIMessage,
	AIMessageChunk,
	BaseMessage,
	HumanMessage,
	HumanMessageChunk,
	SystemMessage,
	SystemMessageChunk,
} from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { createDeepAgent } from "@moshu/deepagents/browser";
import { createMiddleware } from "langchain";
import { createProviderChatModel } from "./provider-model-factory";
import type { ResolvedProviderConfiguration } from "./provider-registry";

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
	configuration: ResolvedProviderConfiguration,
) => AskAgent | Promise<AskAgent>;

export type AskModelFactory = (
	configuration: ResolvedProviderConfiguration,
) => BaseLanguageModel | Promise<BaseLanguageModel>;

export interface AskChatRuntime {
	run(input: AskChatRunInput): Promise<AskChatRunResult>;
	stream(input: AskChatRunInput): AskChatRunStream;
	cancel(runId: string, reason?: string): boolean;
	getThreadMessages(threadId: string): Promise<AskChatMessage[]>;
	deleteThread(threadId: string, signal?: AbortSignal): Promise<void>;
	shutdown(): Promise<void>;
}

export interface AskChatRuntimeOptions {
	checkpointer?: BaseCheckpointSaver;
	agentFactory?: AskAgentFactory;
	modelFactory?: AskModelFactory;
	threadCleanupWaitTimeoutMs?: number;
	shutdownCleanupTimeoutMs?: number;
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
	| "shutdown_timeout";

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
		cause?: unknown;
	}) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
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
	readonly #agentFactory: AskAgentFactory;
	readonly #checkpointer: BaseCheckpointSaver | undefined;
	readonly #activeRuns = new Map<string, ActiveRun>();
	readonly #threadFences = new Map<string, Promise<void>>();
	readonly #threadCleanupWaitTimeoutMs: number;
	readonly #shutdownCleanupTimeoutMs: number;
	#shutdownExecution: Promise<void> | undefined;
	#shuttingDown = false;

	constructor(options: AskChatRuntimeOptions) {
		this.#checkpointer = options.checkpointer;
		this.#threadCleanupWaitTimeoutMs = requirePositiveSafeInteger(
			options.threadCleanupWaitTimeoutMs ?? 5_000,
			"threadCleanupWaitTimeoutMs",
		);
		this.#shutdownCleanupTimeoutMs = requirePositiveSafeInteger(
			options.shutdownCleanupTimeoutMs ?? 1_000,
			"shutdownCleanupTimeoutMs",
		);
		this.#agentFactory =
			options.agentFactory ??
			((configuration) =>
				createDefaultAskAgent(
					configuration,
					options.checkpointer,
					options.modelFactory ?? createProviderChatModel,
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

	async deleteThread(threadId: string, signal?: AbortSignal): Promise<void> {
		this.#assertAcceptingWork();
		const fence = this.#createThreadFence(threadId);
		let operation: Promise<void> | undefined;
		try {
			await this.#waitForThreadFence(fence.previous, undefined, signal);
			signal?.throwIfAborted();
			operation = Promise.resolve().then(() =>
				this.#checkpointer?.deleteThread(createCheckpointThreadId(threadId)),
			);
			fence.settleAfter(operation);
			await waitForOperationOrAbort(operation, signal);
			signal?.throwIfAborted();
		} finally {
			if (operation === undefined) {
				fence.settleAfter(Promise.resolve());
			}
		}
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
		if (this.#shutdownExecution !== undefined) {
			return this.#shutdownExecution;
		}
		this.#shuttingDown = true;
		const execution = this.#performShutdown();
		this.#shutdownExecution = execution;
		return execution;
	}

	async #performShutdown(): Promise<void> {
		const activeRuns = [...this.#activeRuns.values()];

		for (const activeRun of activeRuns) {
			activeRun.controller.abort(new AskChatCancelledError(activeRun.runId));
		}

		const cleanup = Promise.allSettled([
			...activeRuns.map((activeRun) => activeRun.result),
			...this.#threadFences.values(),
		]);
		if (!(await settlesWithin(cleanup, this.#shutdownCleanupTimeoutMs))) {
			throw new AskChatRuntimeError({
				kind: "shutdown_timeout",
				message: "Ask chat runtime cleanup exceeded its shutdown deadline.",
				retryable: false,
			});
		}
	}

	#startRun(input: AskChatRunInput, onEvent: DeltaEventHandler | undefined): ActiveRun {
		this.#assertAcceptingWork();
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
		const threadId = input.threadId ?? input.runId;
		const fence = this.#createThreadFence(threadId);
		const cleanupOperations: Promise<void>[] = [];
		const registerCleanup = (cleanup: Promise<void>): void => {
			cleanupOperations.push(cleanup.then(noop, noop));
		};
		const result = (async () => {
			await this.#waitForThreadFence(fence.previous, input.runId, controller.signal);
			return this.#executeRun(input, controller.signal, onEvent, registerCleanup);
		})().finally(() => {
			detachAbortRelay();
			this.#activeRuns.delete(input.runId);
			fence.settleAfter(Promise.allSettled(cleanupOperations).then(noop));
		});

		const activeRun: ActiveRun = {
			runId: input.runId,
			controller,
			result,
		};

		this.#activeRuns.set(input.runId, activeRun);
		return activeRun;
	}

	#assertAcceptingWork(): void {
		if (!this.#shuttingDown) {
			return;
		}
		throw new AskChatRuntimeError({
			kind: "runtime_shutdown",
			message: "Ask chat runtime is shutting down.",
			retryable: false,
		});
	}

	#createThreadFence(threadId: string): {
		previous: Promise<void> | undefined;
		settleAfter(operation: Promise<unknown>): void;
	} {
		const previous = this.#threadFences.get(threadId);
		let settle: (() => void) | undefined;
		const completion = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const fence = (previous ?? Promise.resolve()).then(() => completion);
		this.#threadFences.set(threadId, fence);
		void fence.then(() => {
			if (this.#threadFences.get(threadId) === fence) {
				this.#threadFences.delete(threadId);
			}
		});
		let settlementRegistered = false;
		return {
			previous,
			settleAfter(operation) {
				if (settlementRegistered) {
					return;
				}
				settlementRegistered = true;
				void operation.then(
					() => settle?.(),
					() => settle?.(),
				);
			},
		};
	}

	#waitForThreadFence(
		fence: Promise<void> | undefined,
		runId?: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (fence === undefined) {
			signal?.throwIfAborted();
			return Promise.resolve();
		}
		return waitForFence(fence, this.#threadCleanupWaitTimeoutMs, signal, () =>
			runId === undefined
				? new AskChatRuntimeError({
						kind: "thread_busy",
						message: "The ask chat thread is still finishing previous provider cleanup.",
						retryable: true,
					})
				: new AskChatRuntimeError({
						kind: "thread_busy",
						message: "The ask chat thread is still finishing previous provider cleanup.",
						retryable: true,
						runId,
					}),
		);
	}

	async #executeRun(
		input: AskChatRunInput,
		signal: AbortSignal,
		onEvent: DeltaEventHandler | undefined,
		registerCleanup: IteratorCleanupRegistrar,
	): Promise<AskChatRunResult> {
		try {
			throwIfCancelled(signal, input.runId);

			const agent = await waitForAbortable(this.#agentFactory(input.provider), signal, input.runId);
			const messageHistory = toLangChainMessages(input.messages);
			const streamAcquisition = Promise.resolve().then(() =>
				agent.stream(
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
				),
			);
			const stream = await acquireProviderStream(
				streamAcquisition,
				signal,
				input.runId,
				registerCleanup,
			);

			const state: StreamAggregationState = {
				text: "",
				usage: undefined,
			};

			for await (const streamItem of iterateWithAbort(
				stream,
				signal,
				input.runId,
				registerCleanup,
			)) {
				throwIfCancelled(signal, input.runId);
				await consumeStreamItem(streamItem, state, input.runId, signal, onEvent, registerCleanup);
				throwIfCancelled(signal, input.runId);
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
	configuration: ResolvedProviderConfiguration,
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
			...(configuration.protocol === "openai-responses" ? [createResponsesV1Middleware()] : []),
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

function createResponsesV1Middleware() {
	return createMiddleware({
		name: "MoshuResponsesV1Middleware",
		wrapModelCall: (request, handler) =>
			handler({
				...request,
				messages: request.messages.map(toStandardResponsesMessage),
			}),
	});
}

function toStandardResponsesMessage(message: BaseMessage): BaseMessage {
	if (message.response_metadata.output_version === "v1") {
		return message;
	}

	const commonFields = {
		contentBlocks: message.contentBlocks,
		additional_kwargs: { ...message.additional_kwargs },
		response_metadata: {
			...message.response_metadata,
			output_version: "v1" as const,
		},
		...(message.id === undefined ? {} : { id: message.id }),
		...(message.name === undefined ? {} : { name: message.name }),
	};
	if (HumanMessageChunk.isInstance(message)) {
		return new HumanMessageChunk(commonFields);
	}
	if (HumanMessage.isInstance(message)) {
		return new HumanMessage(commonFields);
	}
	if (SystemMessageChunk.isInstance(message)) {
		return new SystemMessageChunk(commonFields);
	}
	if (SystemMessage.isInstance(message)) {
		return new SystemMessage(commonFields);
	}

	const isChunk = AIMessageChunk.isInstance(message);
	if (!isChunk && !AIMessage.isInstance(message)) {
		return message;
	}
	const fields = {
		...commonFields,
		...(message.tool_calls === undefined ? {} : { tool_calls: [...message.tool_calls] }),
		...(message.invalid_tool_calls === undefined
			? {}
			: { invalid_tool_calls: [...message.invalid_tool_calls] }),
		...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
	};

	return isChunk
		? new AIMessageChunk({
				...fields,
				...(message.tool_call_chunks === undefined
					? {}
					: { tool_call_chunks: [...message.tool_call_chunks] }),
			})
		: new AIMessage(fields);
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
	signal: AbortSignal,
	onEvent: DeltaEventHandler | undefined,
	registerCleanup: IteratorCleanupRegistrar,
): Promise<void> {
	const payload = unwrapStreamPayload(streamItem);

	if (hasTextStream(payload)) {
		throwIfCancelled(signal, runId);
		for await (const delta of iterateWithAbort(payload.text, signal, runId, registerCleanup)) {
			throwIfCancelled(signal, runId);
			await emitDelta(state, runId, delta, signal, onEvent);
			throwIfCancelled(signal, runId);
		}

		const usage = await resolveUsageStream(payload, signal, runId);
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

		await emitDelta(state, runId, extractTextDelta(payload.content, state.text), signal, onEvent);
	}
}

async function emitDelta(
	state: StreamAggregationState,
	runId: string,
	delta: string,
	signal: AbortSignal,
	onEvent: DeltaEventHandler | undefined,
): Promise<void> {
	throwIfCancelled(signal, runId);
	if (delta.length === 0) {
		return;
	}

	state.text += delta;

	if (onEvent === undefined) {
		return;
	}

	await waitForAbortable(
		onEvent({
			type: "message.delta",
			runId,
			delta,
		}),
		signal,
		runId,
	);
	throwIfCancelled(signal, runId);
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

async function resolveUsageStream(
	value: {
		usage?: PromiseLike<unknown>;
	},
	signal: AbortSignal,
	runId: string,
): Promise<AskChatUsage | undefined> {
	if (value.usage === undefined) {
		return undefined;
	}

	return normalizeUsage(await waitForAbortable(value.usage, signal, runId));
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

async function* iterateWithAbort<T>(
	iterable: AsyncIterable<T>,
	signal: AbortSignal,
	runId: string,
	registerCleanup: IteratorCleanupRegistrar,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	let completed = false;
	try {
		while (true) {
			throwIfCancelled(signal, runId);
			const next = await waitForAbortable(iterator.next(), signal, runId);
			throwIfCancelled(signal, runId);
			if (next.done) {
				completed = true;
				return;
			}
			yield next.value;
			throwIfCancelled(signal, runId);
		}
	} finally {
		if (!completed && typeof iterator.return === "function") {
			const close = Promise.resolve()
				.then(() => iterator.return?.())
				.then(noop);
			registerCleanup(close);
			if (signal.aborted) {
				// The per-thread cleanup fence observes detached provider cleanup.
			} else {
				try {
					await close;
				} catch {
					// Preserve the original completion reason.
				}
			}
		}
	}
}

async function acquireProviderStream(
	acquisition: Promise<AsyncIterable<unknown>>,
	signal: AbortSignal,
	runId: string,
	registerCleanup: IteratorCleanupRegistrar,
): Promise<AsyncIterable<unknown>> {
	let settleDisposition: ((disposition: "consumed" | "abandoned") => void) | undefined;
	const disposition = new Promise<"consumed" | "abandoned">((resolve) => {
		settleDisposition = resolve;
	});
	const outcome = acquisition.then(
		(stream) => ({ status: "fulfilled" as const, stream }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	);
	registerCleanup(
		Promise.all([outcome, disposition]).then(async ([result, streamDisposition]) => {
			if (streamDisposition !== "abandoned" || result.status !== "fulfilled") {
				return;
			}
			const iterator = result.stream[Symbol.asyncIterator]();
			if (typeof iterator.return === "function") {
				await iterator.return();
			}
		}),
	);

	try {
		const stream = await waitForAbortable(acquisition, signal, runId);
		settleDisposition?.("consumed");
		return stream;
	} catch (error) {
		settleDisposition?.(signal.aborted ? "abandoned" : "consumed");
		throw error;
	}
}

function waitForFence(
	fence: Promise<void>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	createTimeoutError: () => Error,
): Promise<void> {
	signal?.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		};
		const onAbort = (): void => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(() => finish(createTimeoutError()), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		void fence.then(
			() => finish(),
			(error: unknown) => finish(error),
		);
		if (signal?.aborted) {
			onAbort();
		}
	});
}

function waitForOperationOrAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	if (signal === undefined) {
		return operation;
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (result: { value: T } | { error: unknown }): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if ("error" in result) {
				reject(result.error);
			} else {
				resolve(result.value);
			}
		};
		const onAbort = (): void =>
			finish({ error: signal.reason ?? new DOMException("Aborted", "AbortError") });
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => finish({ value }),
			(error: unknown) => finish({ error }),
		);
		if (signal.aborted) {
			onAbort();
		}
	});
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

async function waitForAbortable<T>(
	value: T | PromiseLike<T>,
	signal: AbortSignal,
	runId: string,
): Promise<T> {
	throwIfCancelled(signal, runId);
	let rejectCancellation: ((error: AskChatCancelledError) => void) | undefined;
	const cancellation = new Promise<never>((_resolve, reject) => {
		rejectCancellation = reject;
	});
	const onAbort = (): void => {
		rejectCancellation?.(
			signal.reason instanceof AskChatCancelledError
				? signal.reason
				: new AskChatCancelledError(runId, getAbortReason(signal.reason)),
		);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await Promise.race([Promise.resolve(value), cancellation]);
		throwIfCancelled(signal, runId);
		return result;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
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
			cause: error,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (statusCode === 429 || hasRateLimitSignal(error)) {
		return new AskChatRuntimeError({
			kind: "provider_rate_limited",
			message: "Provider rate limited the request.",
			retryable: true,
			runId,
			cause: error,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
		return new AskChatRuntimeError({
			kind: "provider_model",
			message: "Provider rejected the configured model request.",
			retryable: false,
			runId,
			cause: error,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	if (isAbortLikeError(error) || hasNetworkSignal(error)) {
		return new AskChatRuntimeError({
			kind: "provider_network",
			message: "Provider request failed due to a network error.",
			retryable: true,
			runId,
			cause: error,
			...(statusCode === undefined ? {} : { statusCode }),
		});
	}

	return new AskChatRuntimeError({
		kind: "provider_failure",
		message: "Provider request failed.",
		retryable: statusCode !== undefined && statusCode >= 500,
		runId,
		cause: error,
		...(statusCode === undefined ? {} : { statusCode }),
	});
}

const maxErrorCauseDepth = 8;

/**
 * Agent middleware wraps provider failures, so the HTTP status and the original message only
 * exist further down the `cause` chain. Every classifier walks that chain.
 */
function collectErrorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = error;
	while (current !== undefined && current !== null && chain.length < maxErrorCauseDepth) {
		if (chain.includes(current)) {
			break;
		}
		chain.push(current);
		current = isRecord(current) ? current.cause : undefined;
	}
	return chain;
}

function getOptionalStatusCode(error: unknown): number | undefined {
	for (const candidate of collectErrorChain(error)) {
		if (!isRecord(candidate)) {
			continue;
		}
		if (typeof candidate.status === "number") {
			return candidate.status;
		}
		if (typeof candidate.statusCode === "number") {
			return candidate.statusCode;
		}
		if (isRecord(candidate.response) && typeof candidate.response.status === "number") {
			return candidate.response.status;
		}
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
	return collectErrorChain(error).some(
		(candidate) => isRecord(candidate) && candidate.name === "AbortError",
	);
}

function matchesErrorText(error: unknown, needles: readonly string[]): boolean {
	return collectErrorChain(error).some((candidate) => {
		const message = getErrorMessage(candidate);
		if (message === undefined) {
			return false;
		}
		const normalized = message.toLowerCase();
		return needles.some((needle) => normalized.includes(needle));
	});
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
type IteratorCleanupRegistrar = (cleanup: Promise<void>) => void;

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
