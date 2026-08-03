import {
	type ChatRunEvent,
	type ChatRunSnapshot,
	type ChatRunTextPart,
	defaultLocalRuntimeBoxId,
} from "@moshu/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentsUnavailableError, ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import { I18nProvider } from "../i18n";
import { ChatPage, type ChatPageProps } from "./chat-page";
import { applyChatRunEvent as applyFixtureEvent } from "./run-timeline-reducer";
import { isRendererSessionRetired } from "./session-recovery-coordinator";
import {
	availableModelFor,
	modelSelectionFor,
	ProviderModelTransportDefaults,
	testProviderId,
} from "./test-transport-defaults";
import type {
	ChatSession,
	ChatSessionInvalidation,
	ChatSessionInvalidationListener,
	ChatTransport,
	ChatTransportEvent,
	ChatTransportListener,
	SessionModelSelection,
} from "./transport";

const sessionModel = modelSelectionFor("gpt-4.1-mini");

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	HTMLElement.prototype.scrollIntoView = vi.fn();
	sessionStorage.clear();
	localStorage.clear();
	window.history.replaceState(null, "");
});

describe("ChatPage", () => {
	test("creates a new chat with the model picked in the composer", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-5.4" });
		transport.availableModels = [
			availableModelFor("gpt-5.4"),
			availableModelFor("claude-opus-4.6"),
		];
		renderChatPage({ transport });

		const picker = await screen.findByRole("combobox", { name: "Model" });
		fireEvent.change(picker, {
			target: { value: `${testProviderId}\u0000claude-opus-4.6` },
		});

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Hello" } });
		fireEvent.keyDown(prompt, { key: "Enter" });

		await waitFor(() =>
			expect(transport.createSessionModels).toEqual([modelSelectionFor("claude-opus-4.6")]),
		);
	});

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
		transport.nextListAvailableModelsError = new Error("Provider status offline.");

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
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
		);
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
		const sendButton = screen.getByRole("button", { name: "Send" });
		expect(sendButton).toHaveAttribute("title", "Send");
		fireEvent.click(sendButton);

		expect(await screen.findByText("Fast answer")).toBeVisible();
		expect(transport.lastRequestId).not.toBe(transport.sendCalls[0]?.requestId);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
		);
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
		expect(transport.sendCalls[0]?.requestId).toBe(transport.sendCalls[1]?.requestId);
	});

	test("globally retires an active Session before handling a typed send miss", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("missing-send-session", {
			id: "missing-send-session",
			title: "Missing send chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("existing-message", "user", "Existing transcript")],
		});
		transport.nextSendError = new ChatSessionNotFoundError();
		const onSessionRetired = vi.fn();
		localStorage.setItem("moshu.lastChatSessionId", "missing-send-session");
		window.history.replaceState(
			{
				usr: {
					hydratedSession: transport.sessions.get("missing-send-session"),
					unrelated: "keep",
				},
			},
			"",
		);
		renderChatPage({
			transport,
			sessionId: "missing-send-session",
			onSessionRetired,
		});
		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "This Session is gone" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => expect(onSessionRetired).toHaveBeenCalledWith("missing-send-session"));
		expect(isRendererSessionRetired("missing-send-session")).toBe(true);
		expect(screen.queryByText("Existing transcript")).not.toBeInTheDocument();
		expect(screen.queryByText("Missing send chat")).not.toBeInTheDocument();
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBeNull();
		expect(window.history.state).toEqual({ usr: { unrelated: "keep" } });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
		expect(transport.sendCalls[0]?.requestId).toBe(transport.sendCalls[1]?.requestId);
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
		expect(screen.getByText("interrupted")).toBeVisible();
		expect(transport.cancelCalls).toHaveLength(1);
	});

	test("globally retires an active Session before handling a typed cancel miss", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("missing-cancel-session", {
			id: "missing-cancel-session",
			title: "Missing cancel chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [
				createMessage("cancel-user", "user", "Question"),
				createMessage("cancel-assistant", "assistant", "Partial", "streaming"),
			],
			activeResponse: {
				requestId: "missing-cancel-run",
				messageId: "cancel-assistant",
			},
		});
		transport.nextCancelError = new ChatSessionNotFoundError();
		const onSessionRetired = vi.fn();
		renderChatPage({
			transport,
			sessionId: "missing-cancel-session",
			onSessionRetired,
		});
		fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

		await waitFor(() => expect(onSessionRetired).toHaveBeenCalledWith("missing-cancel-session"));
		expect(isRendererSessionRetired("missing-cancel-session")).toBe(true);
		expect(screen.queryByText("Partial")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
			model: sessionModel,
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
			model: sessionModel,
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
			model: sessionModel,
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

		const sessionItem = (
			await screen.findByText("Existing session", { selector: ".session-item__main strong" })
		).closest("li");
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

	test("retires a delayed typed hydration miss without disturbing the replacement Session", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("missing-hydration-a", {
			id: "missing-hydration-a",
			title: "Missing hydration A",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		transport.sessions.set("replacement-hydration-b", {
			id: "replacement-hydration-b",
			title: "Replacement hydration B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("replacement-hydration-message", "user", "Hydration B stays")],
		});
		const hydrationGate = createDeferred();
		transport.sessionLoadGates.set("missing-hydration-a", hydrationGate.promise);
		transport.nextGetSessionError = new ChatSessionNotFoundError();
		const onSessionRetired = vi.fn();
		const rendered = renderChatPage({
			transport,
			sessionId: "missing-hydration-a",
			onSessionRetired,
		});
		await waitFor(() => expect(transport.getSessionCalls).toContain("missing-hydration-a"));

		rendered.rerender(
			<I18nProvider>
				<ChatPage
					transport={transport}
					sessionId="replacement-hydration-b"
					onSessionRetired={onSessionRetired}
				/>
			</I18nProvider>,
		);
		expect(await screen.findByText("Hydration B stays")).toBeVisible();
		hydrationGate.resolve();

		await waitFor(() => expect(isRendererSessionRetired("missing-hydration-a")).toBe(true));
		expect(isRendererSessionRetired("replacement-hydration-b")).toBe(false);
		expect(screen.getByRole("heading", { name: "Replacement hydration B" })).toBeVisible();
		expect(screen.getByText("Hydration B stays")).toBeVisible();
		expect(onSessionRetired).not.toHaveBeenCalled();
	});

	test("keeps persisted Session history readable without a configured Provider", async () => {
		const transport = new FakeChatTransport({
			configured: false,
		});
		transport.sessions.set("offline-session", {
			id: "offline-session",
			title: "Saved conversation",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
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

	test("rejects a Project Session opened through a global Chat deep link", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("globally-routed-project-session", {
			id: "globally-routed-project-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-a",
			title: "Project Session",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("project-history", "user", "Project-only history")],
		});

		renderChatPage({ transport, sessionId: "globally-routed-project-session" });

		expect(await screen.findByRole("alert")).toHaveTextContent("belongs to a different Project");
		expect(screen.queryByText("Project Session")).not.toBeInTheDocument();
		expect(screen.queryByText("Project-only history")).not.toBeInTheDocument();
		expect(transport.listeners.size).toBe(0);
		expect(screen.getByLabelText("Prompt")).toBeDisabled();
	});

	test("rejects Project ownership returned when creating a global Session", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.createdSessionProjectIdOverride = "project-a";
		renderChatPage({ transport });

		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Global prompt" } });
		fireEvent.keyDown(prompt, { key: "Enter" });

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Created Session ownership is invalid",
		);
		expect(transport.sendCalls).toEqual([]);
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
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("archived-user", "user", "Archived question")],
		});

		renderChatPage({
			transport,
			sessionId: "archived-session",
			onNewSession,
		});
		expect(await screen.findByText(/This chat is archived and read-only/)).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Filter chats" }));
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
			model: sessionModel,
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
	});

	test("shows an initial snapshot optimistically, then reconciles a terminal event during authoritative hydration", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.captureSessionBeforeGate = true;
		const initialSession: ChatSessionFixture = {
			id: "initial-hydration-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			title: "Stale initial title",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [
				createMessage("initial-user", "user", "Initial question"),
				createMessage("initial-assistant", "assistant", "Stale partial", "streaming"),
			],
			activeResponse: {
				requestId: "initial-request",
				messageId: "initial-assistant",
			},
			eventCursors: { "initial-request": 0 },
		};
		transport.sessions.set("initial-hydration-session", {
			...cloneSession(initialSession),
			title: "Authoritative title",
			messages: [
				createMessage("initial-user", "user", "Initial question"),
				createMessage("initial-assistant", "assistant", "", "streaming"),
			],
		});
		transport.pending.set("initial-request", {
			sessionId: "initial-hydration-session",
			messageId: "initial-assistant",
		});

		renderChatPage({
			transport,
			sessionId: "initial-hydration-session",
			initialSession: cloneSession(initialSession),
		});

		expect(screen.getByText("Stale partial")).toBeVisible();
		await waitFor(() => expect(transport.getSessionCalls).toEqual(["initial-hydration-session"]));
		expect(transport.listenerCountsAtSessionLoad).toEqual([1]);
		transport.emitDelta("initial-request", "Answer during fetch");
		transport.emitCompleted("initial-request");
		gate.resolve();

		expect(await screen.findByRole("heading", { name: "Authoritative title" })).toBeVisible();
		expect(screen.getAllByText("Answer during fetch")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
	});

	test("retains an event delivered synchronously when the authoritative subscription is installed", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		const session: ChatSessionFixture = {
			id: "subscribe-first-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			title: "Subscribe first",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [
				createMessage("subscribe-user", "user", "Question"),
				createMessage("subscribe-assistant", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "subscribe-request",
				messageId: "subscribe-assistant",
			},
			eventCursors: { "subscribe-request": 0 },
		};
		transport.sessions.set(session.id, cloneSession(session));
		transport.eventOnSubscribe = {
			type: "response.delta",
			sessionId: session.id,
			requestId: "subscribe-request",
			messageId: "subscribe-assistant",
			delta: "Delivered before fetch",
			sequence: 1,
		};

		renderChatPage({
			transport,
			sessionId: session.id,
			initialSession: cloneSession(session),
		});
		await waitFor(() => expect(transport.getSessionCalls).toEqual([session.id]));
		gate.resolve();

		expect(await screen.findByText("Delivered before fetch")).toBeVisible();
		expect(transport.listenerCountsAtSessionLoad).toEqual([1]);
	});

	test("serializes an authoritative invalidation refresh behind initial hydration", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.sessions.set("serialized-hydration-session", {
			id: "serialized-hydration-session",
			title: "Serialized hydration",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});

		renderChatPage({ transport, sessionId: "serialized-hydration-session" });
		await waitFor(() =>
			expect(transport.getSessionCalls).toEqual(["serialized-hydration-session"]),
		);
		let invalidation: Promise<void> | undefined;
		act(() => {
			invalidation = transport.emitInvalidation({
				sessionId: "serialized-hydration-session",
				reason: "history_expired",
			});
		});
		expect(transport.getSessionCalls).toEqual(["serialized-hydration-session"]);

		gate.resolve();
		await act(async () => {
			await invalidation;
		});
		expect(transport.getSessionCalls).toEqual([
			"serialized-hydration-session",
			"serialized-hydration-session",
		]);
	});

	test("orders buffered events after the authoritative cursor without duplicating snapshot content", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.captureSessionBeforeGate = true;
		const session: ChatSessionFixture = {
			id: "cursor-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			title: "Cursor reconciliation",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [
				createMessage("cursor-user", "user", "Question"),
				createMessage("cursor-assistant", "assistant", "AB", "streaming"),
			],
			activeResponse: {
				requestId: "cursor-request",
				messageId: "cursor-assistant",
			},
			eventCursors: { "cursor-request": 2 },
		};
		transport.sessions.set(session.id, cloneSession(session));

		renderChatPage({
			transport,
			sessionId: session.id,
			initialSession: cloneSession(session),
		});
		await waitFor(() => expect(transport.getSessionCalls).toEqual([session.id]));
		transport.emitEvent({
			type: "response.delta",
			sessionId: session.id,
			requestId: "cursor-request",
			messageId: "cursor-assistant",
			delta: "B",
			sequence: 2,
		});
		transport.emitEvent({
			type: "response.completed",
			sessionId: session.id,
			requestId: "cursor-request",
			messageId: "cursor-assistant",
			content: "ABC",
			sequence: 4,
		});
		transport.emitEvent({
			type: "response.delta",
			sessionId: session.id,
			requestId: "cursor-request",
			messageId: "cursor-assistant",
			delta: "C",
			sequence: 3,
		});
		gate.resolve();

		expect(await screen.findByText("ABC")).toBeVisible();
		expect(screen.getAllByText("ABC")).toHaveLength(1);
		expect(screen.queryByText("ABBC")).not.toBeInTheDocument();
	});

	test("rehydrates a stale initial snapshot when navigating back to a Session", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		const staleSession: ChatSessionFixture = {
			id: "back-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			title: "Stale history title",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("stale-back-message", "user", "Stale history")],
		};
		transport.sessions.set("back-session", {
			...cloneSession(staleSession),
			title: "First authoritative title",
			messages: [createMessage("first-back-message", "assistant", "First authoritative")],
		});
		transport.sessions.set("other-session", {
			id: "other-session",
			title: "Other Session",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("other-message", "user", "Other content")],
		});
		const rendered = renderChatPage({
			transport,
			sessionId: staleSession.id,
			initialSession: cloneSession(staleSession),
		});
		expect(await screen.findByText("First authoritative")).toBeVisible();

		rendered.rerender(
			<I18nProvider>
				<ChatPage transport={transport} sessionId="other-session" />
			</I18nProvider>,
		);
		expect(await screen.findByText("Other content")).toBeVisible();
		transport.sessions.set("back-session", {
			...cloneSession(staleSession),
			title: "Fresh after back",
			messages: [createMessage("fresh-back-message", "assistant", "Fresh after back")],
		});
		rendered.rerender(
			<I18nProvider>
				<ChatPage
					transport={transport}
					sessionId={staleSession.id}
					initialSession={cloneSession(staleSession)}
				/>
			</I18nProvider>,
		);

		expect(await screen.findByRole("heading", { name: "Fresh after back" })).toBeVisible();
		expect(
			screen.getByText("Fresh after back", { selector: ".chat-message__content" }),
		).toBeVisible();
		expect(screen.queryByText("Stale history")).not.toBeInTheDocument();
		expect(transport.getSessionCalls.filter((id) => id === staleSession.id)).toHaveLength(2);
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
			model: sessionModel,
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
			model: sessionModel,
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
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		transport.sessions.set("send-session-b", {
			id: "send-session-b",
			title: "Send Session B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
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

	test("retires a delayed typed send miss without disturbing the replacement Session", async () => {
		const transport = new FakeChatTransport({
			configured: true,
			model: "gpt-4.1-mini",
		});
		transport.sessions.set("missing-send-a", {
			id: "missing-send-a",
			title: "Missing Session A",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		transport.sessions.set("replacement-send-b", {
			id: "replacement-send-b",
			title: "Replacement Session B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("replacement-message", "user", "Keep replacement state")],
		});
		const sendGate = createDeferred();
		transport.sendReturnGate = sendGate.promise;
		transport.nextSendError = new ChatSessionNotFoundError();
		const onSessionRetired = vi.fn();
		const rendered = renderChatPage({
			transport,
			sessionId: "missing-send-a",
			onSessionRetired,
		});
		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Delayed missing send" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(transport.sendCalls).toHaveLength(1));

		rendered.rerender(
			<I18nProvider>
				<ChatPage
					transport={transport}
					sessionId="replacement-send-b"
					onSessionRetired={onSessionRetired}
				/>
			</I18nProvider>,
		);
		expect(await screen.findByText("Keep replacement state")).toBeVisible();
		localStorage.setItem("moshu.lastChatSessionId", "replacement-send-b");
		sendGate.resolve();

		await waitFor(() => expect(isRendererSessionRetired("missing-send-a")).toBe(true));
		expect(isRendererSessionRetired("replacement-send-b")).toBe(false);
		expect(screen.getByRole("heading", { name: "Replacement Session B" })).toBeVisible();
		expect(screen.getByText("Keep replacement state")).toBeVisible();
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBe("replacement-send-b");
		expect(onSessionRetired).not.toHaveBeenCalled();
	});

	test("acknowledges Session retirement only after active state and the sidebar are refreshed", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		const onSessionRetired = vi.fn();
		transport.sessions.set("retired-session", {
			id: "retired-session",
			title: "Retired chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("old-message", "user", "Stale content")],
		});
		renderChatPage({ transport, sessionId: "retired-session", onSessionRetired });
		expect(await screen.findByText("Stale content")).toBeVisible();
		transport.sessions.delete("retired-session");

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "retired-session",
				reason: "session_retired",
			});
		});

		expect(screen.queryByText("Stale content")).not.toBeInTheDocument();
		expect(screen.queryByText("Retired chat")).not.toBeInTheDocument();
		expect(transport.listSessionCalls).toBeGreaterThanOrEqual(2);
		expect(onSessionRetired).toHaveBeenCalledOnce();
		expect(onSessionRetired).toHaveBeenCalledWith("retired-session");

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "unrelated-session",
				reason: "session_retired",
			});
		});
		expect(onSessionRetired).toHaveBeenCalledOnce();
	});

	test("acknowledges history expiry only after rebuilding the active snapshot", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("expired-session", {
			id: "expired-session",
			title: "Expired chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("old-message", "user", "Stale snapshot")],
		});
		renderChatPage({ transport, sessionId: "expired-session" });
		expect(await screen.findByText("Stale snapshot")).toBeVisible();
		const expiredSession = transport.sessions.get("expired-session");
		if (expiredSession === undefined) {
			throw new Error("Expired Session fixture was not found.");
		}
		expiredSession.runs = createRunsFromMessages({
			sessionId: expiredSession.id,
			runtimeBoxId: expiredSession.runtimeBoxId,
			messages: [createMessage("new-message", "user", "Rebuilt snapshot")],
		});

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "expired-session",
				reason: "history_expired",
			});
		});

		expect(await screen.findByText("Rebuilt snapshot")).toBeVisible();
		expect(screen.queryByText("Stale snapshot")).not.toBeInTheDocument();
		expect(transport.getSessionCalls.filter((id) => id === "expired-session")).toHaveLength(2);
	});

	test("acknowledges a superseded history refresh after navigation to another Session", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("navigation-session-a", {
			id: "navigation-session-a",
			title: "Navigation Session A",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		transport.sessions.set("navigation-session-b", {
			id: "navigation-session-b",
			title: "Navigation Session B",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		const rendered = renderChatPage({ transport, sessionId: "navigation-session-a" });
		await screen.findByRole("heading", { name: "Navigation Session A" });
		const refreshGate = createDeferred();
		transport.sessionLoadGates.set("navigation-session-a", refreshGate.promise);
		const invalidation = transport.emitInvalidation({
			sessionId: "navigation-session-a",
			reason: "history_expired",
		});
		await waitFor(() =>
			expect(transport.getSessionCalls.filter((id) => id === "navigation-session-a")).toHaveLength(
				2,
			),
		);

		rendered.rerender(
			<I18nProvider>
				<ChatPage transport={transport} sessionId="navigation-session-b" />
			</I18nProvider>,
		);
		await screen.findByRole("heading", { name: "Navigation Session B" });
		refreshGate.resolve();

		await expect(invalidation).resolves.toBeUndefined();
		expect(screen.getByRole("heading", { name: "Navigation Session B" })).toBeVisible();
	});

	test("acknowledges conclusive deletion after removing invalidated renderer state", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("deleted-session", {
			id: "deleted-session",
			title: "Deleted chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [createMessage("deleted-message", "user", "Must be removed")],
		});
		renderChatPage({ transport, sessionId: "deleted-session" });
		expect(await screen.findByText("Must be removed")).toBeVisible();
		transport.nextGetSessionError = new ChatSessionNotFoundError();
		transport.sessions.delete("deleted-session");

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "deleted-session",
				reason: "history_expired",
			});
		});

		expect(screen.queryByText("Must be removed")).not.toBeInTheDocument();
		expect(screen.queryByText("Deleted chat")).not.toBeInTheDocument();
	});

	test.each([
		["product/schema", new Error("Snapshot schema validation failed.")],
		["availability", new AgentsUnavailableError("The agents service is reconnecting.")],
	])("rejects history-expiry acknowledgement after a %s refetch failure", async (_name, error) => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("failed-session", {
			id: "failed-session",
			title: "Failed chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		renderChatPage({ transport, sessionId: "failed-session" });
		await screen.findByRole("heading", { name: "Failed chat" });
		transport.nextGetSessionError = error;

		await expect(
			act(async () => {
				await transport.emitInvalidation({
					sessionId: "failed-session",
					reason: "history_expired",
				});
			}),
		).rejects.toThrow(error.message);
	});

	test("does not make acknowledgement depend on the sidebar refetch", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("expired-session", {
			id: "expired-session",
			title: "Expired chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			model: sessionModel,
			askMode: "Ask",
			messages: [],
		});
		renderChatPage({ transport, sessionId: "expired-session" });
		await screen.findByRole("heading", { name: "Expired chat" });
		transport.nextListSessionsError = new Error("Session list unavailable.");

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "expired-session",
				reason: "history_expired",
			});
		});
		expect(transport.getSessionCalls.filter((id) => id === "expired-session")).toHaveLength(2);
	});
});

