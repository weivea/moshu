import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcConnectionClosedError, type RpcPeer, type RpcRequestContext } from "@moshu/process-rpc";
import type { ExecutorToolRuntime } from "./tools/index";
import { InvocationJournalPrepareFailedError } from "./invocation-journal";
import { createExecutorToolRequestHandler } from "./tool-handler";

const testJournal = {
	begin: () => ({}),
	succeed() {},
	fail() {},
	cancel() {},
};

describe("Runtime Box tool request handler", () => {
	test("uses the Runtime Box-owned cwd when configured", async () => {
		let receivedCwd: string | undefined;
		const runtime = {
			async execute(input: { cwd: string }) {
				receivedCwd = input.cwd;
				return {
					schemaVersion: 1 as const,
					invocationId: "550e8400-e29b-41d4-a716-446655440000",
					tool: "read" as const,
					content: [{ type: "text" as const, text: "ok" }],
				};
			},
		};
		const handler = createExecutorToolRequestHandler(
			runtime as unknown as Parameters<typeof createExecutorToolRequestHandler>[0],
			{ cwd: "/remote/workspace", journal: testJournal },
		);
		await handler(
			{
				schemaVersion: 1,
				invocationId: "550e8400-e29b-41d4-a716-446655440000",
				runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
				toolCallId: "tool-call",
				cwd: "/server/workspace",
				call: { tool: "read", arguments: { path: "README.md" } },
			},
			createRequestContext(),
		);
		expect(receivedCwd).toBe("/remote/workspace");
	});

	function createRequestContext(): RpcRequestContext {
		return {
			peer: { emitEvent() {} } as unknown as RpcPeer,
			remoteIdentity: {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 1,
			},
			signal: new AbortController().signal,
			traceId: "trace",
			requestId: "request",
			method: "moshu.v1.runtimeBox.tool.invoke",
			deadlineAt: Date.now() + 1_000,
		};
	}
	test("bounds tool failure messages to the process RPC contract", async () => {
		const runtime = {
			async execute() {
				throw new Error(`failure:${"x".repeat(4_096)}`);
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, { journal: testJournal });
		const input = {
			schemaVersion: 1,
			invocationId: crypto.randomUUID(),
			runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
			toolCallId: "tool-call",
			cwd: process.cwd(),
			call: {
				tool: "bash",
				arguments: { command: "exit 1" },
			},
		};
		const peer = {
			emitEvent() {},
		} as unknown as RpcPeer;
		const context: RpcRequestContext = {
			peer,
			remoteIdentity: {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 1,
			},
			signal: new AbortController().signal,
			traceId: "trace",
			requestId: "request",
			method: "moshu.v1.runtimeBox.tool.invoke",
			deadlineAt: Date.now() + 1_000,
		};

		const error = await Promise.resolve(handler(input, context)).catch((reason: unknown) => reason);
		expect(error).toMatchObject({ code: "RUNTIME_BOX_TOOL_FAILED" });
		expect(Buffer.byteLength((error as Error).message, "utf8")).toBeLessThanOrEqual(1_024);
		expect((error as Error).message).toContain("[earlier output truncated]");
	});

	test("preserves the retained-output path in a bounded long failure", async () => {
		const runtime = {
			async execute() {
				throw new Error(
					`${"early output\n".repeat(500)}Full output: /private/output/bash.log\n\nCommand exited with code 7`,
				);
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, { journal: testJournal });
		const context: RpcRequestContext = {
			peer: { emitEvent() {} } as unknown as RpcPeer,
			remoteIdentity: {
				role: "agents",
				peerId: "agents",
				instanceId: "agents-instance",
				generation: 1,
			},
			signal: new AbortController().signal,
			traceId: "trace",
			requestId: "request",
			method: "moshu.v1.runtimeBox.tool.invoke",
			deadlineAt: Date.now() + 1_000,
		};
		const error = await Promise.resolve(
			handler(
				{
					schemaVersion: 1,
					invocationId: crypto.randomUUID(),
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					toolCallId: "tool-call",
					cwd: process.cwd(),
					call: { tool: "bash", arguments: { command: "exit 7" } },
				},
				context,
			),
		).catch((reason: unknown) => reason);
		expect((error as Error).message).toContain("Full output: /private/output/bash.log");
		expect((error as Error).message).toContain("Command exited with code 7");
		expect(Buffer.byteLength((error as Error).message, "utf8")).toBeLessThanOrEqual(1_024);
	});

	test("keeps an Action running when progress publication loses the transport", async () => {
		let reportedError: unknown;
		const runtime = {
			async execute(
				input: { invocationId: string },
				options: { onProgress?: (event: unknown) => void },
			) {
				options.onProgress?.({
					schemaVersion: 1,
					invocationId: input.invocationId,
					tool: "bash",
					sequence: 0,
					content: [],
				});
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: "bash" as const,
					content: [{ type: "text" as const, text: "completed" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			onProgressError(error) {
				reportedError = error;
			},
		});
		const context: RpcRequestContext = {
			...createRequestContext(),
			peer: {
				isClosed: false,
				emitEvent() {
					throw new RpcConnectionClosedError(1006, "transport lost");
				},
			} as unknown as RpcPeer,
		};

		await expect(
			handler(
				{
					schemaVersion: 1,
					invocationId: crypto.randomUUID(),
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					toolCallId: "progress-transport-loss",
					cwd: process.cwd(),
					call: { tool: "bash", arguments: { command: "printf completed" } },
				},
				context,
			),
		).resolves.toMatchObject({ tool: "bash" });
		expect(reportedError).toBeInstanceOf(RpcConnectionClosedError);
	});

	test("releases the active invocation after journal preparation fails", async () => {
		let attempts = 0;
		const journal = {
			begin() {
				attempts += 1;
				if (attempts === 1) {
					throw new InvocationJournalPrepareFailedError("journal unavailable");
				}
				return {};
			},
			succeed() {},
			fail() {},
			cancel() {},
		};
		const runtime = {
			async execute(input: { invocationId: string }) {
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: "read" as const,
					content: [{ type: "text" as const, text: "ok" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, { journal });
		const input = {
			schemaVersion: 1,
			invocationId: crypto.randomUUID(),
			runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
			toolCallId: "tool-call",
			cwd: process.cwd(),
			call: { tool: "read", arguments: { path: "README.md" } },
		};
		const context = createRequestContext();
		await expect(handler(input, context)).rejects.toMatchObject({
			code: "RUNTIME_BOX_INVOCATION_JOURNAL_PREPARE_FAILED",
		});

		await expect(handler(input, context)).resolves.toMatchObject({ tool: "read" });
	});

	test("keeps a started Action alive across transport loss until its lease", async () => {
		const completed = Promise.withResolvers<void>();
		let executionSignal: AbortSignal | undefined;
		const runtime = {
			async execute(input: { invocationId: string }, options: { signal: AbortSignal }) {
				executionSignal = options.signal;
				await completed.promise;
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: "read" as const,
					content: [{ type: "text" as const, text: "completed after reconnect" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, { journal: testJournal });
		const requestController = new AbortController();
		const execution = handler(
			{
				schemaVersion: 1,
				invocationId: crypto.randomUUID(),
				runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
				toolCallId: "transport-loss",
				cwd: process.cwd(),
				call: { tool: "read", arguments: { path: "README.md" } },
			},
			{
				...createRequestContext(),
				signal: requestController.signal,
				deadlineAt: Date.now() + 1_000,
			},
		);
		await Bun.sleep(0);
		requestController.abort(new RpcConnectionClosedError(1006, "transport lost"));
		expect(executionSignal?.aborted).toBe(false);
		completed.resolve();
		await expect(execution).resolves.toMatchObject({ tool: "read" });
	});

	test("cancels and drains an active Action when the Runtime Box shuts down", async () => {
		const started = Promise.withResolvers<void>();
		let executionSignal: AbortSignal | undefined;
		const runtime = {
			async execute(_input: unknown, options: { signal: AbortSignal }) {
				executionSignal = options.signal;
				started.resolve();
				await new Promise<never>((_resolve, reject) => {
					const abort = () => reject(options.signal.reason);
					options.signal.addEventListener("abort", abort, { once: true });
					if (options.signal.aborted) {
						abort();
					}
				});
			},
		} as unknown as ExecutorToolRuntime;
		const lifecycle = new AbortController();
		const activeExecutions = new Set<Promise<unknown>>();
		let cancellationReason: string | undefined;
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: {
				...testJournal,
				cancel(_invocationId, reason) {
					cancellationReason = reason;
				},
			},
			lifecycleSignal: lifecycle.signal,
			activeExecutions,
		});
		const execution = handler(
			{
				schemaVersion: 1,
				invocationId: crypto.randomUUID(),
				runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
				toolCallId: "shutdown",
				cwd: process.cwd(),
				call: { tool: "read", arguments: { path: "README.md" } },
			},
			createRequestContext(),
		);
		await started.promise;
		expect(activeExecutions.size).toBe(1);

		lifecycle.abort(new Error("Runtime Box is shutting down."));
		await expect(execution).rejects.toMatchObject({ code: "RUNTIME_BOX_TOOL_CANCELLED" });
		expect(executionSignal?.aborted).toBe(true);
		expect(activeExecutions.size).toBe(0);
		expect(cancellationReason).toBe("Runtime Box is shutting down.");
	});

	test("rejects path escapes but allows trusted remote bash", async () => {
		const root = mkdtempSync(join(tmpdir(), "moshu-contained-tools-"));
		const outside = join(root, "..", `outside-${crypto.randomUUID()}.txt`);
		writeFileSync(outside, "secret");
		let beginCalls = 0;
		const journal = {
			begin() {
				beginCalls += 1;
				return {};
			},
			succeed() {},
			fail() {},
			cancel() {},
		};
		const runtime = {
			async execute(input: { invocationId: string }) {
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: "bash" as const,
					content: [{ type: "text" as const, text: "trusted bash" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, {
			cwd: root,
			journal,
			enforceCwdContainment: true,
		});
		try {
			await expect(
				handler(
					{
						schemaVersion: 1,
						invocationId: crypto.randomUUID(),
						runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
						toolCallId: "read-escape",
						cwd: root,
						call: { tool: "read", arguments: { path: outside } },
					},
					createRequestContext(),
				),
			).rejects.toMatchObject({ code: "RUNTIME_BOX_WORKSPACE_VIOLATION" });
			await expect(
				handler(
					{
						schemaVersion: 1,
						invocationId: crypto.randomUUID(),
						runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
						toolCallId: "bash-disabled",
						cwd: root,
						call: { tool: "bash", arguments: { command: "cat ../secret" } },
					},
					createRequestContext(),
				),
			).resolves.toMatchObject({ tool: "bash" });
			expect(beginCalls).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	});
});
