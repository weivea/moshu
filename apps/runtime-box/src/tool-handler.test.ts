import { describe, expect, test } from "bun:test";
import type { RpcPeer, RpcRequestContext } from "@moshu/process-rpc";
import type { ExecutorToolRuntime } from "./tools/index";
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
});
