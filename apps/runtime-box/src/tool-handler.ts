import {
	runtimeBoxToolInvokeInputSchema,
	productRpcEvents,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	acknowledgeRuntimeBoxInvocationsInputSchema,
	acknowledgeRuntimeBoxInvocationsOutputSchema,
} from "@moshu/contracts";
import {
	RpcHandlerError,
	RpcConnectionClosedError,
	rpcJsonValueSchema,
	type RpcPeer,
	type RpcRequestHandler,
} from "@moshu/process-rpc";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExecutorToolRuntime } from "./tools/index.ts";
import {
	InvocationGrantRejectedError,
	InvocationJournalPrepareFailedError,
	type RuntimeBoxInvocationJournal,
} from "./invocation-journal";
import { truncateUtf8FromEnd } from "./tools/truncate.ts";

const maxRpcErrorMessageBytes = 1024;

function executionErrorMessage(error: unknown): string {
	return truncateUtf8FromEnd(
		error instanceof Error ? error.message : String(error),
		maxRpcErrorMessageBytes,
		"[earlier output truncated]\n",
	);
}

export interface ExecutorToolRequestHandlerOptions {
	readonly cwd?: string;
	readonly journal: Pick<RuntimeBoxInvocationJournal, "begin" | "succeed" | "fail" | "cancel">;
	readonly enforceCwdContainment?: boolean;
	readonly activeExecutions?: Set<Promise<unknown>>;
	readonly lifecycleSignal?: AbortSignal;
	readonly onProgressError?: (error: unknown) => void;
}

export function createExecutorToolRequestHandler(
	runtime: ExecutorToolRuntime,
	options: ExecutorToolRequestHandlerOptions,
): RpcRequestHandler {
	const activeInvocations = new WeakMap<RpcPeer, Set<string>>();
	const handle = async (
		payload: Parameters<RpcRequestHandler>[0],
		context: Parameters<RpcRequestHandler>[1],
	) => {
		const parsed = runtimeBoxToolInvokeInputSchema.safeParse(payload);
		if (!parsed.success) {
			throw new RpcHandlerError("INVALID_RUNTIME_BOX_TOOL_REQUEST", parsed.error.message);
		}
		const input: ExecutorToolInvokeInput = parsed.data;
		const executionInput: ExecutorToolInvokeInput =
			options.cwd === undefined ? input : { ...input, cwd: options.cwd };
		if (options.enforceCwdContainment) {
			try {
				await assertCallContained(executionInput);
			} catch (error) {
				throw new RpcHandlerError("RUNTIME_BOX_WORKSPACE_VIOLATION", executionErrorMessage(error));
			}
		}
		let peerInvocations = activeInvocations.get(context.peer);
		if (!peerInvocations) {
			peerInvocations = new Set();
			activeInvocations.set(context.peer, peerInvocations);
		}
		if (peerInvocations.has(input.invocationId)) {
			throw new RpcHandlerError(
				"DUPLICATE_RUNTIME_BOX_TOOL_INVOCATION",
				`Executor tool invocation ${input.invocationId} is already running on this connection.`,
			);
		}
		peerInvocations.add(input.invocationId);
		let begun: { replayResult?: ExecutorToolInvokeOutput };
		try {
			begun = options.journal.begin(
				input,
				context.peer.remoteIdentity,
				context.peer.localIdentity,
				options.cwd === undefined ? "request-cwd" : "runtime-box-workspace",
			);
		} catch (error) {
			peerInvocations.delete(input.invocationId);
			throw new RpcHandlerError(
				error instanceof InvocationGrantRejectedError
					? "RUNTIME_BOX_EXECUTION_GRANT_REJECTED"
					: error instanceof InvocationJournalPrepareFailedError
						? "RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED"
						: "RUNTIME_BOX_INVOCATION_JOURNAL_FAILED",
				executionErrorMessage(error),
			);
		}

		async function assertCallContained(input: ExecutorToolInvokeInput): Promise<void> {
			if (input.call.tool === "bash") {
				return;
			}
			const path =
				input.call.tool === "read" ||
				input.call.tool === "edit" ||
				input.call.tool === "write" ||
				input.call.tool === "grep" ||
				input.call.tool === "find" ||
				input.call.tool === "ls"
					? input.call.arguments.path
					: undefined;
			if (path === undefined) {
				return;
			}
			const root = await realpath(input.cwd);
			const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(root, path);
			assertContained(root, lexicalTarget);
			const canonicalTarget = await resolveExistingPath(lexicalTarget);
			assertContained(root, canonicalTarget);
		}

		async function resolveExistingPath(path: string): Promise<string> {
			let current = path;
			const suffix: string[] = [];
			while (true) {
				try {
					const resolved = await realpath(current);
					return resolve(resolved, ...suffix.reverse());
				} catch (error) {
					if (!isMissingPathError(error)) {
						throw error;
					}
					const parent = dirname(current);
					if (parent === current) {
						throw error;
					}
					suffix.push(current.slice(parent.length + 1));
					current = parent;
				}
			}
		}

		function assertContained(root: string, target: string): void {
			const pathFromRoot = relative(root, target);
			if (
				pathFromRoot === ".." ||
				pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
				isAbsolute(pathFromRoot)
			) {
				throw new Error("Tool path escapes the Runtime Box workspace.");
			}
		}

		function isMissingPathError(error: unknown): boolean {
			return (
				error instanceof Error &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR")
			);
		}
		let executionSignal: ReturnType<typeof createActionExecutionSignal> | undefined;
		try {
			if (begun.replayResult !== undefined) {
				return rpcJsonValueSchema.parse(begun.replayResult);
			}
			const activeExecutionSignal = createActionExecutionSignal(
				context.signal,
				context.deadlineAt,
				options.lifecycleSignal,
			);
			executionSignal = activeExecutionSignal;
			let result: ExecutorToolInvokeOutput;
			try {
				activeExecutionSignal.signal.throwIfAborted();
				const execution = Promise.resolve().then(() =>
					runtime.execute(executionInput, {
						signal: activeExecutionSignal.signal,
						onProgress: (event) => {
							if (context.peer.isClosed) {
								return;
							}
							try {
								context.peer.emitEvent(
									productRpcEvents.runtimeBoxToolProgress,
									rpcJsonValueSchema.parse(event),
									{ traceId: context.traceId },
								);
							} catch (error) {
								(options.onProgressError ?? defaultProgressErrorReporter)(error);
							}
						},
					}),
				);
				result = await execution;
			} finally {
				activeExecutionSignal.dispose();
			}
			options.journal.succeed(input.invocationId, result);
			return rpcJsonValueSchema.parse(result);
		} catch (error) {
			if (executionSignal?.signal.aborted) {
				options.journal.cancel(
					input.invocationId,
					executionErrorMessage(executionSignal.signal.reason),
				);
				throw new RpcHandlerError(
					"RUNTIME_BOX_TOOL_CANCELLED",
					executionErrorMessage(executionSignal.signal.reason),
				);
			}

			try {
				options.journal.fail(input.invocationId, executionErrorMessage(error));
			} catch (journalError) {
				throw new RpcHandlerError(
					"RUNTIME_BOX_INVOCATION_JOURNAL_FAILED",
					executionErrorMessage(journalError),
				);
			}
			if (error instanceof RpcHandlerError) {
				throw error;
			}
			throw new RpcHandlerError("RUNTIME_BOX_TOOL_FAILED", executionErrorMessage(error));
		} finally {
			peerInvocations.delete(input.invocationId);
		}
	};
	return (payload, context) => {
		const execution = Promise.resolve(handle(payload, context));
		const activeExecutions = options.activeExecutions;
		if (activeExecutions !== undefined) {
			activeExecutions.add(execution);
			void execution.then(
				() => activeExecutions.delete(execution),
				() => activeExecutions.delete(execution),
			);
		}
		return execution;
	};
}

