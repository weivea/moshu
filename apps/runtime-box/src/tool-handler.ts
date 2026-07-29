import {
	runtimeBoxToolInvokeInputSchema,
	productRpcEvents,
	type ExecutorToolInvokeInput,
	acknowledgeRuntimeBoxInvocationsInputSchema,
	acknowledgeRuntimeBoxInvocationsOutputSchema,
} from "@moshu/contracts";
import {
	RpcHandlerError,
	rpcJsonValueSchema,
	type RpcPeer,
	type RpcRequestHandler,
} from "@moshu/process-rpc";
import type { ExecutorToolRuntime } from "./tools/index.ts";
import {
	InvocationGrantRejectedError,
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
}

export function createExecutorToolRequestHandler(
	runtime: ExecutorToolRuntime,
	options: ExecutorToolRequestHandlerOptions,
): RpcRequestHandler {
	const activeInvocations = new WeakMap<RpcPeer, Set<string>>();
	return async (payload, context) => {
		const parsed = runtimeBoxToolInvokeInputSchema.safeParse(payload);
		if (!parsed.success) {
			throw new RpcHandlerError("INVALID_RUNTIME_BOX_TOOL_REQUEST", parsed.error.message);
		}
		const input: ExecutorToolInvokeInput = parsed.data;
		const executionInput: ExecutorToolInvokeInput =
			options.cwd === undefined ? input : { ...input, cwd: options.cwd };
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
		let begun: ReturnType<RuntimeBoxInvocationJournal["begin"]>;
		try {
			begun = options.journal.begin(
				input,
				context.peer.remoteIdentity,
				context.peer.localIdentity,
				options.cwd,
			);
		} catch (error) {
			throw new RpcHandlerError(
				error instanceof InvocationGrantRejectedError
					? "RUNTIME_BOX_EXECUTION_GRANT_REJECTED"
					: "RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED",
				executionErrorMessage(error),
			);
		}
		try {
			if (begun.replayResult !== undefined) {
				return rpcJsonValueSchema.parse(begun.replayResult);
			}
			const result = await runtime.execute(executionInput, {
				signal: context.signal,
				onProgress: (event) => {
					context.peer.emitEvent(
						productRpcEvents.runtimeBoxToolProgress,
						rpcJsonValueSchema.parse(event),
						{ traceId: context.traceId },
					);
				},
			});
			options.journal.succeed(input.invocationId, result);
			return rpcJsonValueSchema.parse(result);
		} catch (error) {
			if (context.signal.aborted) {
				options.journal.cancel(input.invocationId, executionErrorMessage(context.signal.reason));
				throw new RpcHandlerError(
					"RUNTIME_BOX_TOOL_CANCELLED",
					executionErrorMessage(context.signal.reason),
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
