import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ChatSessionNotFoundError } from "../../../../shared/rpc-errors";
import { I18nProvider } from "../i18n";
import { isRendererSessionRetired } from "./session-recovery-coordinator";
import { SessionSidebar } from "./session-sidebar";
import { ProviderModelTransportDefaults } from "./test-transport-defaults";
import type {
	ChatSession,
	ChatSessionSummary,
	ChatTransport,
	ListChatSessionsOptions,
} from "./transport";

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	sessionStorage.clear();
	localStorage.clear();
	window.history.replaceState(null, "");
	vi.restoreAllMocks();
});

describe("SessionSidebar", () => {
	test("searches and selects active Sessions", async () => {
		const transport = new FakeSessionTransport();
		const onSelectSession = vi.fn();

		renderSidebar(transport, { onSelectSession });

		expect(await screen.findByText("Architecture notes")).toBeVisible();
		expect(screen.getByText("Launch plan")).toBeVisible();
		expect(screen.queryByPlaceholderText("Search chats")).not.toBeInTheDocument();
		const filterButton = screen.getByRole("button", { name: "Filter chats" });
		expect(filterButton).toHaveAttribute("title", "Filter chats");
		expect(screen.getByRole("button", { name: "New session" })).toHaveAttribute(
			"title",
			"New session",
		);
		fireEvent.click(filterButton);
		fireEvent.change(screen.getByPlaceholderText("Search chats"), {
			target: { value: "launch" },
		});

		await waitFor(() => expect(screen.queryByText("Architecture notes")).not.toBeInTheDocument());
		fireEvent.click(screen.getByText("Launch plan"));
		expect(onSelectSession).toHaveBeenCalledWith("session-2");
	});

	test("renames, archives, restores, and deletes Sessions", async () => {
		const transport = new FakeSessionTransport();
		const onNewSession = vi.fn();

		renderSidebar(transport, {
			selectedSessionId: "session-1",
			onNewSession,
		});
		localStorage.setItem("moshu.lastChatSessionId", "session-1");
		window.history.replaceState(
			{ usr: { hydratedSession: { id: "session-1", title: "stale transcript" } } },
			"",
		);

		const initialItem = (await screen.findByText("Architecture notes")).closest("li");
		if (initialItem === null) {
			throw new Error("Session item was not rendered.");
		}
		const actionsButton = within(initialItem).getByLabelText("Chat actions");
		expect(actionsButton).toHaveAttribute("title", "Chat actions");
		fireEvent.click(actionsButton);
		fireEvent.click(within(initialItem).getByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByLabelText("Chat title"), {
			target: { value: "System design" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("System design")).toBeVisible();

		const renamedItem = screen.getByText("System design").closest("li");
		if (renamedItem === null) {
			throw new Error("Renamed Session item was not rendered.");
		}
		fireEvent.click(within(renamedItem).getByLabelText("Chat actions"));
		fireEvent.click(within(renamedItem).getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(screen.queryByText("System design")).not.toBeInTheDocument());
		expect(onNewSession).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole("button", { name: "Filter chats" }));
		fireEvent.click(screen.getByRole("button", { name: "Archived" }));
		expect(await screen.findByText("System design")).toBeVisible();
		const archivedItem = screen.getByText("System design").closest("li");
		if (archivedItem === null) {
			throw new Error("Archived Session item was not rendered.");
		}
		fireEvent.click(within(archivedItem).getByLabelText("Chat actions"));
		fireEvent.click(within(archivedItem).getByRole("button", { name: "Restore" }));
		await waitFor(() => expect(screen.queryByText("System design")).not.toBeInTheDocument());

		fireEvent.click(screen.getByRole("button", { name: "Active" }));
		const restoredItem = (await screen.findByText("System design")).closest("li");
		if (restoredItem === null) {
			throw new Error("Restored Session item was not rendered.");
		}
		fireEvent.click(within(restoredItem).getByLabelText("Chat actions"));
		fireEvent.click(within(restoredItem).getByRole("button", { name: "Delete" }));
		const cancelledDialog = await screen.findByRole("alertdialog");
		expect(transport.deletedSessionIds).toEqual([]);
		fireEvent.click(within(cancelledDialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

		fireEvent.click(within(restoredItem).getByRole("button", { name: "Delete" }));
		const confirmedDialog = await screen.findByRole("alertdialog");
		expect(within(confirmedDialog).getByText(/Permanently delete "System design"/)).toBeVisible();
		fireEvent.click(within(confirmedDialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByText("System design")).not.toBeInTheDocument());
		expect(transport.deletedSessionIds).toEqual(["session-1"]);
		expect(isRendererSessionRetired("session-1")).toBe(true);
		expect(localStorage.getItem("moshu.lastChatSessionId")).toBeNull();
		expect(window.history.state).toEqual({ usr: {} });
	});

	test("keeps the current selection when a delayed delete completes", async () => {
		const transport = new FakeSessionTransport();
		const onNewSession = vi.fn();
		let resolveDelete: (() => void) | undefined;
		vi.spyOn(transport, "deleteSession").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDelete = resolve;
				}),
		);

		const view = renderSidebar(transport, {
			selectedSessionId: "session-1",
			onNewSession,
		});
		const initialItem = (await screen.findByText("Architecture notes")).closest("li");
		if (initialItem === null) {
			throw new Error("Session item was not rendered.");
		}
		fireEvent.click(within(initialItem).getByLabelText("Chat actions"));
		fireEvent.click(within(initialItem).getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(transport.deleteSession).toHaveBeenCalledOnce());

		view.rerender(
			<I18nProvider>
				<SessionSidebar
					transport={transport}
					selectedSessionId="session-2"
					refreshKey="test"
					onNewSession={onNewSession}
					onSelectSession={() => {}}
				/>
			</I18nProvider>,
		);
		await act(async () => {
			resolveDelete?.();
		});

		expect(onNewSession).not.toHaveBeenCalled();
		expect(isRendererSessionRetired("session-1")).toBe(true);
	});

	test("treats typed SESSION_NOT_FOUND deletion as conclusive retirement", async () => {
		const transport = new FakeSessionTransport();
		vi.spyOn(transport, "deleteSession").mockRejectedValueOnce(new ChatSessionNotFoundError());
		renderSidebar(transport, { selectedSessionId: "session-1" });
		const item = (await screen.findByText("Architecture notes")).closest("li");
		if (item === null) {
			throw new Error("Session item was not rendered.");
		}
		fireEvent.click(within(item).getByLabelText("Chat actions"));
		fireEvent.click(within(item).getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

		await waitFor(() => expect(screen.queryByText("Architecture notes")).not.toBeInTheDocument());
		expect(isRendererSessionRetired("session-1")).toBe(true);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	test.each(["rename", "archive"] as const)(
		"globally retires only the missing Session after a typed %s failure",
		async (operation) => {
			const transport = new FakeSessionTransport();
			const onNewSession = vi.fn();
			if (operation === "rename") {
				vi.spyOn(transport, "renameSession").mockRejectedValueOnce(new ChatSessionNotFoundError());
			} else {
				vi.spyOn(transport, "setSessionArchived").mockRejectedValueOnce(
					new ChatSessionNotFoundError(),
				);
			}
			localStorage.setItem("moshu.lastChatSessionId", "session-2");
			window.history.replaceState(
				{ usr: { hydratedSession: { id: "session-2", title: "keep" } } },
				"",
			);
			renderSidebar(transport, {
				selectedSessionId: "session-2",
				onNewSession,
			});
			const item = (await screen.findByText("Architecture notes")).closest("li");
			if (item === null) {
				throw new Error("Session item was not rendered.");
			}
			fireEvent.click(within(item).getByLabelText("Chat actions"));
			if (operation === "rename") {
				fireEvent.click(within(item).getByRole("button", { name: "Rename" }));
				fireEvent.click(screen.getByRole("button", { name: "Save" }));
			} else {
				fireEvent.click(within(item).getByRole("button", { name: "Archive" }));
			}

			await waitFor(() => expect(screen.queryByText("Architecture notes")).not.toBeInTheDocument());
			expect(isRendererSessionRetired("session-1")).toBe(true);
			expect(isRendererSessionRetired("session-2")).toBe(false);
			expect(screen.getByText("Launch plan")).toBeVisible();
			expect(localStorage.getItem("moshu.lastChatSessionId")).toBe("session-2");
			expect(window.history.state.usr.hydratedSession.id).toBe("session-2");
			expect(onNewSession).not.toHaveBeenCalled();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);
});

function renderSidebar(
	transport: ChatTransport,
	options: {
		selectedSessionId?: string;
		onNewSession?: () => void;
		onSelectSession?: (sessionId: string) => void;
	} = {},
) {
	return render(
		<I18nProvider>
			<SessionSidebar
				transport={transport}
				selectedSessionId={options.selectedSessionId}
				refreshKey="test"
				onNewSession={options.onNewSession ?? (() => {})}
				onSelectSession={options.onSelectSession ?? (() => {})}
			/>
		</I18nProvider>,
	);
}

class FakeSessionTransport extends ProviderModelTransportDefaults implements ChatTransport {
	readonly deletedSessionIds: string[] = [];
	readonly #sessions: ChatSessionSummary[] = [
		{
			id: "session-1",
			title: "Architecture notes",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "session-2",
			title: "Launch plan",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-03T00:00:00.000Z",
		},
	];

	async createSession(): Promise<ChatSession> {
		throw new Error("Not used.");
	}

	async getSession(): Promise<ChatSession> {
		throw new Error("Not used.");
	}

	async listSessions(input: ListChatSessionsOptions = {}) {
		const query = input.query?.toLocaleLowerCase() ?? "";
		return this.#sessions
			.filter((session) => (session.archivedAt !== undefined) === (input.archived ?? false))
			.filter((session) => session.title.toLocaleLowerCase().includes(query))
			.map((session) => ({ ...session }));
	}

	async renameSession(sessionId: string, title: string) {
		const session = this.requireSession(sessionId);
		session.title = title;
		return { ...session };
	}

	async setSessionArchived(sessionId: string, archived: boolean) {
		const session = this.requireSession(sessionId);
		if (archived) {
			session.archivedAt = "2026-01-04T00:00:00.000Z";
		} else {
			delete session.archivedAt;
		}
		return { ...session };
	}

	async deleteSession(sessionId: string) {
		const index = this.#sessions.findIndex((session) => session.id === sessionId);
		if (index < 0) {
			throw new Error("Session not found.");
		}
		this.#sessions.splice(index, 1);
		this.deletedSessionIds.push(sessionId);
	}

	async send(): Promise<never> {
		throw new Error("Not used.");
	}

	async cancel(): Promise<void> {}

	subscribe() {
		return () => {};
	}

	private requireSession(sessionId: string) {
		const session = this.#sessions.find((candidate) => candidate.id === sessionId);
		if (session === undefined) {
			throw new Error("Session not found.");
		}
		return session;
	}
}