function defaultProgressErrorReporter(error: unknown): void {
	console.error(
		error instanceof Error
			? `Runtime Box progress publication failed: ${error.message}`
			: "Runtime Box progress publication failed.",
	);
}

export function createActionExecutionSignal(
	requestSignal: AbortSignal,
	deadlineAt: number,
	lifecycleSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	let leaseTimer: ReturnType<typeof setTimeout> | undefined;
	const abortFromLifecycle = () =>
		controller.abort(lifecycleSignal?.reason ?? new Error("Runtime Box is shutting down."));
	const abortFromRequest = () => {
		const reason = requestSignal.reason;
		if (reason instanceof RpcConnectionClosedError && lifecycleSignal?.aborted !== true) {
			const remainingMs = Math.max(0, deadlineAt - Date.now());
			leaseTimer = setTimeout(
				() => controller.abort(new Error("Action lease expired after transport loss.")),
				remainingMs,
			);
			return;
		}
		controller.abort(reason);
	};
	requestSignal.addEventListener("abort", abortFromRequest, { once: true });
	lifecycleSignal?.addEventListener("abort", abortFromLifecycle, { once: true });
	if (lifecycleSignal?.aborted) {
		abortFromLifecycle();
	} else if (requestSignal.aborted) {
		abortFromRequest();
	}
	return {
		signal: controller.signal,
		dispose() {
			requestSignal.removeEventListener("abort", abortFromRequest);
			lifecycleSignal?.removeEventListener("abort", abortFromLifecycle);
			if (leaseTimer !== undefined) {
				clearTimeout(leaseTimer);
			}
		},
	};
}

export function createInvocationAcknowledgementHandler(
	journal: RuntimeBoxInvocationJournal,
): RpcRequestHandler {
	return (payload) => {
		const input = acknowledgeRuntimeBoxInvocationsInputSchema.parse(payload);
		return rpcJsonValueSchema.parse(
			acknowledgeRuntimeBoxInvocationsOutputSchema.parse({
				ackedInvocationIds: journal.acknowledge(input.invocationIds),
			}),
		);
	};
}
