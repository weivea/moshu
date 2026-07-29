import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	executorBashToolArgumentsSchema,
	executorEditToolArgumentsSchema,
	executorFindToolArgumentsSchema,
	executorGrepToolArgumentsSchema,
	executorLsToolArgumentsSchema,
	executorReadToolArgumentsSchema,
	runtimeBoxToolInvokeInputSchema,
	executorToolNames,
	executorWriteToolArgumentsSchema,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ExecutorToolProgressEvent,
} from "@moshu/contracts";

export interface ExecutorToolGateway {
	invoke(
		input: ExecutorToolInvokeInput,
		options?: {
			signal?: AbortSignal;
			onProgress?: (event: ExecutorToolProgressEvent) => void;
		},
	): Promise<ExecutorToolInvokeOutput>;
}

export interface RuntimeBoxToolGateway {
	invokeForRuntimeBox(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		options?: {
			signal?: AbortSignal;
			onProgress?: (event: ExecutorToolProgressEvent) => void;
		},
	): Promise<ExecutorToolInvokeOutput>;
}

export interface ExecutorToolDefinitionOptions {
	gateway: ExecutorToolGateway;
	cwd: string;
	getRunId: () => string | undefined;
}

const pathParameter = Type.String({
	minLength: 1,
	maxLength: 32 * 1024,
	description: "File or directory path, relative to the executor workspace or absolute",
});
const positiveInteger = (description: string, maximum = Number.MAX_SAFE_INTEGER) =>
	Type.Integer({ minimum: 1, maximum, description });

const readParameters = Type.Object(
	{
		path: pathParameter,
		offset: Type.Optional(positiveInteger("1-based line offset")),
		limit: Type.Optional(positiveInteger("Maximum number of lines")),
	},
	{ additionalProperties: false },
);
const bashParameters = Type.Object(
	{
		command: Type.String({
			minLength: 1,
			maxLength: 512 * 1024,
			description: "Bash command to execute",
		}),
		timeout: Type.Optional(
			Type.Number({
				exclusiveMinimum: 0,
				maximum: 30 * 60,
				description: "Timeout in seconds; defaults to 1800",
			}),
		),
	},
	{ additionalProperties: false },
);
const editParameters = Type.Object(
	{
		path: pathParameter,
		edits: Type.Array(
			Type.Object(
				{
					oldText: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
					newText: Type.String({ maxLength: 512 * 1024 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 64 },
		),
	},
	{ additionalProperties: false },
);
const writeParameters = Type.Object(
	{
		path: pathParameter,
		content: Type.String({ maxLength: 512 * 1024 }),
	},
	{ additionalProperties: false },
);
const grepParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
		path: Type.Optional(pathParameter),
		glob: Type.Optional(Type.String({ minLength: 1, maxLength: 32 * 1024 })),
		ignoreCase: Type.Optional(Type.Boolean()),
		literal: Type.Optional(Type.Boolean()),
		context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
		limit: Type.Optional(positiveInteger("Maximum matches", 100_000)),
	},
	{ additionalProperties: false },
);
const findParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
		path: Type.Optional(pathParameter),
		limit: Type.Optional(positiveInteger("Maximum results", 100_000)),
	},
	{ additionalProperties: false },
);
const lsParameters = Type.Object(
	{
		path: Type.Optional(pathParameter),
		limit: Type.Optional(positiveInteger("Maximum entries", 100_000)),
	},
	{ additionalProperties: false },
);

