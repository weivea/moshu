import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ChatPage, type ChatPageProps } from "./chat-page";
import {
	type ChatMessage,
	type ChatProviderConfiguration,
	type ChatProviderStatus,
	type ChatSession,
	type ChatTransport,
	type ChatTransportEvent,
	type ChatTransportListener,
	DEFAULT_PROVIDER_ENDPOINT,
} from "./transport";

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("ChatPage", () => {
	test("shows configure errors and keeps the api key out of localStorage", async () => {
		const transport = new FakeChatTransport({
			configured: false,
		});
		transport.nextConfigureError = new Error("Invalid API key.");
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

		renderChatPage({ transport });

		await screen.findByRole("heading", { name: "Connect an OpenAI-compatible provider" });
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4.1-mini" } });
		fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid API key.");
		expect(setItemSpy).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

		await screen.findByRole("button", { name: "Send" });
		expect(transport.configureCalls).toEqual([
			{
				endpoint: DEFAULT_PROVIDER_ENDPOINT,
				model: "gpt-4.1-mini",
				apiKey: "sk-secret",
			},
			{
				endpoint: DEFAULT_PROVIDER_ENDPOINT,
				model: "gpt-4.1-mini",
				apiKey: "sk-secret",
			},
		]);
	});

	test("retries loading provider status", async () => {
		const transport = new FakeChatTransport({
			configured: false,
		});
		transport.nextProviderStatusError = new Error("Provider status offline.");

		renderChatPage({ transport });

		expect(await screen.findByText("Provider status offline.")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await screen.findByRole("heading", { name: "Connect an OpenAI-compatible provider" });
	});

	test("creates a session, respects Enter and Shift+Enter, and renders streamed deltas", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const onSessionChange = vi.fn();

		renderChatPage({ transport, onSessionChange });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Line 1" } });
		fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true });
		expect(transport.sendCalls).toHaveLength(0);

		fireEvent.change(prompt, { target: { value: "Line 1\nLine 2" } });
		fireEvent.keyDown(prompt, { key: "Enter" });

		await waitFor(() => expect(transport.sendCalls).toHaveLength(1));
		expect(transport.sendCalls[0]?.message).toBe("Line 1\nLine 2");
		expect(onSessionChange).toHaveBeenCalledWith("session-1");
		expect(screen.getByText((_, node) => node?.textContent === "Line 1\nLine 2")).toBeVisible();

		const requestId = transport.lastRequestId;
		if (!requestId) {
			throw new Error("Expected a request ID after sending.");
		}

		transport.emitDelta(requestId, "Hello");
		transport.emitDelta(requestId, "\nWorld");
		expect(
			await screen.findByText((_, node) => node?.textContent === "Hello\nWorld"),
		).toBeVisible();

		transport.emitCompleted(requestId);
		expect(await screen.findByText("Complete")).toBeVisible();
	});

	test("renders a completed response that arrives before the send acknowledgement", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.responseBeforeSendReturns = "Fast answer";

		renderChatPage({ transport });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Answer immediately" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(await screen.findByText("Fast answer")).toBeVisible();
		expect(await screen.findByText("Complete")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
	});

	test("shows retryable send errors", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.nextSendError = new Error("RPC send failed.");

		renderChatPage({ transport });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Retry this request" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("RPC send failed.");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => expect(transport.sendCalls).toHaveLength(2));
	});

	test("routes a newly created session after a failed first send is retried", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const onSessionChange = vi.fn();
		transport.nextSendError = new Error("RPC send failed.");

		renderChatPage({ transport, onSessionChange });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Retry into the same session" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("RPC send failed.");
		expect(onSessionChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() => expect(transport.sendCalls).toHaveLength(2));
		expect(onSessionChange).toHaveBeenCalledWith("session-1");
	});

	test("stops an in-flight response and offers retry", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});

		renderChatPage({ transport });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Stop after first delta" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		const requestId = await waitForRequest(transport);
		transport.emitDelta(requestId, "Partial answer");
		fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"The assistant response was stopped. You can retry the same message.",
		);
		expect(screen.getByText("Stopped")).toBeVisible();
		expect(transport.cancelCalls).toHaveLength(1);
	});

	test("loads existing session history from the provided sessionId", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});

		transport.sessions.set("existing-session", {
			id: "existing-session",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("user-1", "user", "Earlier question"),
				createMessage("assistant-1", "assistant", "Earlier answer", "completed"),
			],
		});

		renderChatPage({ transport, sessionId: "existing-session" });

		expect(await screen.findByText("Earlier question")).toBeVisible();
		expect(screen.getByText("Earlier answer")).toBeVisible();
		expect(screen.getByText("Session: existing-session")).toBeVisible();
	});

	test("deduplicates buffered events that are already included in the hydrated snapshot", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.sessions.set("hydrating-session", {
			id: "hydrating-session",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("hydrating-user", "user", "Earlier question"),
				createMessage("hydrating-assistant", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "hydrating-request",
				messageId: "hydrating-assistant",
			},
			eventCursors: {
				"hydrating-request": 0,
			},
		});
		transport.pending.set("hydrating-request", {
			sessionId: "hydrating-session",
			messageId: "hydrating-assistant",
		});

		renderChatPage({ transport, sessionId: "hydrating-session" });
		await waitFor(() => expect(transport.getSessionCalls).toEqual(["hydrating-session"]));

		transport.emitDelta("hydrating-request", "Buffered answer");
		transport.emitCompleted("hydrating-request");
		gate.resolve();

		expect(await screen.findByText("Buffered answer")).toBeVisible();
		expect(screen.getAllByText("Buffered answer")).toHaveLength(1);
		expect(await screen.findByText("Complete")).toBeVisible();
	});

	test("buffers events for a newly requested route while its snapshot is loading", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("session-a", {
			id: "session-a",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("a-user", "user", "Session A"),
				createMessage("a-assistant", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "a-request",
				messageId: "a-assistant",
			},
			eventCursors: { "a-request": 0 },
		});
		transport.pending.set("a-request", {
			sessionId: "session-a",
			messageId: "a-assistant",
		});
		transport.sessions.set("session-b", {
			id: "session-b",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("b-user", "user", "Session B"),
				createMessage("b-assistant", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "b-request",
				messageId: "b-assistant",
			},
			eventCursors: {
				"b-request": 0,
			},
		});
		transport.pending.set("b-request", {
			sessionId: "session-b",
			messageId: "b-assistant",
		});
		const rendered = renderChatPage({ transport, sessionId: "session-a" });
		expect(await screen.findByText("Session A")).toBeVisible();

		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.captureSessionBeforeGate = true;
		rendered.rerender(
			<I18nProvider>
				<ChatPage transport={transport} sessionId="session-b" />
			</I18nProvider>,
		);
		await waitFor(() => expect(transport.getSessionCalls).toEqual(["session-a", "session-b"]));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
		);

		transport.emitDelta("b-request", "Live session B delta");
		gate.resolve();

		expect(await screen.findByText("Live session B delta")).toBeVisible();
	});
});

