import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	AskChatRuntimeError,
	type ExecutorToolGateway,
} from "@moshu/agent-runtime";
import type { ExecutorToolCall, ExecutorToolInvokeOutput } from "@moshu/contracts";

import { runAgentsServerProcess } from "./index";

class SmokeAgentRuntime implements AskChatRuntime {
	readonly #messages = new Map<string, AskChatMessage[]>();
	readonly #pending = new Map<string, (error: AskChatCancelledError) => void>();

	constructor(
		private readonly executorGateway: ExecutorToolGateway,
		private readonly runtimeBoxCwd: string,
	) {}

	async run(input: AskChatRunInput): Promise<AskChatRunResult> {
		const threadId = input.threadId ?? input.runId;
		const userMessage = input.messages.at(-1);
		if (userMessage === undefined || userMessage.role !== "user") {
			throw new Error("Smoke Ask runtime requires one user message.");
		}
		if (userMessage.content === "cancel-me") {
			await input.onEvent?.({ type: "message.delta", runId: input.runId, delta: "partial" });
			await new Promise<never>((_resolve, reject) => {
				this.#pending.set(input.runId, reject);
			});
		}
		if (userMessage.content === "huge-error") {
			throw new AskChatRuntimeError({
				kind: "provider_failure",
				message: "x".repeat(4_194_304),
				retryable: true,
				runId: input.runId,
			});
		}

		const text =
			userMessage.content === "tool-smoke"
				? await this.#runExecutorToolSmoke(input.runId)
				: "hello world";
		for (const delta of text === "hello world" ? ["hello", " world"] : [text]) {
			await input.onEvent?.({ type: "message.delta", runId: input.runId, delta });
		}
		this.#messages.set(threadId, [
			...(this.#messages.get(threadId) ?? []),
			{ ...userMessage },
			{ role: "assistant", content: text },
		]);
		return { runId: input.runId, text };
	}

	async #runExecutorToolSmoke(runId: string): Promise<string> {
		let sequence = 0;
		const invoke = (call: ExecutorToolCall): Promise<ExecutorToolInvokeOutput> => {
			sequence += 1;
			return this.executorGateway.invoke({
				schemaVersion: 1,
				invocationId: crypto.randomUUID(),
				runId,
				toolCallId: `three-process-tool-${sequence}`,
				cwd: this.runtimeBoxCwd,
				call,
			});
		};
		const write = await invoke({
			tool: "write",
			arguments: { path: "notes.txt", content: "alpha from runtime-box\n" },
		});
		const read = await invoke({ tool: "read", arguments: { path: "notes.txt" } });
		const grep = await invoke({
			tool: "grep",
			arguments: { pattern: "alpha from runtime-box", path: ".", literal: true },
		});
		const find = await invoke({ tool: "find", arguments: { pattern: "notes.txt" } });
		const ls = await invoke({ tool: "ls", arguments: { path: "." } });
		const environmentCommand =
			process.platform === "win32"
				? "echo %MOSHU_RUNTIME_BOX_SMOKE_VALUE%"
				: 'printf "%s" "$MOSHU_RUNTIME_BOX_SMOKE_VALUE"';
		const bash = await invoke({
			tool: "bash",
			arguments: { command: environmentCommand },
		});
		const edit = await invoke({
			tool: "edit",
			arguments: {
				path: "notes.txt",
				edits: [{ oldText: "alpha from runtime-box", newText: "beta from runtime-box" }],
			},
		});
		const image = await invoke({
			tool: "read",
			arguments: { path: "pixel.png" },
		});

		if (
			write.tool !== "write" ||
			!toolText(read).includes("alpha from runtime-box") ||
			!toolText(grep).includes("notes.txt") ||
			!toolText(find).includes("notes.txt") ||
			!toolText(ls).includes("notes.txt") ||
			!toolText(bash).includes("inherited-by-runtime-box") ||
			!toolText(edit).includes("beta from runtime-box") ||
			image.tool !== "read" ||
			!image.content.some((block) => block.type === "image")
		) {
			throw new Error("Three-process Runtime Box tool smoke returned unexpected output.");
		}
		return "runtime-box tools ok";
	}

	stream(_input: AskChatRunInput): AskChatRunStream {
		throw new Error("SmokeAskChatRuntime.stream is not used by ChatApplicationService.");
	}

	cancel(runId: string, reason?: string): boolean {
		const reject = this.#pending.get(runId);
		if (reject === undefined) {
			return false;
		}
		this.#pending.delete(runId);
		reject(new AskChatCancelledError(runId, reason));
		return true;
	}

	async getThreadMessages(threadId: string): Promise<AskChatMessage[]> {
		return [...(this.#messages.get(threadId) ?? [])];
	}

	async deleteThread(threadId: string): Promise<void> {
		this.#messages.delete(threadId);
	}

	async shutdown(): Promise<void> {
		for (const [runId, reject] of this.#pending) {
			reject(new AskChatCancelledError(runId, "Smoke runtime shutdown."));
		}
		this.#pending.clear();
	}
}

if (import.meta.main) {
	const runtimeBoxCwd = process.env.MOSHU_RUNTIME_BOX_SMOKE_CWD;
	if (runtimeBoxCwd === undefined) {
		throw new Error("MOSHU_RUNTIME_BOX_SMOKE_CWD is required by the smoke Agent runtime.");
	}
	await runAgentsServerProcess({
		createRuntime: (_providers, _modelRuntime, executorGateway) =>
			new SmokeAgentRuntime(executorGateway, runtimeBoxCwd),
		fetchProviderModels: async () => [
			{
				id: "smoke-model",
				enabled: false,
				displayName: "Smoke model",
				api: "openai-completions",
				input: ["text"],
				reasoning: true,
				contextWindowTokens: 128_000,
				maxOutputTokens: 8_192,
				thinkingLevels: ["off", "low", "medium", "high"],
			},
		],
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "smoke agents-server failed.");
		process.exit(1);
	});
}

function toolText(output: ExecutorToolInvokeOutput): string {
	return output.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
