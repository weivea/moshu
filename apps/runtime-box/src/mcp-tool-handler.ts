import {
	productRpcMethods,
	runtimeBoxMcpToolInvokeInputSchema,
	runtimeBoxMcpToolInvokeOutputSchema,
	type RuntimeBoxMcpToolInvokeOutput,
} from "@moshu/contracts";
import {
	RpcHandlerError,
	type RpcPeer,
	type RpcRequestHandler,
	rpcJsonValueSchema,
} from "@moshu/process-rpc";

import {
	InvocationGrantRejectedError,
	InvocationJournalPrepareFailedError,
	type RuntimeBoxInvocationJournal,
} from "./invocation-journal";
import type { McpLifecycleManager } from "./mcp-lifecycle-manager";
import { McpToolOutcomeUnknownError } from "./mcp-client";
import { createActionExecutionSignal } from "./tool-handler";
import { truncateUtf8FromEnd } from "./tools/truncate";

export interface McpToolRequestHandlerOptions {
	readonly activeExecutions?: Set<Promise<unknown>>;
	readonly lifecycleSignal?: AbortSignal;
}

export function createMcpToolRequestHandler(
	manager: McpLifecycleManager,
	journal: Pick<
		RuntimeBoxInvocationJournal,
		"begin" | "succeed" | "fail" | "cancel" | "outcomeUnknown"
	>,
	options: McpToolRequestHandlerOptions = {},
): RpcRequestHandler {
	const activeInvocations = new WeakMap<RpcPeer, Set<string>>();
	const handle = async (
		payload: Parameters<RpcRequestHandler>[0],
		context: Parameters<RpcRequestHandler>[1],
	) => {
		const parsed = runtimeBoxMcpToolInvokeInputSchema.safeParse(payload);
		if (!parsed.success) {
			throw new RpcHandlerError("INVALID_RUNTIME_BOX_MCP_TOOL_REQUEST", parsed.error.message);
		}
		const input = parsed.data;
		const expectedResource = {
			version: input.mcpServerVersion,
			contentHash: input.mcpServerContentHash,
			schemaHash: input.toolSchemaHash,
		};
		if (!manager.isToolReady(input.mcpServerId, input.stableToolId, expectedResource)) {
			throw new RpcHandlerError(
				"RUNTIME_BOX_MCP_TOOL_NOT_READY",
				"MCP Tool is not part of the live ready inventory.",
			);
		}
		let peerInvocations = activeInvocations.get(context.peer);
		if (peerInvocations === undefined) {
			peerInvocations = new Set();
			activeInvocations.set(context.peer, peerInvocations);
		}
		if (peerInvocations.has(input.invocationId)) {
			throw new RpcHandlerError(
				"DUPLICATE_RUNTIME_BOX_TOOL_INVOCATION",
				`MCP Tool invocation ${input.invocationId} is already running on this connection.`,
			);
		}
		peerInvocations.add(input.invocationId);
		let begun: { replayResult?: RuntimeBoxMcpToolInvokeOutput };
		try {
			begun = journal.begin(
				input,
				context.peer.remoteIdentity,
				context.peer.localIdentity,
				"runtime-box-workspace",
			);
		} catch (error) {
			peerInvocations.delete(input.invocationId);
			throw new RpcHandlerError(
				error instanceof InvocationGrantRejectedError
					? "RUNTIME_BOX_EXECUTION_GRANT_REJECTED"
					: error instanceof InvocationJournalPrepareFailedError
						? "RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED"
						: "RUNTIME_BOX_INVOCATION_JOURNAL_FAILED",
				safeError(error),
			);
		}
		let executionSignal: ReturnType<typeof createActionExecutionSignal> | undefined;
		try {
			if (begun.replayResult !== undefined) {
				return rpcJsonValueSchema.parse(
					runtimeBoxMcpToolInvokeOutputSchema.parse(begun.replayResult),
				);
			}
			const activeExecutionSignal = createActionExecutionSignal(
				context.signal,
				context.deadlineAt,
				options.lifecycleSignal,
			);
			executionSignal = activeExecutionSignal;
			let output: RuntimeBoxMcpToolInvokeOutput;
			try {
				activeExecutionSignal.signal.throwIfAborted();
				const result = await manager.callTool(
					input.mcpServerId,
					input.stableToolId,
					input.arguments,
					expectedResource,
					activeExecutionSignal.signal,
				);
				output = runtimeBoxMcpToolInvokeOutputSchema.parse({
					schemaVersion: 1,
					invocationId: input.invocationId,
					mcpServerId: input.mcpServerId,
					stableToolId: input.stableToolId,
					result,
					isError:
						typeof result === "object" &&
						result !== null &&
						!Array.isArray(result) &&
						"isError" in result &&
						result.isError === true,
				});
			} finally {
				activeExecutionSignal.dispose();
			}
			if (output.isError) {
				journal.fail(input.invocationId, mcpReportedError(output.result));
			} else {
				journal.succeed(input.invocationId, output);
			}
			return rpcJsonValueSchema.parse(output);
		} catch (error) {
			if (error instanceof McpToolOutcomeUnknownError) {
				journal.outcomeUnknown(input.invocationId, safeError(error));
				throw new RpcHandlerError(
					"RUNTIME_BOX_MCP_TOOL_OUTCOME_UNKNOWN",
					"MCP Tool outcome is unknown and requires reconciliation.",
				);
			}
			if (executionSignal?.signal.aborted) {
				journal.cancel(input.invocationId, safeError(executionSignal.signal.reason));
				throw new RpcHandlerError(
					"RUNTIME_BOX_TOOL_CANCELLED",
					safeError(executionSignal.signal.reason),
				);
			}
			try {
				journal.fail(input.invocationId, safeError(error));
			} catch (journalError) {
				throw new RpcHandlerError("RUNTIME_BOX_INVOCATION_JOURNAL_FAILED", safeError(journalError));
			}
			if (error instanceof RpcHandlerError) {
				throw error;
			}
			throw new RpcHandlerError("RUNTIME_BOX_MCP_TOOL_FAILED", safeError(error));
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

export const mcpToolRequestMethod = productRpcMethods.runtimeBoxMcpToolInvoke;

function safeError(error: unknown): string {
	return truncateUtf8FromEnd(
		error instanceof Error ? error.message : String(error),
		1_024,
		"[earlier output truncated]\n",
	);
}

function mcpReportedError(result: RuntimeBoxMcpToolInvokeOutput["result"]): string {
	if (
		typeof result === "object" &&
		result !== null &&
		!Array.isArray(result) &&
		"content" in result &&
		Array.isArray(result.content)
	) {
		const text = result.content
			.flatMap((block) =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
					? [block.text]
					: [],
			)
			.join("\n");
		if (text.trim().length > 0) {
			return safeError(text);
		}
	}
	return "MCP Tool returned an error.";
}
