import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcConnectionClosedError, type RpcPeer, type RpcRequestContext } from "@moshu/process-rpc";
import { InvocationJournalPrepareFailedError } from "./invocation-journal";
import { createExecutorToolRequestHandler } from "./tool-handler";
import { ExecutorToolRuntime } from "./tools/index";

const testJournal = {
	begin: () => ({}),
	succeed() {},
	fail() {},
	cancel() {},
};
const localDeployment = { kind: "local", trustedRequestCwd: true } as const;

describe("Runtime Box tool request handler", () => {
	test("rejects a Remote deployment without an absolute daemon workspace", () => {
		expect(() =>
			createExecutorToolRequestHandler({} as ExecutorToolRuntime, {
				journal: testJournal,
				deployment: { kind: "remote", workspacePath: "relative/workspace" },
			}),
		).toThrow("absolute path");
	});

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
			{
				deployment: { kind: "remote", workspacePath: process.cwd() },
				journal: testJournal,
			},
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
		expect(receivedCwd).toBe(process.cwd());
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
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			deployment: localDeployment,
		});
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
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			deployment: localDeployment,
		});
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
			deployment: localDeployment,
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
		const handler = createExecutorToolRequestHandler(runtime, {
			journal,
			deployment: localDeployment,
		});
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

		await expect(handler(input, context)).resolves.toMatchObject({
			tool: "read",
		});
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
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			deployment: localDeployment,
		});
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
			deployment: localDeployment,
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
		await expect(execution).rejects.toMatchObject({
			code: "RUNTIME_BOX_TOOL_CANCELLED",
		});
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
			journal,
			deployment: { kind: "remote", workspacePath: root },
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
			expect(beginCalls).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	});

	test("selects Remote cwd per invocation without changing trusted Local request-cwd", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "moshu-per-invocation-cwd-")));
		const workspace = join(root, "workspace");
		const project = join(root, "project");
		mkdirSync(workspace);
		mkdirSync(project);
		const received: string[] = [];
		const runtime = {
			async execute(input: { invocationId: string; cwd: string; call: { tool: string } }) {
				received.push(input.cwd);
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: input.call.tool,
					content: [{ type: "text" as const, text: "ok" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			deployment: { kind: "remote", workspacePath: workspace },
		});
		try {
			await handler(createBashInput("/ignored/server/cwd"), createRequestContext());
			await handler(
				{
					...createBashInput(project),
					authorization: projectAuthorization(),
				},
				createRequestContext(),
			);
			const localHandler = createExecutorToolRequestHandler(runtime, {
				journal: testJournal,
				deployment: { kind: "local", trustedRequestCwd: true },
			});
			await localHandler(createReadInput(project, workspace), createRequestContext());
			expect(received).toEqual([workspace, project, project]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("contains every Project file path while explicitly exempting bash", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "moshu-project-containment-")));
		const project = join(root, "project");
		const outside = join(root, "outside");
		mkdirSync(project);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(outside, join(project, "escape"));
		symlinkSync(join(outside, "missing-target"), join(project, "dangling"));
		let beginCalls = 0;
		const received: Array<{ cwd: string; tool: string; path: string | undefined }> = [];
		const runtime = {
			async execute(input: {
				invocationId: string;
				cwd: string;
				call: { tool: string; arguments: { path?: string } };
			}) {
				received.push({
					cwd: input.cwd,
					tool: input.call.tool,
					path: input.call.arguments.path,
				});
				return {
					schemaVersion: 1 as const,
					invocationId: input.invocationId,
					tool: input.call.tool,
					content: [{ type: "text" as const, text: "ok" }],
				};
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: {
				...testJournal,
				begin() {
					beginCalls += 1;
					return {};
				},
			},
			deployment: { kind: "local", trustedRequestCwd: true },
		});
		try {
			const escapingPaths = [
				"../outside/secret.txt",
				join(outside, "secret.txt"),
				"escape/secret.txt",
				"escape/new.txt",
				"dangling",
				"dangling/new.txt",
				"file:///etc/hosts",
				"~/definitely-outside-project",
				`@${join(outside, "secret.txt")}`,
				"@../outside/secret.txt",
				...["\u00a0", "\u202f", "\u3000"].map((space) => `unicode${space}escape/secret.txt`),
			];
			symlinkSync(outside, join(project, "unicode escape"));
			for (const tool of ["read", "edit", "write", "grep", "find", "ls"] as const) {
				for (const [index, path] of escapingPaths.entries()) {
					await expect(
						handler(
							{
								...createReadInput(project, path),
								toolCallId: `escape-${tool}-${index}`,
								call: createFileToolCall(tool, path),
								authorization: projectAuthorization(),
							},
							createRequestContext(),
						),
					).rejects.toMatchObject({ code: "RUNTIME_BOX_WORKSPACE_VIOLATION" });
				}
			}
			for (const tool of ["grep", "find", "ls"] as const) {
				const call =
					tool === "grep"
						? { tool, arguments: { pattern: "needle" } }
						: tool === "find"
							? { tool, arguments: { pattern: "*" } }
							: { tool, arguments: {} };
				await handler(
					{
						...createReadInput(project, "."),
						invocationId: crypto.randomUUID(),
						toolCallId: `default-${tool}`,
						call,
						authorization: projectAuthorization(),
					},
					createRequestContext(),
				);
			}
			await handler(
				{
					...createBashInput(project),
					call: { tool: "bash", arguments: { command: `cat ${join(outside, "secret.txt")}` } },
					authorization: projectAuthorization(),
				},
				createRequestContext(),
			);
			expect(received).toEqual([
				{ cwd: project, tool: "grep", path: undefined },
				{ cwd: project, tool: "find", path: undefined },
				{ cwd: project, tool: "ls", path: undefined },
				{ cwd: project, tool: "bash", path: undefined },
			]);
			expect(beginCalls).toBe(escapingPaths.length * 6 + 4);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects read and edit fallbacks that resolve to symlinks outside the Project", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "moshu-project-fallback-containment-")));
		const project = join(root, "project");
		const outside = join(root, "outside");
		mkdirSync(project);
		mkdirSync(outside);
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "secret");
		const fallbacks = [
			["smart'quote.txt", "smart\u2019quote.txt"],
			["caf\u00e9.txt", "cafe\u0301.txt"],
			["report AM.txt", "report\u202fAM.txt"],
		] as const;
		for (const [, fallback] of fallbacks) {
			symlinkSync(secret, join(project, fallback));
		}
		const handler = createExecutorToolRequestHandler(
			{
				async execute() {
					throw new Error("Escaping fallback must not execute.");
				},
			} as unknown as ExecutorToolRuntime,
			{
				journal: testJournal,
				deployment: { kind: "local", trustedRequestCwd: true },
			},
		);
		try {
			for (const [primary] of fallbacks) {
				for (const tool of ["read", "edit"] as const) {
					await expect(
						handler(
							{
								...createReadInput(project, primary),
								invocationId: crypto.randomUUID(),
								toolCallId: `fallback-${tool}-${primary}`,
								call: createFileToolCall(tool, primary),
								authorization: projectAuthorization(),
							},
							createRequestContext(),
						),
					).rejects.toMatchObject({ code: "RUNTIME_BOX_WORKSPACE_VIOLATION" });
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps Unicode read and edit fallbacks inside the Project", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "moshu-project-unicode-fallbacks-")));
		const project = join(root, "project");
		mkdirSync(project);
		const fallbacks = [
			["smart'quote.txt", "smart\u2019quote.txt"],
			["caf\u00e9.txt", "cafe\u0301.txt"],
			["report AM.txt", "report\u202fAM.txt"],
		] as const;
		for (const [, fallback] of fallbacks) {
			writeFileSync(join(project, fallback), "old");
		}
		const handler = createExecutorToolRequestHandler(new ExecutorToolRuntime({ rg: "", fd: "" }), {
			journal: testJournal,
			deployment: { kind: "local", trustedRequestCwd: true },
		});
		try {
			for (const [primary, fallback] of fallbacks) {
				const read = await handler(
					{
						...createReadInput(project, primary),
						invocationId: crypto.randomUUID(),
						toolCallId: `unicode-read-${primary}`,
						authorization: projectAuthorization(),
					},
					createRequestContext(),
				);
				expect(read).toMatchObject({ tool: "read", content: [{ type: "text", text: "old" }] });
				await handler(
					{
						...createReadInput(project, primary),
						invocationId: crypto.randomUUID(),
						toolCallId: `unicode-edit-${primary}`,
						call: createFileToolCall("edit", primary),
						authorization: projectAuthorization(),
					},
					createRequestContext(),
				);
				await expect(Bun.file(join(project, fallback)).text()).resolves.toBe("new");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns stable Project cwd validation errors", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "moshu-project-cwd-errors-")));
		const project = join(root, "project");
		const projectLink = join(root, "project-link");
		const file = join(root, "file");
		mkdirSync(project);
		symlinkSync(project, projectLink);
		writeFileSync(file, "not a directory");
		const runtime = {
			async execute() {
				throw new Error("invalid cwd must not execute");
			},
		} as unknown as ExecutorToolRuntime;
		const handler = createExecutorToolRequestHandler(runtime, {
			journal: testJournal,
			deployment: { kind: "local", trustedRequestCwd: true },
		});
		try {
			for (const [cwd, code] of [
				[projectLink, "RUNTIME_BOX_PROJECT_CWD_NOT_CANONICAL"],
				[file, "RUNTIME_BOX_PROJECT_CWD_NOT_DIRECTORY"],
				[join(root, "missing"), "RUNTIME_BOX_PROJECT_CWD_NOT_FOUND"],
			] as const) {
				await expect(
					handler(
						{
							...createBashInput(cwd),
							authorization: projectAuthorization(),
						},
						createRequestContext(),
					),
				).rejects.toMatchObject({ code });
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function createBashInput(cwd: string) {
	return {
		schemaVersion: 1 as const,
		invocationId: crypto.randomUUID(),
		runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
		toolCallId: "bash-tool-call",
		cwd,
		call: { tool: "bash" as const, arguments: { command: "pwd" } },
	};
}

function createReadInput(cwd: string, path: string) {
	return {
		schemaVersion: 1 as const,
		invocationId: crypto.randomUUID(),
		runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
		toolCallId: "read-tool-call",
		cwd,
		call: { tool: "read" as const, arguments: { path } },
	};
}

function createFileToolCall(
	tool: "read" | "edit" | "write" | "grep" | "find" | "ls",
	path: string,
) {
	switch (tool) {
		case "read":
			return { tool, arguments: { path } };
		case "edit":
			return { tool, arguments: { path, edits: [{ oldText: "old", newText: "new" }] } };
		case "write":
			return { tool, arguments: { path, content: "content" } };
		case "grep":
			return { tool, arguments: { path, pattern: "needle" } };
		case "find":
			return { tool, arguments: { path, pattern: "*" } };
		case "ls":
			return { tool, arguments: { path } };
	}
}

function projectAuthorization() {
	return {
		actionId: crypto.randomUUID(),
		grantId: crypto.randomUUID(),
		grantToken: Buffer.alloc(32, 7).toString("base64url"),
		parameterDigest: "a".repeat(64),
		originInstanceId: "agents-instance",
		originGeneration: 1,
		targetRuntimeBoxId: "runtime-box",
		targetInstanceId: "runtime-instance",
		targetGeneration: 1,
		executionScope: "project-root" as const,
		projectPathRevision: 1,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
}