function renderChatPage(props: ChatPageProps) {
	return render(
		<I18nProvider>
			<ChatPage {...props} />
		</I18nProvider>,
	);
}

async function waitForRequest(transport: FakeChatTransport) {
	await waitFor(() => expect(transport.lastRequestId).toBeTruthy());
	if (!transport.lastRequestId) {
		throw new Error("Missing request ID.");
	}
	return transport.lastRequestId;
}

class FakeChatTransport implements ChatTransport {
	configureCalls: ChatProviderConfiguration[] = [];
	sendCalls: Array<{ sessionId: string; message: string }> = [];
	cancelCalls: Array<{ sessionId: string; requestId: string }> = [];
	getSessionCalls: string[] = [];
	listeners = new Set<ChatTransportListener>();
	sessions = new Map<string, ChatSession>();
	pending = new Map<string, { sessionId: string; messageId: string }>();
	nextProviderStatusError: Error | null = null;
	nextConfigureError: Error | null = null;
	nextSendError: Error | null = null;
	nextCancelError: Error | null = null;
	lastRequestId: string | null = null;
	sessionLoadGate: Promise<void> | null = null;
	captureSessionBeforeGate = false;
	responseBeforeSendReturns: string | null = null;
	private providerStatus: ChatProviderStatus;
	private eventSequences = new Map<string, number>();
	private nextSessionNumber = 1;
	private nextMessageNumber = 1;
	private nextRequestNumber = 1;

	constructor({
		configured,
		model = "",
	}: {
		configured: boolean;
		model?: string;
	}) {
		this.providerStatus = {
			configured,
			endpoint: DEFAULT_PROVIDER_ENDPOINT,
			model,
			askMode: "Ask",
		};
	}

	async getProviderStatus() {
		const error = this.consume("nextProviderStatusError");
		if (error) {
			throw error;
		}
		return { ...this.providerStatus };
	}

	async configureProvider(input: ChatProviderConfiguration) {
		this.configureCalls.push(input);
		const error = this.consume("nextConfigureError");
		if (error) {
			throw error;
		}

		this.providerStatus = {
			configured: true,
			endpoint: input.endpoint,
			model: input.model,
			askMode: "Ask",
		};
		return { ...this.providerStatus };
	}

	async createSession() {
		const session: ChatSession = {
			id: `session-${this.nextSessionNumber}`,
			model: this.providerStatus.model,
			askMode: this.providerStatus.askMode,
			messages: [],
		};
		this.nextSessionNumber += 1;
		this.sessions.set(session.id, session);
		return cloneSession(session);
	}

	async getSession(sessionId: string) {
		this.getSessionCalls.push(sessionId);
		const session = this.sessions.get(sessionId);
		const capturedSession =
			this.captureSessionBeforeGate && session !== undefined ? cloneSession(session) : undefined;
		await this.sessionLoadGate;
		const resolvedSession = capturedSession ?? this.sessions.get(sessionId);
		if (!resolvedSession) {
			throw new Error("Session not found.");
		}
		return cloneSession(resolvedSession);
	}

