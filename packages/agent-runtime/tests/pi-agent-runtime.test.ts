import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	defaultLocalRuntimeBoxId,
	type ExecutorToolInvokeInput,
	type RuntimeBoxMcpToolInvokeInput,
} from "@moshu/contracts";

import {
	AskChatCancelledError,
	AskChatRuntimeError,
	createAgentMcpToolName,
	type ExecutorToolGateway,
	PiAgentRuntime,
	type RuntimeBoxToolGateway,
} from "../src";

const sessionId = "0198a20c-6f76-7e18-92da-353e2fc25b3e";
const unavailableExecutorGateway: ExecutorToolGateway = {
	async invoke() {
		throw new Error("Executor must not be called in this test");
	},
};

describe("Pi Agent runtime", () => {
	test("streams, persists, restores, and deletes an Agent session", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-runtime-test",
				models: [{ id: "deterministic" }],
			});
			faux.setResponses([fauxAssistantMessage("A deterministic answer.")]);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDataDirectory, "unused-auth.json"),
				modelsPath: null,
				allowModelNetwork: false,
			});
			modelRuntime.registerNativeProvider(faux.provider);
			const model = faux.getModel();
			if (model === undefined) throw new Error("Expected the fake Provider model.");
			const provider = {
				providerId: faux.provider.id,
				providerName: faux.provider.name,
				source: "builtin" as const,
				api: model.api,
				model: model.id,
			};
			const first = new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				runtimeBoxGateway: toRuntimeBoxGateway(unavailableExecutorGateway),
			});
			const deltas: string[] = [];
			const stream = first.stream({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				executionContext: { kind: "session" },
				runId: "run-1",
				threadId: sessionId,
				provider,
				messages: [{ role: "user", content: "Answer deterministically." }],
				onEvent: (event) => {
					deltas.push(event.delta);
				},
			});
			for await (const _event of stream) {
				// Drain the public stream.
			}
			expect((await stream.result).text).toBe("A deterministic answer.");
			expect(deltas.join("")).toBe("A deterministic answer.");
			expect((await stream.result).usage?.totalTokens).toBeGreaterThan(0);
			await first.shutdown();

			const restored = new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				runtimeBoxGateway: toRuntimeBoxGateway(unavailableExecutorGateway),
			});
			await expect(restored.getThreadMessages("../outside")).rejects.toThrow("Pi session IDs");
			expect(await restored.getThreadMessages(sessionId)).toEqual([
				{ role: "user", content: "Answer deterministically." },
				{ role: "assistant", content: "A deterministic answer." },
			]);
			await restored.deleteThread(sessionId);
			expect(await restored.getThreadMessages(sessionId)).toEqual([]);
			await restored.shutdown();
		});
	});

	test("continues the standard tool loop through an executor-only proxy", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-tool-test",
				models: [{ id: "tool-model" }],
			});

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The executor returned the file."),
			]);
			const calls: ExecutorToolInvokeInput[] = [];
			const gateway: ExecutorToolGateway = {
				async invoke(input) {
					calls.push(input);
					return {
						schemaVersion: 1,
						invocationId: input.invocationId,
						tool: "read",
						content: [{ type: "text", text: "executor file contents" }],
					};
				},
			};
			const runtimeBoxId = "remote-tool-box";
			const { runtime, provider } = await createRuntime(
				agentDataDirectory,
				faux,
				gateway,
				runtimeBoxId,
			);
			try {
				const result = await runtime.run({
					runtimeBoxId,
					executionContext: { kind: "session" },
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					threadId: "tool-thread",
					provider,
					messages: [{ role: "user", content: "Read the file." }],
				});
				expect(result.text).toBe("The executor returned the file.");
				expect(calls).toHaveLength(1);
				expect(calls[0]).toMatchObject({
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					cwd: join(agentDataDirectory, "workspace"),
					call: { tool: "read", arguments: { path: "README.md" } },
				});
			} finally {
				await runtime.shutdown();
			}
		});
	});

	test("loads verified Skills in memory and routes MCP Tools through the Runtime Box gateway", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-resource-test",
				models: [{ id: "resource-model" }],
			});

			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(
							createAgentMcpToolName(
								{ kind: "runtime-box", runtimeBoxId: defaultLocalRuntimeBoxId },
								"database-tools",
								"tool-query",
							),
							{ sql: "select 1" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The MCP query completed."),
			]);
			const modelRuntime = await createModelRuntime(agentDataDirectory, faux.provider);
			const model = faux.getModel();
			if (model === undefined) {
				throw new Error("Expected the fake Provider model.");
			}
			const mcpCalls: RuntimeBoxMcpToolInvokeInput[] = [];
			const runtime = new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				runtimeBoxGateway: {
					async invokeForRuntimeBox() {
						throw new Error("Executor Tool should not be called.");
					},
				},
				mcpToolGateway: {
					async invokeMcp(owner, input) {
						expect(owner).toEqual({
							kind: "runtime-box",
							runtimeBoxId: defaultLocalRuntimeBoxId,
						});
						mcpCalls.push(input);
						return {
							schemaVersion: 1,
							invocationId: input.invocationId,
							mcpServerId: input.mcpServerId,
							stableToolId: input.stableToolId,
							result: { content: [{ type: "text", text: "one row" }] },
							isError: false,
						};
					},
				},
			});
			const skillMarker = "SKILL-CONTENT-MUST-STAY-IN-MEMORY";
			try {
				const result = await runtime.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					executionContext: { kind: "session" },
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					threadId: "resource-thread",
					provider: {
						providerId: faux.provider.id,
						providerName: faux.provider.name,
						source: "builtin",
						api: model.api,
						model: model.id,
					},
					messages: [{ role: "user", content: "Use the database Skill." }],
					skills: [
						{
							owner: {
								kind: "runtime-box",
								runtimeBoxId: defaultLocalRuntimeBoxId,
							},
							stableResourceId: "database-skill",
							version: "550e8400-e29b-41d4-a716-446655440000",
							contentHash: "b".repeat(64),
							metadata: {
								name: "database-skill",
								description: "Query data",
								allowedTools: [],
								metadata: {},
							},
							skillMarkdown: `---\nname: database-skill\ndescription: Query data\n---\n${skillMarker}`,
						},
					],
					mcpResources: [
						{
							owner: {
								kind: "runtime-box",
								runtimeBoxId: defaultLocalRuntimeBoxId,
							},
							stableResourceId: "database-tools",
							version: "550e8400-e29b-41d4-a716-446655440001",
							contentHash: "c".repeat(64),
							tools: [
								{
									stableToolId: "tool-query",
									name: "query",
									schemaHash: "d".repeat(64),
									inputSchema: {
										type: "object",
										properties: { sql: { type: "string" } },
										required: ["sql"],
									},
								},
							],
						},
					],
				});
				expect(result.text).toBe("The MCP query completed.");
				expect(mcpCalls).toMatchObject([
					{
						runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
						mcpServerId: "database-tools",
						stableToolId: "tool-query",
						arguments: { sql: "select 1" },
					},
				]);
			} finally {
				await runtime.shutdown();
			}
			const persistedSessionText = readdirSync(join(agentDataDirectory, "sessions"))
				.map((filename) => readFileSync(join(agentDataDirectory, "sessions", filename), "utf8"))
				.join("\n");
			expect(persistedSessionText).not.toContain(skillMarker);
		});
	});

	test("rebuilds Project resources on execution-context changes without persisting AGENTS.md", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-project-context-test",
				models: [{ id: "project-model" }],
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("second answer"),
			]);
			const calls: Array<{
				input: ExecutorToolInvokeInput;
				executionContext: unknown;
			}> = [];
			const gateway: ExecutorToolGateway = {
				async invoke(input, options) {
					calls.push({ input, executionContext: options?.executionContext });
					return {
						schemaVersion: 1,
						invocationId: input.invocationId,
						tool: "read",
						content: [{ type: "text", text: "project file" }],
					};
				},
			};
			const { runtime, provider } = await createRuntime(
				agentDataDirectory,
				faux,
				gateway,
				"project-box",
			);
			const marker = "PROJECT-ROOT-AGENTS-MUST-STAY-EPHEMERAL";
			try {
				await runtime.run({
					runtimeBoxId: "project-box",
					executionContext: {
						kind: "project",
						projectId: "0198a20c-6f76-7e18-92da-353e2fc25b3e",
						projectName: "Project",
						runtimeBoxId: "project-box",
						runtimePlatform: "linux",
						projectPath: "/srv/project-v1",
						projectPathRevision: 1,
						gitRootPath: "/srv/project-v1",
						gitBranch: "main",
						rootAgentsHash: "a".repeat(64),
						rootAgentsBody: marker,
					},
					runId: "018f47a2-9bcd-7def-8abc-1234567890ab",
					threadId: "project-context-thread",
					provider,
					messages: [{ role: "user", content: "First." }],
				});
				await runtime.run({
					runtimeBoxId: "project-box",
					executionContext: {
						kind: "project",
						projectId: "0198a20c-6f76-7e18-92da-353e2fc25b3e",
						projectName: "Project",
						runtimeBoxId: "project-box",
						runtimePlatform: "linux",
						projectPath: "/srv/project-v2",
						projectPathRevision: 2,
						gitRootPath: "/srv/project-v2",
						gitBranch: "feature",
						rootAgentsHash: "b".repeat(64),
						rootAgentsBody: `${marker}-changed`,
					},
					runId: "018f47a2-9bcd-7def-8abc-1234567890ac",
					threadId: "project-context-thread",
					provider,
					messages: [{ role: "user", content: "Second." }],
				});
				expect(calls).toEqual([
					expect.objectContaining({
						input: expect.objectContaining({ cwd: "/srv/project-v1" }),
						executionContext: { executionScope: "project-root", projectPathRevision: 1 },
					}),
					expect.objectContaining({
						input: expect.objectContaining({ cwd: "/srv/project-v2" }),
						executionContext: { executionScope: "project-root", projectPathRevision: 2 },
					}),
				]);
				expect(await runtime.getThreadMessages("project-context-thread")).toEqual([
					{ role: "user", content: "First." },
					{ role: "assistant", content: "first answer" },
					{ role: "user", content: "Second." },
					{ role: "assistant", content: "second answer" },
				]);
				const persisted = readdirSync(join(agentDataDirectory, "sessions"))
					.map((filename) => readFileSync(join(agentDataDirectory, "sessions", filename), "utf8"))
					.join("\n");
				expect(persisted).not.toContain(marker);
				expect(persisted).not.toContain("/srv/project-v2");
			} finally {
				await runtime.shutdown();
			}
		});
	});

	test("classifies cancellation and an already-aborted request without calling the provider", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-cancel-test",
				models: [{ id: "slow-model" }],
				tokensPerSecond: 20,
				tokenSize: { min: 1, max: 1 },
			});
			faux.setResponses([fauxAssistantMessage("This response should stop immediately.")]);
			const { runtime, provider } = await createRuntime(agentDataDirectory, faux);
			try {
				let cancelled = false;
				const result = runtime.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					executionContext: { kind: "session" },
					runId: "cancel-run",
					threadId: "cancel-thread",
					provider,
					messages: [{ role: "user", content: "Start." }],
					onEvent: () => {
						if (!cancelled) {
							cancelled = true;
							expect(runtime.cancel("cancel-run", "User stopped.")).toBe(true);
						}
					},
				});
				const error = await result.catch((reason: unknown) => reason);
				expect(error).toBeInstanceOf(AskChatCancelledError);
				expect(error).toMatchObject({ kind: "cancelled", reason: "User stopped." });
				expect(runtime.cancel("cancel-run")).toBe(false);

				const controller = new AbortController();
				controller.abort();
				const callsBefore = faux.state.callCount;
				await expect(
					runtime.run({
						runtimeBoxId: defaultLocalRuntimeBoxId,
						executionContext: { kind: "session" },
						runId: "pre-aborted-run",
						threadId: "pre-aborted-thread",
						provider,
						messages: [{ role: "user", content: "Must not execute." }],
						signal: controller.signal,
					}),
				).rejects.toMatchObject({ kind: "cancelled" });
				expect(faux.state.callCount).toBe(callsBefore);
			} finally {
				await runtime.shutdown();
			}
		});
	});

	test("does not start the provider or executor after cancellation during model preflight", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-preflight-cancel-test",
				models: [{ id: "preflight-model" }],
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "printf unsafe" })], {
					stopReason: "toolUse",
				}),
			]);
			let executorCalls = 0;
			const gateway: ExecutorToolGateway = {
				async invoke() {
					executorCalls += 1;
					throw new Error("Executor must not be called after preflight cancellation");
				},
			};
			const { runtime, provider, modelRuntime } = await createRuntime(
				agentDataDirectory,
				faux,
				gateway,
			);
			const originalCheckAuth = modelRuntime.checkAuth.bind(modelRuntime);
			const checkStarted = Promise.withResolvers<void>();
			const releaseCheck = Promise.withResolvers<void>();
			modelRuntime.checkAuth = async (providerId: string) => {
				checkStarted.resolve();
				await releaseCheck.promise;
				return originalCheckAuth(providerId);
			};
			try {
				const run = runtime.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					executionContext: { kind: "session" },
					runId: "preflight-cancel-run",
					threadId: "preflight-cancel-thread",
					provider,
					messages: [{ role: "user", content: "Do not execute." }],
				});
				await checkStarted.promise;
				expect(runtime.cancel("preflight-cancel-run", "Cancelled during preflight.")).toBe(true);
				releaseCheck.resolve();
				await expect(run).rejects.toMatchObject({
					kind: "cancelled",
					reason: "Cancelled during preflight.",
				});
				expect(faux.state.callCount).toBe(0);
				expect(executorCalls).toBe(0);
			} finally {
				releaseCheck.resolve();
				await runtime.shutdown();
			}
		});
	});

	test("fences one thread while allowing another thread to run concurrently", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-concurrency-test",
				models: [{ id: "concurrent-model" }],
			});
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			faux.setResponses([
				async () => {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("first");
				},
				fauxAssistantMessage("second"),
			]);
			const { runtime, provider } = await createRuntime(agentDataDirectory, faux);
			try {
				const first = runtime.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					executionContext: { kind: "session" },
					runId: "first-run",
					threadId: "shared-thread",
					provider,
					messages: [{ role: "user", content: "First." }],
				});
				await started.promise;
				await expect(
					runtime.run({
						runtimeBoxId: defaultLocalRuntimeBoxId,
						executionContext: { kind: "session" },
						runId: "blocked-run",
						threadId: "shared-thread",
						provider,
						messages: [{ role: "user", content: "Blocked." }],
					}),
				).rejects.toMatchObject({ kind: "thread_busy" });

				const second = runtime.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					executionContext: { kind: "session" },
					runId: "second-run",
					threadId: "other-thread",
					provider,
					messages: [{ role: "user", content: "Second." }],
				});
				expect((await second).text).toBe("second");
				release.resolve();
				expect((await first).text).toBe("first");
			} finally {
				release.resolve();
				await runtime.shutdown();
			}
		});
	});

	test("maps provider failures to stable Pi-neutral categories", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-errors-test",
				models: [{ id: "error-model" }],
			});
			faux.setResponses(
				[
					"401 invalid API key",
					"429 rate limit",
					"network timeout",
					"model not found",
					"opaque provider failure",
				].map((message) =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: message }),
				),
			);
			const { runtime, provider } = await createRuntime(agentDataDirectory, faux);
			try {
				for (const [index, kind] of [
					"provider_authentication",
					"provider_rate_limited",
					"provider_network",
					"provider_model",
					"provider_failure",
				].entries()) {
					const error = await runtime
						.run({
							runtimeBoxId: defaultLocalRuntimeBoxId,
							executionContext: { kind: "session" },
							runId: `error-run-${index}`,
							threadId: `error-thread-${index}`,
							provider,
							messages: [{ role: "user", content: "Fail safely." }],
						})
						.catch((reason: unknown) => reason);
					expect(error).toBeInstanceOf(AskChatRuntimeError);
					expect(error).toMatchObject({ kind });
					expect(String((error as Error).message)).not.toContain("invalid API key");
				}
			} finally {
				await runtime.shutdown();
			}
		});
	});

	test("refuses to delete a session file that resolves outside the session directory", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-containment-test",
				models: [{ id: "containment-model" }],
			});
			faux.setResponses([fauxAssistantMessage("persist me")]);
			const { runtime, provider, modelRuntime } = await createRuntime(agentDataDirectory, faux);
			await runtime.run({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				executionContext: { kind: "session" },
				runId: "containment-run",
				threadId: "containment-thread",
				provider,
				messages: [{ role: "user", content: "Persist." }],
			});
			await runtime.shutdown();

			const sessionDirectory = join(agentDataDirectory, "sessions");
			const workspaceDirectory = join(agentDataDirectory, "workspace");
			const [info] = await SessionManager.list(workspaceDirectory, sessionDirectory);
			if (info === undefined) {
				throw new Error("Expected a persisted session.");
			}
			const escaped = join(agentDataDirectory, "escaped-session.jsonl");
			renameSync(info.path, escaped);
			symlinkSync(escaped, info.path);

			const restarted = new PiAgentRuntime({
				agentDataDirectory,
				modelRuntime,
				runtimeBoxGateway: toRuntimeBoxGateway(unavailableExecutorGateway),
			});
			try {
				await expect(restarted.deleteThread("containment-thread")).rejects.toThrow(
					"outside the app-owned session directory",
				);
			} finally {
				await restarted.shutdown();
			}
		});
	});
});

