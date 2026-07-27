import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { AskChatCancelledError, AskChatRuntimeError, PiAskChatRuntime } from "../src";

const sessionId = "0198a20c-6f76-7e18-92da-353e2fc25b3e";

describe("Pi Ask runtime", () => {
	test("streams, persists, restores, and deletes a no-tools Ask session", async () => {
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
			const first = new PiAskChatRuntime({ agentDataDirectory, modelRuntime });
			const deltas: string[] = [];
			const stream = first.stream({
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

			const restored = new PiAskChatRuntime({ agentDataDirectory, modelRuntime });
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

	test("fails closed when a provider emits tool activity", async () => {
		await withAppData(async (agentDataDirectory) => {
			const faux = fauxProvider({
				provider: "moshu-tool-test",
				models: [{ id: "tool-model" }],
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("forbidden", { value: "secret-free" })], {
					stopReason: "toolUse",
				}),
			]);
			const { runtime, provider } = await createRuntime(agentDataDirectory, faux);
			try {
				await expect(
					runtime.run({
						runId: "tool-run",
						threadId: "tool-thread",
						provider,
						messages: [{ role: "user", content: "Do not call tools." }],
					}),
				).rejects.toMatchObject({ kind: "unexpected_tool_activity" });
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
					runId: "first-run",
					threadId: "shared-thread",
					provider,
					messages: [{ role: "user", content: "First." }],
				});
				await started.promise;
				await expect(
					runtime.run({
						runId: "blocked-run",
						threadId: "shared-thread",
						provider,
						messages: [{ role: "user", content: "Blocked." }],
					}),
				).rejects.toMatchObject({ kind: "thread_busy" });

				const second = runtime.run({
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

			const restarted = new PiAskChatRuntime({ agentDataDirectory, modelRuntime });
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

async function createRuntime(agentDataDirectory: string, faux: ReturnType<typeof fauxProvider>) {
	const modelRuntime = await createModelRuntime(agentDataDirectory, faux.provider);
	const fauxModel = faux.getModel();
	return {
		modelRuntime,
		runtime: new PiAskChatRuntime({ agentDataDirectory, modelRuntime }),
		provider: {
			providerId: faux.provider.id,
			providerName: faux.provider.name,
			source: "builtin" as const,
			api: fauxModel.api,
			model: fauxModel.id,
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
