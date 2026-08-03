import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	mcpToolArgumentsSchema,
	runtimeBoxMcpToolInvokeInputSchema,
	type McpToolDescriptor,
	type McpOwner,
	type RuntimeBoxMcpToolInvokeInput,
	type RuntimeBoxMcpToolInvokeOutput,
} from "@moshu/contracts";

export interface AgentMcpResource {
	owner: McpOwner;
	stableResourceId: string;
	version: string;
	contentHash: string;
	tools: readonly McpToolDescriptor[];
	/** Values injected into this MCP connection and eligible for exact public-projection redaction. */
	projectionSecretValues?: readonly string[];
}

export interface McpToolGateway {
	invokeMcp(
		owner: McpOwner,
		input: RuntimeBoxMcpToolInvokeInput,
		options?: { signal?: AbortSignal },
	): Promise<RuntimeBoxMcpToolInvokeOutput>;
}

export function createMcpToolDefinitions(input: {
	resources: readonly AgentMcpResource[];
	gateway: McpToolGateway;
	getRunId: () => string | undefined;
}): ToolDefinition[] {
	const names = new Set<string>();
	const definitions: ToolDefinition[] = [];
	for (const resource of input.resources) {
		for (const tool of resource.tools) {
			const name = createAgentMcpToolName(
				resource.owner,
				resource.stableResourceId,
				tool.stableToolId,
			);
			if (names.has(name)) {
				throw new Error("MCP Tool names collide after normalization.");
			}
			names.add(name);
			definitions.push({
				name,
				label: tool.name,
				description:
					tool.description ??
					`Invoke ${tool.name} from ${ownerLabel(resource.owner)} MCP Server ${resource.stableResourceId}.`,
				promptSnippet: `Use ${tool.name} from ${ownerLabel(resource.owner)} MCP Server ${resource.stableResourceId}`,
				parameters: Type.Unsafe(tool.inputSchema),
				async execute(toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
					const runId = input.getRunId();
					if (runId === undefined) {
						throw new Error("MCP Tool call is not associated with an active Agent run.");
					}
					const output = await input.gateway.invokeMcp(
						resource.owner,
						runtimeBoxMcpToolInvokeInputSchema.parse({
							schemaVersion: 1,
							invocationId: crypto.randomUUID(),
							runId,
							toolCallId,
							mcpServerId: resource.stableResourceId,
							mcpServerVersion: resource.version,
							mcpServerContentHash: resource.contentHash,
							stableToolId: tool.stableToolId,
							toolSchemaHash: tool.schemaHash,
							arguments: mcpToolArgumentsSchema.parse(params),
						}),
						signal === undefined ? {} : { signal },
					);
					const content = normalizeMcpResult(output.result);
					if (output.isError) {
						throw new Error(
							content
								.map((item) => ("text" in item ? item.text : `[${item.mimeType} image]`))
								.join("\n")
								.slice(0, 1_024) || "MCP Tool returned an error.",
						);
					}
					return { content, details: { mcpResult: output.result } };
				},
			});
		}
	}
	return definitions;
}

export function createAgentMcpToolName(
	owner: McpOwner,
	serverId: string,
	stableToolId: string,
): string {
	const normalize = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "_")
			.replace(/^_+|_+$/g, "");
	const fullServerSlug = normalize(serverId);
	const fullToolSlug = normalize(stableToolId);
	const serverSlugLength = Math.min(
		fullServerSlug.length,
		24 + Math.max(0, 29 - fullToolSlug.length),
	);
	const toolSlugLength = Math.min(fullToolSlug.length, 53 - serverSlugLength);
	const ownerId = owner.kind === "runtime-box" ? owner.runtimeBoxId : "";
	const hash = createHash("sha256")
		.update(`${owner.kind}\0${ownerId}\0${serverId}\0${stableToolId}`)
		.digest("base64url")
		.slice(0, 4);
	return `mcp_${fullServerSlug.slice(0, serverSlugLength)}_${fullToolSlug.slice(0, toolSlugLength)}_${hash}`;
}

function ownerLabel(owner: McpOwner): string {
	return owner.kind === "agent-server" ? "Agent Server-owned" : "Runtime Box-owned";
}

function normalizeMcpResult(
	result: RuntimeBoxMcpToolInvokeOutput["result"],
): AgentToolResult<unknown>["content"] {
	if (
		typeof result === "object" &&
		result !== null &&
		!Array.isArray(result) &&
		"content" in result &&
		Array.isArray(result.content)
	) {
		const content: AgentToolResult<unknown>["content"] = [];
		for (const block of result.content.slice(0, 64)) {
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				content.push({ type: "text", text: block.text.slice(0, 128 * 1024) });
				continue;
			}
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "image" &&
				"data" in block &&
				typeof block.data === "string" &&
				"mimeType" in block &&
				typeof block.mimeType === "string"
			) {
				content.push({
					type: "image",
					data: block.data.slice(0, 3 * 1024 * 1024),
					mimeType: block.mimeType,
				});
			}
		}
		if (content.length > 0) {
			return content;
		}
	}
	return [{ type: "text", text: JSON.stringify(result).slice(0, 128 * 1024) }];
}