async function createRuntime(
	agentDataDirectory: string,
	faux: ReturnType<typeof fauxProvider>,
	executorGateway: ExecutorToolGateway = unavailableExecutorGateway,
	runtimeBoxId: string = defaultLocalRuntimeBoxId,
) {
	const modelRuntime = await createModelRuntime(agentDataDirectory, faux.provider);
	const fauxModel = faux.getModel();
	return {
		modelRuntime,
		runtime: new PiAgentRuntime({
			agentDataDirectory,
			modelRuntime,
			runtimeBoxGateway: toRuntimeBoxGateway(executorGateway, runtimeBoxId),
		}),
		provider: {
			providerId: faux.provider.id,
			providerName: faux.provider.name,
			source: "builtin" as const,
			api: fauxModel.api,
			model: fauxModel.id,
		},
	};
}

function toRuntimeBoxGateway(
	gateway: ExecutorToolGateway,
	expectedRuntimeBoxId: string = defaultLocalRuntimeBoxId,
): RuntimeBoxToolGateway {
	return {
		invokeForRuntimeBox(runtimeBoxId, input, options) {
			expect(runtimeBoxId).toBe(expectedRuntimeBoxId);
			return gateway.invoke(input, options);
		},
	};
}

function createModelRuntime(
	agentDataDirectory: string,
	piProvider: Provider,
): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDataDirectory, "unused-auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	}).then((modelRuntime) => {
		modelRuntime.registerNativeProvider(piProvider);
		return modelRuntime;
	});
}

async function withAppData(run: (path: string) => Promise<void>): Promise<void> {
	const root = join(process.cwd(), ".test-artifacts", `pi-ask-${crypto.randomUUID()}`);
	mkdirSync(root, { recursive: true });
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