export function createExecutorToolDefinitions(
	options: ExecutorToolDefinitionOptions,
): ToolDefinition[] {
	const invoke = async (
		toolCallId: string,
		call: ExecutorToolInvokeInput["call"],
		signal: AbortSignal | undefined,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<ExecutorToolInvokeOutput> => {
		const runId = options.getRunId();
		if (runId === undefined) {
			throw new Error("Executor tool call is not associated with an active agent run");
		}
		const input = runtimeBoxToolInvokeInputSchema.parse({
			schemaVersion: 1,
			invocationId: crypto.randomUUID(),
			runId,
			toolCallId,
			cwd: options.cwd,
			call,
		});
		return options.gateway.invoke(input, {
			...(signal ? { signal } : {}),
			...(onUpdate
				? {
						onProgress: (event: ExecutorToolProgressEvent) => {
							onUpdate({
								content: event.content,
								details: event.details,
							});
						},
					}
				: {}),
		});
	};
	const checkedResult = <TTool extends ExecutorToolInvokeOutput["tool"]>(
		expectedTool: TTool,
		output: ExecutorToolInvokeOutput,
	): AgentToolResult<unknown> => {
		if (output.tool !== expectedTool) {
			throw new Error(`Executor returned ${output.tool} for a ${expectedTool} tool call`);
		}
		return {
			content: output.content,
			details: "details" in output ? output.details : undefined,
		};
	};

	return [
		{
			name: "read",
			label: "read",
			description:
				"Read a text file with line offsets or inspect a JPEG, PNG, GIF, WebP, or BMP image. Text output is capped at 2000 lines or 50 KiB.",
			promptSnippet: "Read text files and supported images from the executor workspace",
			parameters: readParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "read" as const,
					arguments: executorReadToolArgumentsSchema.parse(params),
				};
				return checkedResult("read", await invoke(toolCallId, call, signal));
			},
		},
		{
			name: "bash",
			label: "bash",
			description:
				"Execute a bash command in the executor workspace. stdout and stderr are merged. The maximum timeout is 30 minutes.",
			promptSnippet: "Run shell commands in the executor workspace",
			parameters: bashParameters,
			async execute(toolCallId, params, signal, onUpdate) {
				const call = {
					tool: "bash" as const,
					arguments: executorBashToolArgumentsSchema.parse(params),
				};
				return checkedResult("bash", await invoke(toolCallId, call, signal, onUpdate));
			},
		},
		{
			name: "edit",
			label: "edit",
			description:
				"Atomically replace one or more unique text ranges in an existing file. All edits match against the original file.",
			promptSnippet: "Apply exact text replacements to an existing file",
			parameters: editParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "edit" as const,
					arguments: executorEditToolArgumentsSchema.parse(params),
				};
				return checkedResult("edit", await invoke(toolCallId, call, signal));
			},
		},
		{
			name: "write",
			label: "write",
			description:
				"Create or overwrite a UTF-8 text file, creating parent directories when needed.",
			promptSnippet: "Create or overwrite files in the executor workspace",
			parameters: writeParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "write" as const,
					arguments: executorWriteToolArgumentsSchema.parse(params),
				};
				return checkedResult("write", await invoke(toolCallId, call, signal));
			},
		},
		{
			name: "grep",
			label: "grep",
			description:
				"Search file contents with bundled ripgrep. Respects ignore files and returns paths with line numbers.",
			promptSnippet: "Search file contents with bundled ripgrep",
			parameters: grepParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "grep" as const,
					arguments: executorGrepToolArgumentsSchema.parse(params),
				};
				return checkedResult("grep", await invoke(toolCallId, call, signal));
			},
		},
		{
			name: "find",
			label: "find",
			description:
				"Find files and directories by glob with bundled fd. Returns relative POSIX paths and respects ignore files.",
			promptSnippet: "Find paths by glob with bundled fd",
			parameters: findParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "find" as const,
					arguments: executorFindToolArgumentsSchema.parse(params),
				};
				return checkedResult("find", await invoke(toolCallId, call, signal));
			},
		},
		{
			name: "ls",
			label: "ls",
			description:
				"List directory entries, including hidden entries. Results are sorted case-insensitively and directories end with '/'.",
			promptSnippet: "List directory contents in the executor workspace",
			parameters: lsParameters,
			async execute(toolCallId, params, signal) {
				const call = {
					tool: "ls" as const,
					arguments: executorLsToolArgumentsSchema.parse(params),
				};
				return checkedResult("ls", await invoke(toolCallId, call, signal));
			},
		},
	];
}

export function assertExecutorToolDefinitions(tools: readonly ToolDefinition[]): void {
	const names = tools.map((tool) => tool.name);
	if (
		names.length !== executorToolNames.length ||
		executorToolNames.some((name, index) => names[index] !== name)
	) {
		throw new Error("Agent runtime must register exactly the seven executor tools");
	}
}
