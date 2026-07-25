import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
	test("routes Provider setup to settings and keeps credentials out of the Chat page", async () => {
		const transport = new FakeChatTransport({
			configured: false,
		});
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
		const onOpenProviderSettings = vi.fn();

		renderChatPage({ transport, onOpenProviderSettings });

		await screen.findByRole("heading", { name: "Connect an OpenAI-compatible provider" });
		expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
		const settingsButton = screen.getAllByRole("button", { name: "Provider settings" }).at(-1);
		if (settingsButton === undefined) {
			throw new Error("Provider settings button was not rendered.");
		}
		fireEvent.click(settingsButton);
		expect(onOpenProviderSettings).toHaveBeenCalledOnce();
		expect(setItemSpy).not.toHaveBeenCalled();
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
		expect(screen.getByRole("heading", { name: "Line 1 Line 2" })).toBeVisible();
		expect(
			screen.getByText((_, node) => node?.textContent === "Line 1\nLine 2", {
				selector: ".chat-message__content",
			}),
		).toBeVisible();

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

	test("accepts only one send while the acknowledgement is pending", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const sendGate = createDeferred();
		transport.sendReturnGate = sendGate.promise;

		renderChatPage({ transport });
		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Send once" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		fireEvent.keyDown(prompt, { key: "Enter" });

		await waitFor(() => expect(transport.sendCalls).toHaveLength(1));
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		sendGate.resolve();
		await screen.findByText("Send once", { selector: ".chat-message__content" });
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

	test("ignores a stop failure after navigating to another Session", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("stop-session-a", {
			id: "stop-session-a",
			title: "Stop Session A",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("stop-a-user", "user", "Question A"),
				createMessage("stop-a-assistant", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "stop-a-request",
				messageId: "stop-a-assistant",
			},
		});
		transport.pending.set("stop-a-request", {
			sessionId: "stop-session-a",
			messageId: "stop-a-assistant",
		});
		transport.sessions.set("stop-session-b", {
			id: "stop-session-b",
			title: "Stop Session B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [createMessage("stop-b-user", "user", "Question B")],
		});
		const cancelGate = createDeferred();
		transport.cancelReturnGate = cancelGate.promise;
		transport.nextCancelError = new Error("Late stop failure.");

		const rendered = renderChatPage({ transport, sessionId: "stop-session-a" });
		fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
		await waitFor(() => expect(transport.cancelCalls).toHaveLength(1));

		rendered.rerender(
			<I18nProvider>
				<ChatPage transport={transport} sessionId="stop-session-b" />
			</I18nProvider>,
		);
		expect(await screen.findByText("Question B")).toBeVisible();
		cancelGate.resolve();

		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Stop Session B" })).toBeVisible(),
		);
		expect(screen.queryByText("Late stop failure.")).not.toBeInTheDocument();
	});

	test("loads existing session history from the provided sessionId", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});

		transport.sessions.set("existing-session", {
			id: "existing-session",
			title: "Existing session",
			updatedAt: "2026-01-01T00:00:00.000Z",
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

		const sessionItem = screen
			.getByText("Existing session", { selector: ".session-item__main strong" })
			.closest("li");
		if (sessionItem === null) {
			throw new Error("Selected Session item was not rendered.");
		}
		fireEvent.click(within(sessionItem).getByLabelText("Chat actions"));
		fireEvent.click(within(sessionItem).getByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByLabelText("Chat title"), {
			target: { value: "Renamed session" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByRole("heading", { name: "Renamed session" })).toBeVisible();
	});

	test("keeps persisted Session history readable without a configured Provider", async () => {
		const transport = new FakeChatTransport({
			configured: false,
		});
		transport.sessions.set("offline-session", {
			id: "offline-session",
			title: "Saved conversation",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [
				createMessage("offline-user", "user", "Saved question"),
				createMessage("offline-assistant", "assistant", "Saved answer", "completed"),
			],
		});

		renderChatPage({ transport, sessionId: "offline-session" });

		expect(await screen.findByText("Saved answer")).toBeVisible();
		expect(screen.getByRole("heading", { name: "Saved conversation" })).toBeVisible();
		expect(screen.queryByLabelText("Prompt")).not.toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Connect an OpenAI-compatible provider" }),
		).toBeVisible();
	});

	test("does not create a new Session when routed history fails to load", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});

		renderChatPage({ transport, sessionId: "missing-session" });

		expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Session not found.");
		const prompt = screen.getByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Do not reroute this message" } });
		fireEvent.keyDown(prompt, { key: "Enter" });

		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		expect(transport.sendCalls).toEqual([]);
		expect(transport.sessions.size).toBe(0);
	});

	test("restores the selected archived Session without navigating away", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const onNewSession = vi.fn();
		transport.sessions.set("archived-session", {
			id: "archived-session",
			title: "Archived conversation",
			updatedAt: "2026-01-01T00:00:00.000Z",
			archivedAt: "2026-01-02T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [createMessage("archived-user", "user", "Archived question")],
		});

		renderChatPage({
			transport,
			sessionId: "archived-session",
			onNewSession,
		});
		expect(await screen.findByText(/This chat is archived and read-only/)).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Archived" }));
		const sessionItem = (
			await screen.findByText("Archived conversation", {
				selector: ".session-item__main strong",
			})
		).closest("li");
		if (sessionItem === null) {
			throw new Error("Archived Session item was not rendered.");
		}
		fireEvent.click(within(sessionItem).getByLabelText("Chat actions"));
		fireEvent.click(within(sessionItem).getByRole("button", { name: "Restore" }));

		expect(await screen.findByLabelText("Prompt")).toBeVisible();
		expect(screen.queryByText(/This chat is archived and read-only/)).not.toBeInTheDocument();
		expect(onNewSession).not.toHaveBeenCalled();
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
			title: "Hydrating session",
			updatedAt: "2026-01-01T00:00:00.000Z",
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
			title: "Session A title",
			updatedAt: "2026-01-01T00:00:00.000Z",
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
			title: "Session B title",
			updatedAt: "2026-01-01T00:00:00.000Z",
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

	test("ignores a send acknowledgement after navigating to another Session", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("send-session-a", {
			id: "send-session-a",
			title: "Send Session A",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [],
		});
		transport.sessions.set("send-session-b", {
			id: "send-session-b",
			title: "Send Session B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: "gpt-4.1-mini",
			askMode: "Ask",
			messages: [createMessage("b-existing", "user", "Session B stays selected")],
		});
		const sendGate = createDeferred();
		transport.sendReturnGate = sendGate.promise;

		const rendered = renderChatPage({ transport, sessionId: "send-session-a" });
		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Delayed send" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(transport.sendCalls).toHaveLength(1));

		rendered.rerender(
			<I18nProvider>
				<ChatPage transport={transport} sessionId="send-session-b" />
			</I18nProvider>,
		);
		expect(await screen.findByText("Session B stays selected")).toBeVisible();
		sendGate.resolve();

		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Send Session B" })).toBeVisible(),
		);
		expect(screen.queryByText("Delayed send")).not.toBeInTheDocument();
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
	sendReturnGate: Promise<void> | null = null;
	cancelReturnGate: Promise<void> | null = null;
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

	async testProvider() {
		return { ok: true, latencyMs: 1 };
	}

	async deleteProvider() {
		this.providerStatus = {
			configured: false,
			endpoint: DEFAULT_PROVIDER_ENDPOINT,
			model: "",
			askMode: "Ask",
		};
		return { ...this.providerStatus };
	}

	async createSession() {
		const session: ChatSession = {
			id: `session-${this.nextSessionNumber}`,
			title: "New chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
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

	async listSessions(input: { query?: string; archived?: boolean; limit?: number } = {}) {
		const query = input.query?.toLocaleLowerCase() ?? "";
		return [...this.sessions.values()]
			.filter((session) => (session.archivedAt !== undefined) === (input.archived ?? false))
			.filter((session) => session.title.toLocaleLowerCase().includes(query))
			.slice(0, input.limit ?? 50)
			.map((session) => ({
				id: session.id,
				title: session.title,
				createdAt: session.updatedAt,
				updatedAt: session.updatedAt,
				...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
			}));
	}

	async renameSession(sessionId: string, title: string) {
		const session = this.requireSession(sessionId);
		session.title = title;
		return this.toSummary(session);
	}

	async setSessionArchived(sessionId: string, archived: boolean) {
		const session = this.requireSession(sessionId);
		if (archived) {
			session.archivedAt = "2026-01-02T00:00:00.000Z";
		} else {
			delete session.archivedAt;
		}
		return this.toSummary(session);
	}

	async deleteSession(sessionId: string) {
		this.sessions.delete(sessionId);
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
		if (session.title === "New chat") {
			session.title = input.message;
		}
		this.pending.set(requestId, {
			sessionId: input.sessionId,
			messageId: assistantMessage.id,
		});
		this.lastRequestId = requestId;
		if (this.responseBeforeSendReturns !== null) {
			this.emitDelta(requestId, this.responseBeforeSendReturns);
			this.emitCompleted(requestId);
		}
		await this.sendReturnGate;

		return {
			requestId,
			userMessage: { ...userMessage },
			assistantMessage: { ...assistantMessage },
		};
	}

	async cancel(input: { sessionId: string; requestId: string }) {
		this.cancelCalls.push(input);
		const error = this.consume("nextCancelError");
		await this.cancelReturnGate;
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

	private requireSession(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			throw new Error("Session not found.");
		}
		return session;
	}

	private toSummary(session: ChatSession) {
		return {
			id: session.id,
			title: session.title,
			createdAt: session.updatedAt,
			updatedAt: session.updatedAt,
			...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
		};
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
