import { describe, expect, test } from "bun:test";
import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createExecutorToolDefinitions, type ExecutorToolGateway } from "../src";

const runId = "018f47a2-9bcd-7def-8abc-1234567890ab";
const extensionContext = {} as ExtensionContext;

describe("executor tool proxies", () => {
	test("exposes exactly the seven executor-backed tools", () => {
		const tools = createExecutorToolDefinitions({
			gateway: {
				async invoke() {
					throw new Error("Not used.");
				},
			},
			cwd: "/tmp/moshu-agent-runtime-test",
			getRunId: () => runId,
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
	});

	test("maps bash progress and forwards the tool abort signal", async () => {
		const controller = new AbortController();
		const updates: AgentToolResult<unknown>[] = [];
		const gateway: ExecutorToolGateway = {
			async invoke(input, options) {
				if (options === undefined) {
					throw new Error("Expected executor invocation options.");
				}
				expect(options.signal).toBe(controller.signal);
				options.onProgress?.({
					schemaVersion: 1,
					invocationId: input.invocationId,
					tool: "bash",
					sequence: 0,
					content: [{ type: "text", text: "partial output" }],
				});

				return {
					schemaVersion: 1,
					invocationId: input.invocationId,
					tool: "bash",
					content: [{ type: "text", text: "complete output" }],
				};
			},
		};
		const bash = requireTool(createTools(gateway), "bash");

		const result = await bash.execute(
			"bash-call",
			{ command: "printf test" },
			controller.signal,
			(update) => updates.push(update),
			extensionContext,
		);

		expect(updates).toEqual([
			{
				content: [{ type: "text", text: "partial output" }],
				details: undefined,
			},
		]);
		expect(result).toEqual({
			content: [{ type: "text", text: "complete output" }],
			details: undefined,
		});
	});

	test("forwards Project execution scope separately from cwd", async () => {
		let observed:
			| {
					cwd: string;
					executionContext: unknown;
			  }
			| undefined;
		const read = requireTool(
			createExecutorToolDefinitions({
				gateway: {
					async invoke(input, options) {
						observed = { cwd: input.cwd, executionContext: options?.executionContext };
						return {
							schemaVersion: 1,
							invocationId: input.invocationId,
							tool: "read",
							content: [{ type: "text", text: "ok" }],
						};
					},
				},
				cwd: "/projects/example",
				executionContext: {
					executionScope: "project-root",
					projectPathRevision: 7,
				},
				getRunId: () => runId,
			}),
			"read",
		);
		await read.execute(
			"read-project",
			{ path: "README.md" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(observed).toEqual({
			cwd: "/projects/example",
			executionContext: {
				executionScope: "project-root",
				projectPathRevision: 7,
			},
		});
	});

	test("propagates executor failures and cancellation without a local fallback", async () => {
		const unavailable = requireTool(
			createExecutorToolDefinitions({
				gateway: {
					async invoke() {
						throw new Error("The local executor is unavailable.");
					},
				},
				cwd: "/tmp/moshu-agent-runtime-test",
				getRunId: () => runId,
			}),
			"read",
		);
		await expect(
			unavailable.execute(
				"read-call",
				{ path: "README.md" },
				undefined,
				undefined,
				extensionContext,
			),
		).rejects.toThrow("local executor is unavailable");

		const controller = new AbortController();
		const cancellable = requireTool(
			createExecutorToolDefinitions({
				gateway: {
					invoke(_input, options) {
						return new Promise((_resolve, reject) => {
							const signal = options?.signal;
							if (signal === undefined) {
								reject(new Error("Expected an executor cancellation signal."));
								return;
							}
							const rejectAborted = () =>
								reject(
									signal.reason instanceof Error
										? signal.reason
										: new Error("Executor tool invocation cancelled."),
								);
							if (signal.aborted) {
								rejectAborted();
								return;
							}
							signal.addEventListener("abort", rejectAborted, { once: true });
						});
					},
				},
				cwd: "/tmp/moshu-agent-runtime-test",
				getRunId: () => runId,
			}),
			"read",
		);
		const pending = cancellable.execute(
			"cancelled-read",
			{ path: "README.md" },
			controller.signal,
			undefined,
			extensionContext,
		);
		controller.abort(new Error("cancelled by test"));
		await expect(pending).rejects.toThrow("cancelled by test");
	});

	test("rejects invalid arguments before invoking the gateway", async () => {
		let invoked = false;
		const bash = requireTool(
			createExecutorToolDefinitions({
				gateway: {
					async invoke() {
						invoked = true;
						throw new Error("Should not be reached.");
					},
				},
				cwd: "/tmp/moshu-agent-runtime-test",
				getRunId: () => runId,
			}),
			"bash",
		);
		await expect(
			bash.execute("invalid-bash", { command: "" }, undefined, undefined, extensionContext),
		).rejects.toThrow();
		expect(invoked).toBe(false);
	});
});

function createTools(gateway: ExecutorToolGateway): ToolDefinition[] {
	return createExecutorToolDefinitions({
		gateway,
		cwd: "/tmp/moshu-agent-runtime-test",
		getRunId: () => runId,
	});
}

function requireTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) {
		throw new Error(`Expected executor tool ${name}.`);
	}
	return tool;
}