describe("Project Chat", () => {
	const projectContext = {
		projectId: "project-a",
		name: "Project A",
		path: "/workspace/a",
		overviewHref: "/projects/project-a",
		settingsHref: "/projects/project-a/settings",
		runtimeReady: true,
		status: "ready" as const,
	};

	test("passes the persisted route Project ID when creating a Session", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		renderChatPage({
			transport,
			routeProjectId: "project-a",
			projectContext: {
				...projectContext,
				runtimeBoxName: "Build host",
				pathStatus: "available",
			},
		});
		expect(screen.getByRole("link", { name: "Project A" })).toHaveAttribute(
			"href",
			"/projects/project-a",
		);
		expect(screen.getByText(/Build host · Runtime ready · Available/)).toBeVisible();
		expect(screen.getByText(/bash is not sandboxed/i)).toBeVisible();
		const prompt = await screen.findByLabelText("Prompt");
		fireEvent.change(prompt, { target: { value: "Project prompt" } });
		fireEvent.keyDown(prompt, { key: "Enter" });
		await waitFor(() => expect(transport.createSessionProjectIds).toEqual(["project-a"]));
	});

	test("rejects route ownership mismatch before subscribing or sending", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		const mismatchedSession: ChatSessionFixture = {
			id: "project-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-b",
			title: "Sensitive Project title",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("existing", "user", "Sensitive Project history")],
			activeResponse: {
				requestId: "sensitive-request",
				messageId: "existing",
			},
		};
		transport.sessions.set("project-session", mismatchedSession);
		renderChatPage({
			transport,
			sessionId: "project-session",
			initialSession: cloneSession(mismatchedSession),
			routeProjectId: "project-a",
			projectContext,
		});
		expect(await screen.findByRole("alert")).toHaveTextContent("belongs to a different Project");
		expect(screen.queryByText("Sensitive Project history")).not.toBeInTheDocument();
		expect(screen.queryByText("Sensitive Project title")).not.toBeInTheDocument();
		expect(transport.listeners.size).toBe(0);
		expect(screen.getByLabelText("Prompt")).toBeDisabled();
	});

	test("masks the previous Project route while replacement ownership hydration is deferred", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		const sessionId = "reused-project-session";
		transport.sessions.set(sessionId, {
			id: sessionId,
			projectId: "project-a",
			title: "Previous Project title",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [
				createMessage("previous-history", "user", "Previous Project history"),
				createMessage("replacement-answer", "assistant", "", "streaming"),
			],
			activeResponse: {
				requestId: "replacement-request",
				messageId: "replacement-answer",
			},
		});
		const rendered = renderChatPage({
			transport,
			sessionId,
			routeProjectId: "project-a",
			projectContext,
		});
		expect(await screen.findByText("Previous Project history")).toBeVisible();
		fireEvent.change(screen.getByLabelText("Prompt"), {
			target: { value: "Previous Project draft" },
		});

		transport.sessions.set(sessionId, {
			id: sessionId,
			projectId: "project-b",
			title: "Replacement Project title",
			updatedAt: "2026-01-02T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("replacement-answer", "assistant", "", "streaming")],
			activeResponse: {
				requestId: "replacement-request",
				messageId: "replacement-answer",
			},
		});
		const gate = createDeferred();
		transport.sessionLoadGates.set(sessionId, gate.promise);
		transport.captureSessionBeforeGate = true;
		rendered.rerender(
			<I18nProvider>
				<MemoryRouter>
					<ChatPage
						transport={transport}
						sessionId={sessionId}
						routeProjectId="project-b"
						projectContext={{
							...projectContext,
							projectId: "project-b",
							name: "Project B",
							overviewHref: "/projects/project-b",
							settingsHref: "/projects/project-b/settings",
						}}
					/>
				</MemoryRouter>
			</I18nProvider>,
		);
		await waitFor(() => expect(transport.getSessionCalls).toEqual([sessionId, sessionId]));
		expect(screen.queryByText("Previous Project title")).not.toBeInTheDocument();
		expect(screen.queryByText("Previous Project history")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("Previous Project draft")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

		transport.emitEvent({
			type: "response.completed",
			sessionId,
			requestId: "replacement-request",
			messageId: "replacement-answer",
			content: "Buffered replacement answer",
			sequence: 1,
		});
		gate.resolve();

		expect(await screen.findByText("Replacement Project title")).toBeVisible();
		expect(await screen.findByText("Buffered replacement answer")).toBeVisible();
		expect(screen.queryByText("Previous Project history")).not.toBeInTheDocument();
	});

	test("buffers Project events during ownership hydration and applies them after a match", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.captureSessionBeforeGate = true;
		transport.sessions.set("hydrating-project-session", {
			id: "hydrating-project-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-a",
			title: "Hydrating Project",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("project-assistant", "assistant", "", "streaming")],
			activeResponse: {
				requestId: "project-request",
				messageId: "project-assistant",
			},
			eventCursors: { "project-request": 0 },
		});

		renderChatPage({
			transport,
			sessionId: "hydrating-project-session",
			routeProjectId: "project-a",
			projectContext,
		});
		await waitFor(() => expect(transport.getSessionCalls).toEqual(["hydrating-project-session"]));
		expect(transport.listenerCountsAtSessionLoad).toEqual([1]);
		transport.emitEvent({
			type: "response.completed",
			sessionId: "hydrating-project-session",
			requestId: "project-request",
			messageId: "project-assistant",
			content: "Buffered Project answer",
			sequence: 1,
		});
		gate.resolve();

		expect(await screen.findByText("Buffered Project answer")).toBeVisible();
	});

	test("discards buffered events when hydrated Project ownership mismatches", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		const gate = createDeferred();
		transport.sessionLoadGate = gate.promise;
		transport.sessions.set("mismatched-hydrating-session", {
			id: "mismatched-hydrating-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-b",
			title: "Wrong Project",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [],
		});

		renderChatPage({
			transport,
			sessionId: "mismatched-hydrating-session",
			routeProjectId: "project-a",
			projectContext,
		});
		await waitFor(() =>
			expect(transport.getSessionCalls).toEqual(["mismatched-hydrating-session"]),
		);
		transport.emitEvent({
			type: "response.completed",
			sessionId: "mismatched-hydrating-session",
			requestId: "wrong-project-request",
			messageId: "wrong-project-message",
			content: "Must not render",
			sequence: 1,
		});
		gate.resolve();

		expect(await screen.findByRole("alert")).toHaveTextContent("belongs to a different Project");
		expect(screen.queryByText("Must not render")).not.toBeInTheDocument();
		expect(transport.listeners.size).toBe(0);
	});

	test("keeps history readable while the Project disables the composer", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("offline-project-session", {
			id: "offline-project-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-a",
			title: "Offline Project",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("offline-history", "user", "Offline readable history")],
		});
		renderChatPage({
			transport,
			sessionId: "offline-project-session",
			routeProjectId: "project-a",
			projectContext: {
				...projectContext,
				runtimeReady: false,
				disabledReason: "Runtime offline for this Project.",
			},
		});
		expect(await screen.findByText("Offline readable history")).toBeVisible();
		expect(screen.getByText("Runtime offline for this Project.")).toBeVisible();
		expect(screen.getByLabelText("Prompt")).toBeDisabled();
	});

	test("shows a bounded root AGENTS warning without stopping the run", async () => {
		const transport = new FakeChatTransport({ configured: true, model: "gpt-4.1-mini" });
		transport.sessions.set("warning-project-session", {
			id: "warning-project-session",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId: "project-a",
			title: "Warning Project",
			updatedAt: "2026-01-01T00:00:00.000Z",
			askMode: "Ask",
			messages: [createMessage("warning-history", "user", "Readable history")],
		});
		transport.eventOnSubscribe = {
			type: "run.warning",
			sessionId: "warning-project-session",
			requestId: "warning-run",
			code: "ROOT_AGENTS_SKIPPED",
			reason: "too_large",
			sequence: 1,
		};
		renderChatPage({
			transport,
			sessionId: "warning-project-session",
			routeProjectId: "project-a",
			projectContext,
		});
		await screen.findByText("Readable history");
		const warnings = await screen.findAllByText(/Root AGENTS\.md was skipped/i);
		expect(warnings.some((warning) => warning.textContent?.includes("64 KiB"))).toBe(true);
		expect(screen.getByLabelText("Prompt")).toBeEnabled();
	});
});