	async send(input: { sessionId: string; message: string }) {
		this.sendCalls.push(input);
		const error = this.consume("nextSendError");
		if (error) {
			throw error;
		}

		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}

		const userMessage = createMessage(
			`user-${this.nextMessageNumber}`,
			"user",
			input.message,
			"completed",
		);
		this.nextMessageNumber += 1;
		const assistantMessage = createMessage(
			`assistant-${this.nextMessageNumber}`,
			"assistant",
			"",
			"streaming",
		);
		this.nextMessageNumber += 1;
		const requestId = `request-${this.nextRequestNumber}`;
		this.nextRequestNumber += 1;

		session.messages.push(userMessage, assistantMessage);
		this.pending.set(requestId, {
			sessionId: input.sessionId,
			messageId: assistantMessage.id,
		});
		this.lastRequestId = requestId;
		if (this.responseBeforeSendReturns !== null) {
			this.emitDelta(requestId, this.responseBeforeSendReturns);
			this.emitCompleted(requestId);
		}

		return {
			requestId,
			userMessage: { ...userMessage },
			assistantMessage: { ...assistantMessage },
		};
	}

	async cancel(input: { sessionId: string; requestId: string }) {
		this.cancelCalls.push(input);
		const error = this.consume("nextCancelError");
		if (error) {
			throw error;
		}

		const pending = this.pending.get(input.requestId);
		if (!pending) {
			throw new Error("Request not found.");
		}

		this.pending.delete(input.requestId);
		const sequence = this.nextEventSequence(input.requestId, input.sessionId);
		this.notify({
			type: "response.cancelled",
			sessionId: input.sessionId,
			requestId: input.requestId,
			messageId: pending.messageId,
			content:
				this.sessions
					.get(input.sessionId)
					?.messages.find((message) => message.id === pending.messageId)?.content ?? "",
			reason: "Preview response stopped.",
			sequence,
		});
	}

	subscribe(listener: ChatTransportListener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emitDelta(requestId: string, delta: string) {
		const pending = this.pending.get(requestId);
		if (!pending) {
			throw new Error("Request not found.");
		}

		const session = this.sessions.get(pending.sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}

		session.messages = session.messages.map((message) =>
			message.id === pending.messageId
				? {
						...message,
						content: `${message.content}${delta}`,
						status: "streaming",
					}
				: message,
		);

		const sequence = this.nextEventSequence(requestId, pending.sessionId);
		this.notify({
			type: "response.delta",
			sessionId: pending.sessionId,
			requestId,
			messageId: pending.messageId,
			delta,
			sequence,
		});
	}

	emitCompleted(requestId: string) {
		const pending = this.pending.get(requestId);
		if (!pending) {
			throw new Error("Request not found.");
		}

		const session = this.sessions.get(pending.sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}

		session.messages = session.messages.map((message) =>
			message.id === pending.messageId
				? {
						...message,
						status: "completed",
					}
				: message,
		);

		this.pending.delete(requestId);
		const sequence = this.nextEventSequence(requestId, pending.sessionId);
		const completedMessage = session.messages.find((message) => message.id === pending.messageId);
		if (!completedMessage) {
			throw new Error("Completed assistant message was not found.");
		}
		this.notify({
			type: "response.completed",
			sessionId: pending.sessionId,
			requestId,
			messageId: pending.messageId,
			content: completedMessage.content,
			sequence,
		});
	}

	private nextEventSequence(requestId: string, sessionId: string) {
		const sequence = (this.eventSequences.get(requestId) ?? 0) + 1;
		this.eventSequences.set(requestId, sequence);
		const session = this.sessions.get(sessionId);
		if (session) {
			session.eventCursors = {
				...(session.eventCursors ?? {}),
				[requestId]: sequence,
			};
		}
		return sequence;
	}

	private consume(
		key: "nextProviderStatusError" | "nextConfigureError" | "nextSendError" | "nextCancelError",
	) {
		const error = this[key];
		this[key] = null;
		return error;
	}

	private notify(event: ChatTransportEvent) {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function createMessage(
	id: string,
	role: ChatMessage["role"],
	content: string,
	status: ChatMessage["status"] = "completed",
): ChatMessage {
	return {
		id,
		role,
		content,
		createdAt: "2026-01-01T00:00:00.000Z",
		status,
	};
}

function cloneSession(session: ChatSession): ChatSession {
	return {
		...session,
		activeResponse: session.activeResponse ? { ...session.activeResponse } : undefined,
		eventCursors: session.eventCursors ? { ...session.eventCursors } : undefined,
		messages: session.messages.map((message) => ({ ...message })),
	};
}

function createDeferred() {
	let resolvePromise = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});

	return {
		promise,
		resolve: resolvePromise,
	};
}
