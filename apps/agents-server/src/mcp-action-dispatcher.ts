import type { McpToolGateway } from "@moshu/agent-runtime";
import {
	runtimeBoxMcpToolInvokeInputSchema,
	runtimeBoxMcpToolInvokeOutputSchema,
	type McpOwner,
	type RuntimeBoxMcpToolInvokeInput,
	type RuntimeBoxMcpToolInvokeOutput,
} from "@moshu/contracts";
import {
	McpDefinitiveResponseError,
	McpToolNotReadyError,
	McpToolOutcomeUnknownError,
} from "@moshu/mcp-runtime";

import type { DurableActionAuthorizationService } from "./action-authorization-service";

interface RuntimeBoxMcpGateway {
	invokeMcpForRuntimeBox(
		runtimeBoxId: string,
		input: RuntimeBoxMcpToolInvokeInput,
		options?: { signal?: AbortSignal },
	): Promise<RuntimeBoxMcpToolInvokeOutput>;
}

interface LocalMcpLifecycle {
	isToolReady(
		stableResourceId: string,
		stableToolId: string,
		expected: { version: string; contentHash: string; schemaHash: string },
	): boolean;
	callTool(
		stableResourceId: string,
		stableToolId: string,
		argumentsValue: RuntimeBoxMcpToolInvokeInput["arguments"],
		expected: { version: string; contentHash: string; schemaHash: string },
		signal?: AbortSignal,
	): Promise<RuntimeBoxMcpToolInvokeOutput["result"]>;
}

export class McpActionDispatcher implements McpToolGateway {
	readonly #activeAgentServerInvocations = new Set<string>();

	constructor(
		private readonly agentServerId: string,
		private readonly runtimeBoxes: RuntimeBoxMcpGateway,
		private readonly agentServerLifecycle: LocalMcpLifecycle,
		private readonly authorizer: DurableActionAuthorizationService,
	) {}

	invokeMcp(
		owner: McpOwner,
		inputValue: RuntimeBoxMcpToolInvokeInput,
		options: { signal?: AbortSignal } = {},
	): Promise<RuntimeBoxMcpToolInvokeOutput> {
		if (owner.kind === "runtime-box") {
			return this.runtimeBoxes.invokeMcpForRuntimeBox(owner.runtimeBoxId, inputValue, options);
		}
		return this.#invokeAgentServer(inputValue, options.signal);
	}

	async #invokeAgentServer(
		inputValue: RuntimeBoxMcpToolInvokeInput,
		signal?: AbortSignal,
	): Promise<RuntimeBoxMcpToolInvokeOutput> {
		const input = runtimeBoxMcpToolInvokeInputSchema.parse(inputValue);
		signal?.throwIfAborted();
		if (
			!this.agentServerLifecycle.isToolReady(input.mcpServerId, input.stableToolId, {
				version: input.mcpServerVersion,
				contentHash: input.mcpServerContentHash,
				schemaHash: input.toolSchemaHash,
			})
		) {
			throw new Error("Agent Server MCP Tool is not part of the live ready inventory.");
		}
		if (this.#activeAgentServerInvocations.has(input.invocationId)) {
			throw new Error(`Agent Server MCP invocation ${input.invocationId} is already active.`);
		}
		await this.authorizer.authorizeAgentServerMcp(this.agentServerId, input);
		if (signal?.aborted) {
			this.authorizer.cancel(input, safeError(signal.reason));
			signal.throwIfAborted();
		}
		this.#activeAgentServerInvocations.add(input.invocationId);
		try {
			const result = await this.agentServerLifecycle.callTool(
				input.mcpServerId,
				input.stableToolId,
				input.arguments,
				{
					version: input.mcpServerVersion,
					contentHash: input.mcpServerContentHash,
					schemaHash: input.toolSchemaHash,
				},
				signal,
			);
			const output = runtimeBoxMcpToolInvokeOutputSchema.parse({
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
			if (output.isError) {
				this.authorizer.fail(input, mcpReportedError(output));
			} else {
				this.authorizer.completeAgentServerMcp(this.agentServerId, input, output);
			}
			return output;
		} catch (error) {
			if (error instanceof McpToolOutcomeUnknownError) {
				this.authorizer.markOutcomeUnknown(input, safeError(error));
			} else if (error instanceof McpDefinitiveResponseError) {
				this.authorizer.fail(input, safeError(error));
			} else if (error instanceof McpToolNotReadyError) {
				this.authorizer.cancel(input, safeError(error));
			} else if (signal?.aborted) {
				this.authorizer.cancel(input, safeError(signal.reason));
			} else {
				this.authorizer.markOutcomeUnknown(input, safeError(error));
			}
			throw error;
		} finally {
			this.#activeAgentServerInvocations.delete(input.invocationId);
		}
	}
}

function mcpReportedError(output: RuntimeBoxMcpToolInvokeOutput): string {
	if (
		typeof output.result === "object" &&
		output.result !== null &&
		!Array.isArray(output.result) &&
		"content" in output.result &&
		Array.isArray(output.result.content)
	) {
		const text = output.result.content
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
			return text.slice(-1_024);
		}
	}
	return "MCP Tool returned an error.";
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(-1_024);
}
