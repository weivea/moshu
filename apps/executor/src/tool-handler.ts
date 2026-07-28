import {
	executorToolInvokeInputSchema,
	productRpcEvents,
	type ExecutorToolInvokeInput,
} from "@moshu/contracts";
import {
	RpcHandlerError,
	rpcJsonValueSchema,
	type RpcPeer,
	type RpcRequestHandler,
} from "@moshu/process-rpc";
import type { ExecutorToolRuntime } from "./tools/index.ts";
import { truncateUtf8FromEnd } from "./tools/truncate.ts";

const maxRpcErrorMessageBytes = 1024;

function executionErrorMessage(error: unknown): string {
	return truncateUtf8FromEnd(
		error instanceof Error ? error.message : String(error),
		maxRpcErrorMessageBytes,
		"[earlier output truncated]\n",
	);
}

export function createExecutorToolRequestHandler(runtime: ExecutorToolRuntime): RpcRequestHandler {
	const activeInvocations = new WeakMap<RpcPeer, Set<string>>();
	return async (payload, context) => {
		const parsed = executorToolInvokeInputSchema.safeParse(payload);
		if (!parsed.success) {
			throw new RpcHandlerError("INVALID_EXECUTOR_TOOL_REQUEST", parsed.error.message);
		}
		const input: ExecutorToolInvokeInput = parsed.data;
		let peerInvocations = activeInvocations.get(context.peer);
		if (!peerInvocations) {
			peerInvocations = new Set();
			activeInvocations.set(context.peer, peerInvocations);
		}
		if (peerInvocations.has(input.invocationId)) {
			throw new RpcHandlerError(
				"DUPLICATE_EXECUTOR_TOOL_INVOCATION",
				`Executor tool invocation ${input.invocationId} is already running on this connection.`,
			);
		}
		peerInvocations.add(input.invocationId);
		try {
			const result = await runtime.execute(input, {
				signal: context.signal,
				onProgress: (event) => {
					context.peer.emitEvent(
						productRpcEvents.executorToolProgress,
						rpcJsonValueSchema.parse(event),
						{ traceId: context.traceId },
					);
				},
			});
			return rpcJsonValueSchema.parse(result);
		} catch (error) {
			if (context.signal.aborted) {
				throw new RpcHandlerError(
					"EXECUTOR_TOOL_CANCELLED",
					executionErrorMessage(context.signal.reason),
				);
			}
			if (error instanceof RpcHandlerError) {
				throw error;
			}
			throw new RpcHandlerError("EXECUTOR_TOOL_FAILED", executionErrorMessage(error));
		} finally {
			peerInvocations.delete(input.invocationId);
		}
	};
}
