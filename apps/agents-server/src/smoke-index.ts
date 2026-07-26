import {
	AskChatCancelledError,
	type AskChatMessage,
	type AskChatRunInput,
	type AskChatRunResult,
	type AskChatRunStream,
	type AskChatRuntime,
	AskChatRuntimeError,
} from "@moshu/agent-runtime";

import { runAgentsServerProcess } from "./index";

class SmokeAskChatRuntime implements AskChatRuntime {
	readonly #messages = new Map<string, AskChatMessage[]>();
	readonly #pending = new Map<string, (error: AskChatCancelledError) => void>();

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

		for (const delta of ["hello", " world"]) {
			await input.onEvent?.({ type: "message.delta", runId: input.runId, delta });
		}
		const text = "hello world";
		this.#messages.set(threadId, [
			...(this.#messages.get(threadId) ?? []),
			{ ...userMessage },
			{ role: "assistant", content: text },
		]);
		return { runId: input.runId, text };
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
	await runAgentsServerProcess({
		createRuntime: () => new SmokeAskChatRuntime(),
		testProviderConnection: async () => {},
	}).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "smoke agents-server failed.");
		process.exit(1);
	});
}