function renderChatPage(props: ChatPageProps) {
	return render(
		<I18nProvider>
			<MemoryRouter>
				<ChatPage {...props} />
			</MemoryRouter>
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

interface ChatMessageFixture {
	id: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
	status: "streaming" | "completed";
}

type ChatSessionFixture = Omit<ChatSession, "runtimeBoxId" | "runs" | "activeResponse"> & {
	runtimeBoxId?: string;
	runs?: ChatRunSnapshot[];
	messages?: ChatMessageFixture[];
	activeResponse?: {
		requestId: string;
		messageId?: string;
	};
	eventCursors?: Record<string, number>;
};

type LegacyTransportEvent =
	| {
			type: "response.delta";
			sessionId: string;
			requestId: string;
			messageId: string;
			delta: string;
			sequence: number;
	  }
	| {
			type: "response.completed";
			sessionId: string;
			requestId: string;
			messageId: string;
			content: string;
			sequence: number;
	  }
	| {
			type: "response.cancelled";
			sessionId: string;
			requestId: string;
			messageId: string;
			content: string;
			reason: string;
			sequence: number;
	  }
	| {
			type: "run.warning";
			sessionId: string;
			requestId: string;
			code: "ROOT_AGENTS_SKIPPED";
			reason: "unknown" | "permission_denied" | "not_regular_file" | "too_large" | "invalid_utf8";
			sequence: number;
	  };

class FakeSessionMap extends Map<string, ChatSession> {
	override set(key: string, value: ChatSessionFixture): this {
		const runtimeBoxId = value.runtimeBoxId ?? defaultLocalRuntimeBoxId;
		const runs =
			value.messages === undefined
				? (value.runs ?? [])
				: createRunsFromMessages({
						sessionId: value.id,
						runtimeBoxId,
						messages: value.messages,
						activeResponse: value.activeResponse,
						eventCursors: value.eventCursors,
					});
		return super.set(key, {
			...value,
			runtimeBoxId,
			runs,
			...(value.activeResponse === undefined
				? {}
				: { activeResponse: { requestId: value.activeResponse.requestId } }),
		});
	}
}

class FakeChatTransport extends ProviderModelTransportDefaults implements ChatTransport {
	sendCalls: Array<{ requestId: string; sessionId: string; message: string }> = [];
	cancelCalls: Array<{ sessionId: string; requestId: string }> = [];
	getSessionCalls: string[] = [];
	createSessionModels: Array<SessionModelSelection | undefined> = [];
	createSessionProjectIds: Array<string | undefined> = [];
	listenerCountsAtSessionLoad: number[] = [];
	listSessionCalls = 0;
	listeners = new Set<ChatTransportListener>();
	invalidationListeners = new Set<ChatSessionInvalidationListener>();
	sessions = new FakeSessionMap();
	pending = new Map<string, { sessionId: string; messageId: string }>();
	clientRequestIds = new Map<string, string>();
	nextSendError: Error | null = null;
	nextCancelError: Error | null = null;
	nextGetSessionError: Error | null = null;
	nextListSessionsError: Error | null = null;
	lastRequestId: string | null = null;
	sessionLoadGate: Promise<void> | null = null;
	sessionLoadGates = new Map<string, Promise<void>>();
	captureSessionBeforeGate = false;
	responseBeforeSendReturns: string | null = null;
	sendReturnGate: Promise<void> | null = null;
	cancelReturnGate: Promise<void> | null = null;
	eventOnSubscribe: ChatTransportEvent | LegacyTransportEvent | null = null;
	createdSessionProjectIdOverride: string | undefined;
	private readonly configuredModel: string;
	private eventSequences = new Map<string, number>();
	private nextSessionNumber = 1;
	private nextMessageNumber = 1;

	constructor({
		configured,
		model = "",
	}: {
		configured: boolean;
		model?: string;
	}) {
		super(
			configured
				? { models: [availableModelFor(model)], defaultModel: modelSelectionFor(model) }
				: { models: [], defaultModel: null },
		);
		this.configuredModel = model;
	}

	async createSession(model?: SessionModelSelection, projectId?: string) {
		this.createSessionModels.push(model);
		this.createSessionProjectIds.push(projectId);
		const resolvedModel =
			model ?? (this.configuredModel === "" ? undefined : modelSelectionFor(this.configuredModel));
		const resolvedProjectId = this.createdSessionProjectIdOverride ?? projectId;
		const session: ChatSession = {
			id: `session-${this.nextSessionNumber}`,
			runtimeBoxId: defaultLocalRuntimeBoxId,
			title: "New chat",
			updatedAt: "2026-01-01T00:00:00.000Z",
			...(resolvedProjectId === undefined ? {} : { projectId: resolvedProjectId }),
			...(resolvedModel === undefined ? {} : { model: resolvedModel }),
			askMode: "Ask",
			runs: [],
		};
		this.nextSessionNumber += 1;
		this.sessions.set(session.id, session);
		return cloneSession(session);
	}

	async getSession(sessionId: string) {
		this.getSessionCalls.push(sessionId);
		this.listenerCountsAtSessionLoad.push(this.listeners.size);
		const error = this.consume("nextGetSessionError");
		if (error) {
			await (this.sessionLoadGates.get(sessionId) ?? this.sessionLoadGate);
			throw error;
		}
		const session = this.sessions.get(sessionId);
		const capturedSession =
			this.captureSessionBeforeGate && session !== undefined ? cloneSession(session) : undefined;
		await (this.sessionLoadGates.get(sessionId) ?? this.sessionLoadGate);
		const resolvedSession = capturedSession ?? this.sessions.get(sessionId);
		if (!resolvedSession) {
			throw new Error("Session not found.");
		}
		return cloneSession(resolvedSession);
	}

	async listSessions(input: { query?: string; archived?: boolean; limit?: number } = {}) {
		this.listSessionCalls += 1;
		const error = this.consume("nextListSessionsError");
		if (error) {
			throw error;
		}
		const query = input.query?.toLocaleLowerCase() ?? "";
		return [...this.sessions.values()]
			.filter((session) => (session.archivedAt !== undefined) === (input.archived ?? false))
			.filter((session) => session.title.toLocaleLowerCase().includes(query))
			.slice(0, input.limit ?? 50)
			.map((session) => ({
				id: session.id,
				runtimeBoxId: session.runtimeBoxId,
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

	async send(input: { requestId: string; sessionId: string; message: string }) {
		this.sendCalls.push(input);
		const error = this.consume("nextSendError");
		if (error) {
			await this.sendReturnGate;
			throw error;
		}

		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error("Session not found.");
		}

		const userMessageId = `user-${this.nextMessageNumber}`;
		this.nextMessageNumber += 1;
		const textPartId = `assistant-${this.nextMessageNumber}`;
		this.nextMessageNumber += 1;
		const requestId =
			this.responseBeforeSendReturns === null ? input.requestId : `run-${input.requestId}`;
		const createdAt = "2026-01-01T00:00:00.000Z";
		const textPart: ChatRunTextPart = {
			schemaVersion: 1,
			id: textPartId,
			runId: requestId,
			position: 1,
			assistantTurnId: `${requestId}-turn`,
			revision: 1,
			kind: "text",
			status: "streaming",
			content: "",
			createdAt,
			updatedAt: createdAt,
		};
		const run: ChatRunSnapshot = {
			schemaVersion: 1,
			id: requestId,
			sessionId: input.sessionId,
			runtimeBoxId: session.runtimeBoxId,
			mode: "agent",
			status: "running",
			provider: createRunProvider(),
			userMessageId,
			createdAt,
			updatedAt: createdAt,
			userMessage: {
				schemaVersion: 1,
				id: userMessageId,
				sessionId: input.sessionId,
				runId: requestId,
				role: "user",
				content: input.message,
				createdAt,
			},
			timeline: [textPart],
			lastEventSeq: 1,
		};
		session.runs.push(run);
		if (session.title === "New chat") {
			session.title = input.message;
		}
		this.pending.set(requestId, {
			sessionId: input.sessionId,
			messageId: textPart.id,
		});
		this.clientRequestIds.set(requestId, input.requestId);
		session.activeResponse = { requestId };
		this.eventSequences.set(requestId, 1);
		this.lastRequestId = requestId;
		if (this.responseBeforeSendReturns !== null) {
			this.emitDelta(requestId, this.responseBeforeSendReturns);
			this.emitCompleted(requestId);
		}
		await this.sendReturnGate;

		return {
			requestId,
			run: structuredClone(run),
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
		const session = this.requireSession(input.sessionId);
		const run = requireRun(session, input.requestId);
		const part = requireTextPart(run, pending.messageId);
		const completedEvent = makeTextCompletedEvent({
			run,
			part: {
				...part,
				revision: part.revision + 1,
				status: "interrupted",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
			seq: this.nextEventSequence(input.requestId),
		});
		this.applyStoredEvent(session, completedEvent);
		this.notify(completedEvent);
		const statusEvent = makeRunStatusEvent(
			run,
			"cancelled",
			this.nextEventSequence(input.requestId),
		);
		this.applyStoredEvent(session, statusEvent);
		delete session.activeResponse;
		this.notify(statusEvent);
	}

	subscribe(listener: ChatTransportListener) {
		this.listeners.add(listener);
		if (this.eventOnSubscribe !== null) {
			const event = this.eventOnSubscribe;
			this.eventOnSubscribe = null;
			for (const normalized of this.normalizeEvent(event)) {
				listener(normalized);
			}
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	subscribeSessionInvalidations(listener: ChatSessionInvalidationListener) {
		this.invalidationListeners.add(listener);
		return () => {
			this.invalidationListeners.delete(listener);
		};
	}

	async emitInvalidation(invalidation: ChatSessionInvalidation): Promise<void> {
		for (const listener of [...this.invalidationListeners]) {
			await listener(invalidation);
		}
	}

	emitEvent(event: ChatTransportEvent | LegacyTransportEvent): void {
		for (const normalized of this.normalizeEvent(event)) {
			this.notify(normalized);
		}
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

		const run = requireRun(session, requestId);
		const part = requireTextPart(run, pending.messageId);
		const event: ChatRunEvent = {
			schemaVersion: 1,
			id: `${requestId}-delta-${part.revision + 1}`,
			runId: requestId,
			sessionId: pending.sessionId,
			seq: this.nextEventSequence(requestId),
			type: "timeline.text.delta",
			source: { kind: "assistant" },
			visibility: "user",
			createdAt: "2026-01-01T00:00:01.000Z",
			payload: {
				partId: pending.messageId,
				revision: part.revision + 1,
				delta,
			},
		};
		this.applyStoredEvent(session, event);
		this.notify(event);
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

		const run = requireRun(session, requestId);
		const part = requireTextPart(run, pending.messageId);
		const completedEvent = makeTextCompletedEvent({
			run,
			part: {
				...part,
				revision: part.revision + 1,
				status: "completed",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
			seq: this.nextEventSequence(requestId),
		});
		this.applyStoredEvent(session, completedEvent);
		this.notify(completedEvent);
		const statusEvent = makeRunStatusEvent(run, "completed", this.nextEventSequence(requestId));
		this.applyStoredEvent(session, statusEvent);
		this.pending.delete(requestId);
		delete session.activeResponse;
		this.notify(statusEvent);
	}

	private nextEventSequence(requestId: string) {
		const sequence = (this.eventSequences.get(requestId) ?? 0) + 1;
		this.eventSequences.set(requestId, sequence);
		return sequence;
	}

	private applyStoredEvent(session: ChatSession, event: ChatRunEvent): void {
		session.runs = session.runs.map((run) =>
			run.id === event.runId ? applyFixtureEvent(run, event) : run,
		);
	}

	private normalizeEvent(event: ChatTransportEvent | LegacyTransportEvent): ChatRunEvent[] {
		if ("schemaVersion" in event) {
			return [event];
		}
		if (event.type === "run.warning") {
			const runId =
				this.sessions.get(event.sessionId)?.runs.find((run) => run.id === event.requestId)?.id ??
				this.sessions.get(event.sessionId)?.runs[0]?.id ??
				event.requestId;
			return [
				{
					schemaVersion: 1,
					id: `${event.requestId}-warning-${event.sequence}`,
					runId,
					sessionId: event.sessionId,
					seq: event.sequence,
					type: "run.warning",
					source: { kind: "system" },
					visibility: "user",
					createdAt: "2026-01-01T00:00:01.000Z",
					payload: { code: event.code, reason: event.reason },
				},
			];
		}
		return normalizeLegacyEvent(event, this.sessions.get(event.sessionId));
	}

	private consume(
		key: "nextSendError" | "nextCancelError" | "nextGetSessionError" | "nextListSessionsError",
	) {
		const error = this[key];
		this[key] = null;
		return error;
	}

	private notify(event: ChatTransportEvent) {
		const clientRequestId = this.clientRequestIds.get(event.runId);
		const delivery = clientRequestId === undefined ? event : { ...event, clientRequestId };
		for (const listener of this.listeners) {
			listener(delivery);
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
			runtimeBoxId: session.runtimeBoxId,
			title: session.title,
			createdAt: session.updatedAt,
			updatedAt: session.updatedAt,
			...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
		};
	}
}

function createMessage(
	id: string,
	role: ChatMessageFixture["role"],
	content: string,
	status: ChatMessageFixture["status"] = "completed",
): ChatMessageFixture {
	return {
		id,
		role,
		content,
		createdAt: "2026-01-01T00:00:00.000Z",
		status,
	};
}

function createRunProvider(): ChatRunSnapshot["provider"] {
	return {
		schemaVersion: 1,
		providerId: "provider-openai",
		name: "OpenAI",
		source: "custom",
		api: "openai-responses",
		model: "gpt-4.1-mini",
		status: "ready",
	};
}

function createRunsFromMessages(input: {
	sessionId: string;
	runtimeBoxId: string;
	messages: ChatMessageFixture[];
	activeResponse?: ChatSessionFixture["activeResponse"];
	eventCursors?: Record<string, number>;
}): ChatRunSnapshot[] {
	const runs: ChatRunSnapshot[] = [];
	const cursorRunIds = Object.keys(input.eventCursors ?? {});
	let cursorIndex = 0;

	for (let index = 0; index < input.messages.length; index += 1) {
		const fixtureMessage = input.messages[index];
		if (fixtureMessage === undefined) {
			continue;
		}
		let userMessage: ChatMessageFixture;
		let assistantMessage: ChatMessageFixture | undefined;
		if (fixtureMessage.role === "user") {
			userMessage = fixtureMessage;
			assistantMessage =
				input.messages[index + 1]?.role === "assistant" ? input.messages[index + 1] : undefined;
			if (assistantMessage !== undefined) {
				index += 1;
			}
		} else {
			assistantMessage = fixtureMessage;
			userMessage = createMessage(
				`${fixtureMessage.id}-user`,
				"user",
				"Previous question",
				"completed",
			);
		}
		const isActive =
			input.activeResponse !== undefined &&
			(input.activeResponse.messageId === undefined ||
				input.activeResponse.messageId === assistantMessage?.id);
		const cursorRunId = cursorRunIds[cursorIndex];
		if (cursorRunId !== undefined) {
			cursorIndex += 1;
		}
		const runId = isActive
			? input.activeResponse?.requestId
			: (cursorRunId ?? `run-${userMessage.id}`);
		if (runId === undefined) {
			throw new Error("Run fixture id was not resolved.");
		}
		const lastEventSeq = input.eventCursors?.[runId] ?? 0;
		const runStatus =
			isActive || assistantMessage?.status === "streaming" ? "running" : "completed";
		const timeline: ChatRunTextPart[] =
			assistantMessage === undefined
				? []
				: [
						{
							schemaVersion: 1,
							id: assistantMessage.id,
							runId,
							position: 1,
							assistantTurnId: `${runId}-turn`,
							revision: Math.max(1, lastEventSeq),
							kind: "text",
							status: assistantMessage.status === "completed" ? "completed" : "streaming",
							content: assistantMessage.content,
							createdAt: assistantMessage.createdAt,
							updatedAt: assistantMessage.createdAt,
						},
					];
		runs.push({
			schemaVersion: 1,
			id: runId,
			sessionId: input.sessionId,
			runtimeBoxId: input.runtimeBoxId,
			mode: "agent",
			status: runStatus,
			provider: createRunProvider(),
			userMessageId: userMessage.id,
			createdAt: userMessage.createdAt,
			updatedAt: assistantMessage?.createdAt ?? userMessage.createdAt,
			...(runStatus === "completed"
				? { completedAt: assistantMessage?.createdAt ?? userMessage.createdAt }
				: {}),
			userMessage: {
				schemaVersion: 1,
				id: userMessage.id,
				sessionId: input.sessionId,
				runId,
				role: "user",
				content: userMessage.content,
				createdAt: userMessage.createdAt,
			},
			timeline,
			lastEventSeq,
		});
	}
	return runs;
}

function requireRun(session: ChatSession, runId: string): ChatRunSnapshot {
	const run = session.runs.find((candidate) => candidate.id === runId);
	if (run === undefined) {
		throw new Error(`Run ${runId} was not found.`);
	}
	return run;
}

function requireTextPart(run: ChatRunSnapshot, partId: string): ChatRunTextPart {
	const part = run.timeline.find((candidate) => candidate.id === partId);
	if (part?.kind !== "text") {
		throw new Error(`Text Part ${partId} was not found.`);
	}
	return part;
}

function makeTextCompletedEvent(input: {
	run: ChatRunSnapshot;
	part: ChatRunTextPart;
	seq: number;
}): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: `${input.run.id}-text-completed-${input.seq}`,
		runId: input.run.id,
		sessionId: input.run.sessionId,
		seq: input.seq,
		type: "timeline.text.completed",
		source: { kind: "assistant" },
		visibility: "user",
		createdAt: input.part.updatedAt,
		payload: { part: input.part },
	};
}

function makeRunStatusEvent(
	run: ChatRunSnapshot,
	status: ChatRunSnapshot["status"],
	seq: number,
): ChatRunEvent {
	return {
		schemaVersion: 1,
		id: `${run.id}-status-${seq}`,
		runId: run.id,
		sessionId: run.sessionId,
		seq,
		type: "run.status",
		source: { kind: "system" },
		visibility: "user",
		createdAt: "2026-01-01T00:00:01.000Z",
		payload: { status, previousStatus: run.status },
	};
}

function normalizeLegacyEvent(
	event: Exclude<LegacyTransportEvent, { type: "run.warning" }>,
	session: ChatSession | undefined,
): ChatRunEvent[] {
	const run =
		session?.runs.find((candidate) => candidate.id === event.requestId) ??
		session?.runs.find((candidate) =>
			candidate.timeline.some((part) => part.id === event.messageId),
		);
	const matchingPart = run?.timeline.find((candidate) => candidate.id === event.messageId);
	const currentPart: ChatRunTextPart =
		matchingPart?.kind === "text"
			? matchingPart
			: {
					schemaVersion: 1,
					id: event.messageId,
					runId: event.requestId,
					position: 1,
					assistantTurnId: `${event.requestId}-turn`,
					revision: 1,
					kind: "text",
					status: "streaming",
					content: "",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				};
	const runId = run?.id === event.requestId ? run.id : event.requestId;
	const revision = Math.max(currentPart.revision + 1, event.sequence);
	const base = {
		schemaVersion: 1 as const,
		runId,
		sessionId: event.sessionId,
		seq: event.sequence,
		source: { kind: "assistant" as const },
		visibility: "user" as const,
		createdAt: "2026-01-01T00:00:01.000Z",
	};

	if (event.type === "response.delta") {
		return [
			{
				...base,
				id: `${runId}-delta-${event.sequence}`,
				type: "timeline.text.delta",
				payload: { partId: event.messageId, revision, delta: event.delta },
			},
		];
	}

	const status = event.type === "response.cancelled" ? "cancelled" : "completed";
	const partStatus = event.type === "response.cancelled" ? "interrupted" : "completed";
	const part: ChatRunTextPart = {
		...currentPart,
		runId,
		revision,
		status: partStatus,
		content: event.content,
		updatedAt: base.createdAt,
	};
	const completed: ChatRunEvent = {
		...base,
		id: `${runId}-text-completed-${event.sequence}`,
		type: "timeline.text.completed",
		payload: { part },
	};
	const statusEvent: ChatRunEvent = {
		...base,
		id: `${runId}-status-${event.sequence + 1}`,
		seq: event.sequence + 1,
		type: "run.status",
		source: { kind: "system" },
		payload: {
			status,
			...(run === undefined ? {} : { previousStatus: run.status }),
		},
	};
	return [completed, statusEvent];
}

function cloneSession(session: ChatSession | ChatSessionFixture): ChatSession {
	if ("runs" in session && session.runs !== undefined && !("messages" in session)) {
		return structuredClone(session) as ChatSession;
	}
	const fixture = session as ChatSessionFixture;
	const runtimeBoxId = fixture.runtimeBoxId ?? defaultLocalRuntimeBoxId;
	const runs =
		fixture.runs ??
		createRunsFromMessages({
			sessionId: fixture.id,
			runtimeBoxId,
			messages: fixture.messages ?? [],
			activeResponse: fixture.activeResponse,
			eventCursors: fixture.eventCursors,
		});
	return {
		id: fixture.id,
		runtimeBoxId,
		...(fixture.projectId === undefined ? {} : { projectId: fixture.projectId }),
		title: fixture.title,
		updatedAt: fixture.updatedAt,
		...(fixture.archivedAt === undefined ? {} : { archivedAt: fixture.archivedAt }),
		...(fixture.model === undefined ? {} : { model: fixture.model }),
		askMode: fixture.askMode,
		runs: structuredClone(runs),
		...(fixture.activeResponse === undefined
			? {}
			: { activeResponse: { requestId: fixture.activeResponse.requestId } }),
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
