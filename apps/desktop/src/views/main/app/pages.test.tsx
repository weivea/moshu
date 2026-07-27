import { maxRetainedSessionRetirements, retiredSessionTombstoneTtlMs } from "@moshu/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentsUnavailableError, ChatSessionNotFoundError } from "../../../shared/rpc-errors";
import { getChatSessionRecoveryCoordinator } from "./chat/session-recovery-coordinator";
import {
	modelSelectionFor,
	testAvailableModel,
	testDefaultModel,
} from "./chat/test-transport-defaults";
import type {
	ChatSession,
	ChatSessionInvalidation,
	ChatSessionInvalidationListener,
	ChatTransport,
	ChatTransportListener,
} from "./chat/transport";
import { I18nProvider } from "./i18n";
import { ChatHomePage, ChatSessionPage, NewChatPage } from "./pages";

vi.mock("../lib/rpc", () => ({
	desktopClient: {
		subscribeAgentsReady: () => () => undefined,
		subscribeChatEvents: () => () => undefined,
		subscribeChatSessionInvalidations: () => () => undefined,
	},
}));

const rememberedSessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const nextSessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf";
const storageKey = "moshu.lastChatSessionId";
const retirementStorageKey = "moshu.retiredChatSessions.v1";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe("ChatHomePage initial hydration", () => {
	test("retains and hydrates the same remembered Session when agents become ready", async () => {
		const transport = new InitialHydrationTransport([
			new AgentsUnavailableError(),
			createSession(),
		]);
		localStorage.setItem(storageKey, rememberedSessionId);
		renderHome(transport);

		expect(await screen.findByRole("alert")).toHaveTextContent("AGENTS_UNAVAILABLE");
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);

		act(() => transport.emitReady());

		await waitFor(() =>
			expect(screen.getByTestId("location")).toHaveTextContent(`/chat/${rememberedSessionId}`),
		);
		expect(screen.getByTestId("location")).toHaveTextContent("Remembered Session");
		expect(transport.getSessionCalls).toEqual([rememberedSessionId, rememberedSessionId]);
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);
	});

	test("retains remembered state and surfaces a generic product or schema error", async () => {
		const transport = new InitialHydrationTransport([new Error("Unexpected product schema.")]);
		localStorage.setItem(storageKey, rememberedSessionId);
		renderHome(transport);

		expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected product schema.");
		expect(screen.getByTestId("location")).toHaveTextContent("/chat");
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);
	});

	test("clears remembered state only for a recognized Session miss", async () => {
		const transport = new InitialHydrationTransport([new ChatSessionNotFoundError()]);
		localStorage.setItem(storageKey, rememberedSessionId);
		renderHome(transport);

		await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/chat/new"));
		expect(localStorage.getItem(storageKey)).toBeNull();
	});

	test("cancels a debounced retry and readiness subscription after a route change", async () => {
		const transport = new InitialHydrationTransport([
			new AgentsUnavailableError(),
			createSession(),
		]);
		localStorage.setItem(storageKey, rememberedSessionId);
		renderHome(transport, 20);
		await screen.findByRole("alert");

		fireEvent.click(screen.getByRole("button", { name: "Leave chat" }));
		expect(screen.getByTestId("location")).toHaveTextContent("/other");
		expect(transport.readyListenerCount).toBe(0);
		act(() => transport.emitReady());
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(transport.getSessionCalls).toEqual([rememberedSessionId]);
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);
	});
});

describe("ChatSessionPage retirement", () => {
	test("explicit deletion retires history before navigation and cannot flash it on Back", async () => {
		const session = createSession();
		const transport = new SessionRouteTransport(session);
		const staleSnapshot = {
			...session,
			title: "Stale history snapshot",
			messages: [],
		};
		localStorage.setItem(storageKey, rememberedSessionId);
		render(
			<I18nProvider>
				<MemoryRouter
					initialEntries={[
						{
							pathname: `/chat/${rememberedSessionId}`,
							state: { hydratedSession: staleSnapshot },
						},
						{
							pathname: `/chat/${rememberedSessionId}`,
							state: { hydratedSession: staleSnapshot },
						},
					]}
					initialIndex={1}
				>
					<LocationProbe />
					<HistoryBackButton />
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
						/>
						<Route
							path="/chat/new"
							element={<NewChatPage transport={transport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);

		expect(await screen.findByRole("heading", { name: "Remembered Session" })).toBeVisible();
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: "unrelated-session",
				reason: "session_retired",
			});
		});

		expect(screen.getByTestId("location")).toHaveTextContent(`/chat/${rememberedSessionId}`);
		expect(localStorage.getItem(storageKey)).toBe(rememberedSessionId);

		transport.retire();
		await act(async () => {
			getChatSessionRecoveryCoordinator(transport as unknown as ChatTransport).recordSessionRetired(
				rememberedSessionId,
			);
		});
		await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/chat/new|"));
		expect(localStorage.getItem(storageKey)).toBeNull();
		expect(screen.queryByText("Stale history snapshot")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.queryByText("Stale history snapshot")).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/chat/new|"));
		expect(transport.getSessionCalls.filter((id) => id === rememberedSessionId).length).toBe(1);
		expect(localStorage.getItem(storageKey)).toBeNull();
	});

	test("preserves an unrelated remembered Session when the active route retires", async () => {
		const session = createSession();
		const transport = new SessionRouteTransport(session);
		const unrelatedSessionId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf";
		render(
			<I18nProvider>
				<MemoryRouter initialEntries={[`/chat/${rememberedSessionId}`]}>
					<LocationProbe />
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
						/>
						<Route
							path="/chat/new"
							element={<NewChatPage transport={transport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(await screen.findByRole("heading", { name: "Remembered Session" })).toBeVisible();
		localStorage.setItem(storageKey, unrelatedSessionId);
		transport.retire();

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: rememberedSessionId,
				reason: "session_retired",
			});
		});

		await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/chat/new"));
		expect(localStorage.getItem(storageKey)).toBe(unrelatedSessionId);
	});

	test("tombstones inactive retirement and never refetches or flashes it on back navigation", async () => {
		const staleSession = createSessionForId(rememberedSessionId, "Retired Session A snapshot");
		const activeSession = createSessionForId(nextSessionId, "Active Session B");
		const transport = new SessionRouteTransport(activeSession);
		render(
			<I18nProvider>
				<MemoryRouter
					initialEntries={[
						{
							pathname: `/chat/${rememberedSessionId}`,
							state: { hydratedSession: staleSession },
						},
						`/chat/${nextSessionId}`,
					]}
					initialIndex={1}
				>
					<LocationProbe />
					<HistoryBackButton />
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
						/>
						<Route
							path="/chat/new"
							element={<NewChatPage transport={transport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(await screen.findByRole("heading", { name: "Active Session B" })).toBeVisible();

		await act(async () => {
			await transport.emitInvalidation({
				sessionId: rememberedSessionId,
				reason: "session_retired",
			});
		});
		fireEvent.click(screen.getByRole("button", { name: "Back" }));

		await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/chat/new"));
		expect(screen.queryByText("Retired Session A snapshot")).not.toBeInTheDocument();
		expect(transport.getSessionCalls).not.toContain(rememberedSessionId);
	});

	test("rejects persisted retired snapshots after remount without affecting another Session", async () => {
		sessionStorage.setItem(
			retirementStorageKey,
			JSON.stringify([{ sessionId: rememberedSessionId, retiredAtMs: Date.now() }]),
		);
		const staleSession = createSessionForId(rememberedSessionId, "Persisted stale snapshot");
		const never = new Promise<ChatSession>(() => {});
		const retiredTransport = new DelayedRouteTransport(
			createSessionForId(nextSessionId, "Other Session"),
			never,
		);
		const retiredRender = render(
			<I18nProvider>
				<MemoryRouter
					initialEntries={[
						{
							pathname: `/chat/${rememberedSessionId}`,
							state: { hydratedSession: staleSession },
						},
					]}
				>
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={retiredTransport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(
			screen.queryByRole("heading", { name: "Persisted stale snapshot" }),
		).not.toBeInTheDocument();
		retiredRender.unmount();

		const otherSession = createSessionForId(nextSessionId, "Other cached snapshot");
		const otherTransport = new SessionRouteTransport(otherSession);
		render(
			<I18nProvider>
				<MemoryRouter
					initialEntries={[
						{
							pathname: `/chat/${nextSessionId}`,
							state: { hydratedSession: otherSession },
						},
					]}
				>
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={otherTransport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(await screen.findByRole("heading", { name: "Other cached snapshot" })).toBeVisible();
	});

	test("backpressures full retirement storage without evicting an unexpired tombstone", async () => {
		const nowMs = Date.now();
		sessionStorage.setItem(
			retirementStorageKey,
			JSON.stringify(
				Array.from({ length: maxRetainedSessionRetirements }, (_, index) => ({
					sessionId: `retired-${index}`,
					retiredAtMs: nowMs - index,
				})),
			),
		);
		const session = createSession();
		const transport = new SessionRouteTransport(session);
		const rendered = render(
			<I18nProvider>
				<MemoryRouter initialEntries={[`/chat/${rememberedSessionId}`]}>
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
						/>
						<Route
							path="/chat/new"
							element={<NewChatPage transport={transport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		await screen.findByRole("heading", { name: "Remembered Session" });
		transport.retire();
		await expect(
			act(async () => {
				await transport.emitInvalidation({
					sessionId: rememberedSessionId,
					reason: "session_retired",
				});
			}),
		).rejects.toThrow("retained Session retirement limit");
		const retained = JSON.parse(sessionStorage.getItem(retirementStorageKey) ?? "[]") as Array<{
			sessionId: string;
		}>;
		expect(retained).toHaveLength(maxRetainedSessionRetirements);
		expect(retained.some((entry) => entry.sessionId === rememberedSessionId)).toBe(false);
		rendered.unmount();
	});

	test("lets renderer retirement snapshots age out at the shared TTL", async () => {
		sessionStorage.setItem(
			retirementStorageKey,
			JSON.stringify([
				{
					sessionId: rememberedSessionId,
					retiredAtMs: Date.now() - retiredSessionTombstoneTtlMs - 1,
				},
			]),
		);
		const expiredSnapshot = createSessionForId(rememberedSessionId, "Expired tombstone snapshot");
		const expiredTransport = new DelayedRouteTransport(
			createSessionForId(nextSessionId, "Other Session"),
			new Promise<ChatSession>(() => {}),
		);
		render(
			<I18nProvider>
				<MemoryRouter
					initialEntries={[
						{
							pathname: `/chat/${rememberedSessionId}`,
							state: { hydratedSession: expiredSnapshot },
						},
					]}
				>
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={expiredTransport as unknown as ChatTransport} />}
						/>
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		expect(
			await screen.findByRole("heading", { name: "Expired tombstone snapshot" }),
		).toBeVisible();
	});
});

describe("ChatSessionPage hydration generations", () => {
	test.each(["success", "not-found"] as const)(
		"ignores delayed %s from the previous route under StrictMode",
		async (outcome) => {
			let resolvePrevious: ((session: ChatSession) => void) | undefined;
			let rejectPrevious: ((error: unknown) => void) | undefined;
			const previous = new Promise<ChatSession>((resolve, reject) => {
				resolvePrevious = resolve;
				rejectPrevious = reject;
			});
			const nextSession = createSessionForId(nextSessionId, "Current Session B");
			const transport = new DelayedRouteTransport(nextSession, previous);
			localStorage.setItem(storageKey, rememberedSessionId);
			render(
				<StrictMode>
					<I18nProvider>
						<MemoryRouter initialEntries={[`/chat/${rememberedSessionId}`]}>
							<LocationProbe />
							<SwitchSessionButton sessionId={nextSessionId} />
							<Routes>
								<Route
									path="/chat/:sessionId"
									element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
								/>
								<Route
									path="/chat/new"
									element={<NewChatPage transport={transport as unknown as ChatTransport} />}
								/>
							</Routes>
						</MemoryRouter>
					</I18nProvider>
				</StrictMode>,
			);
			await waitFor(() =>
				expect(
					transport.getSessionCalls.filter((sessionId) => sessionId === rememberedSessionId).length,
				).toBeGreaterThan(0),
			);
			fireEvent.click(screen.getByRole("button", { name: "Switch Session" }));
			expect(await screen.findByRole("heading", { name: "Current Session B" })).toBeVisible();
			expect(localStorage.getItem(storageKey)).toBe(nextSessionId);

			await act(async () => {
				if (outcome === "success") {
					resolvePrevious?.(createSessionForId(rememberedSessionId, "Late Session A"));
				} else {
					rejectPrevious?.(new ChatSessionNotFoundError());
				}
				await Promise.resolve();
			});

			expect(screen.getByTestId("location")).toHaveTextContent(`/chat/${nextSessionId}`);
			expect(screen.getByRole("heading", { name: "Current Session B" })).toBeVisible();
			expect(screen.queryByText("Late Session A")).not.toBeInTheDocument();
			expect(localStorage.getItem(storageKey)).toBe(nextSessionId);
		},
	);

	test("does not mutate remembered state or navigate after unmounting a delayed hydration", async () => {
		let resolvePrevious: ((session: ChatSession) => void) | undefined;
		const previous = new Promise<ChatSession>((resolve) => {
			resolvePrevious = resolve;
		});
		const transport = new DelayedRouteTransport(
			createSessionForId(nextSessionId, "Unused Session"),
			previous,
		);
		localStorage.setItem(storageKey, nextSessionId);
		render(
			<I18nProvider>
				<MemoryRouter initialEntries={[`/chat/${rememberedSessionId}`]}>
					<LocationProbe />
					<LeaveButton />
					<Routes>
						<Route
							path="/chat/:sessionId"
							element={<ChatSessionPage transport={transport as unknown as ChatTransport} />}
						/>
						<Route path="/other" element={<div>Outside chat</div>} />
					</Routes>
				</MemoryRouter>
			</I18nProvider>,
		);
		await waitFor(() => expect(transport.getSessionCalls).toContain(rememberedSessionId));
		fireEvent.click(screen.getByRole("button", { name: "Leave chat" }));
		expect(await screen.findByText("Outside chat")).toBeVisible();

		await act(async () => {
			resolvePrevious?.(createSessionForId(rememberedSessionId, "Late unmounted Session"));
			await Promise.resolve();
		});
		expect(screen.getByTestId("location")).toHaveTextContent("/other");
		expect(localStorage.getItem(storageKey)).toBe(nextSessionId);
	});
});

class InitialHydrationTransport {
	readonly getSessionCalls: string[] = [];
	readonly #readyListeners = new Set<() => void>();

	constructor(private readonly outcomes: Array<ChatSession | Error>) {}

	get readyListenerCount(): number {
		return this.#readyListeners.size;
	}

	async getSession(sessionId: string): Promise<ChatSession> {
		this.getSessionCalls.push(sessionId);
		const outcome = this.outcomes.shift();
		if (outcome instanceof Error) {
			throw outcome;
		}
		return outcome ?? createSession();
	}

	subscribeAgentsReady(listener: () => void): () => void {
		this.#readyListeners.add(listener);
		return () => {
			this.#readyListeners.delete(listener);
		};
	}

	emitReady(): void {
		for (const listener of [...this.#readyListeners]) {
			listener();
		}
	}
}

class SessionRouteTransport {
	readonly getSessionCalls: string[] = [];
	readonly #listeners = new Set<ChatTransportListener>();
	readonly #invalidationListeners = new Set<ChatSessionInvalidationListener>();
	#session: ChatSession | undefined;

	constructor(session: ChatSession) {
		this.#session = session;
	}

	async listAvailableModels() {
		return { models: [testAvailableModel], defaultModel: testDefaultModel };
	}

	async getSession(sessionId: string): Promise<ChatSession> {
		this.getSessionCalls.push(sessionId);
		if (this.#session === undefined || this.#session.id !== sessionId) {
			throw new ChatSessionNotFoundError();
		}
		return {
			...this.#session,
			messages: this.#session.messages.map((message) => ({ ...message })),
		};
	}

	async listSessions() {
		if (this.#session === undefined) {
			return [];
		}
		return [
			{
				id: this.#session.id,
				title: this.#session.title,
				createdAt: this.#session.updatedAt,
				updatedAt: this.#session.updatedAt,
			},
		];
	}

	subscribe(listener: ChatTransportListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	subscribeSessionInvalidations(listener: ChatSessionInvalidationListener): () => void {
		this.#invalidationListeners.add(listener);
		return () => {
			this.#invalidationListeners.delete(listener);
		};
	}

	retire(): void {
		this.#session = undefined;
	}

	async emitInvalidation(invalidation: ChatSessionInvalidation): Promise<void> {
		for (const listener of [...this.#invalidationListeners]) {
			await listener(invalidation);
		}
	}
}

class DelayedRouteTransport extends SessionRouteTransport {
	constructor(
		session: ChatSession,
		private readonly delayedSession: Promise<ChatSession>,
	) {
		super(session);
	}

	override async getSession(sessionId: string): Promise<ChatSession> {
		if (sessionId === rememberedSessionId) {
			this.getSessionCalls.push(sessionId);
			return this.delayedSession;
		}
		return super.getSession(sessionId);
	}
}

function renderHome(transport: InitialHydrationTransport, retryDelayMs = 0) {
	return render(
		<MemoryRouter initialEntries={["/chat"]}>
			<LocationProbe />
			<LeaveButton />
			<Routes>
				<Route
					path="/chat"
					element={
						<ChatHomePage
							transport={transport as unknown as ChatTransport}
							retryDelayMs={retryDelayMs}
							maxAttempts={3}
						/>
					}
				/>
				<Route path="*" element={null} />
			</Routes>
		</MemoryRouter>,
	);
}

function LocationProbe() {
	const location = useLocation();
	const state = location.state as { hydratedSession?: ChatSession } | null;
	return (
		<output data-testid="location">
			{location.pathname}|{state?.hydratedSession?.title}
		</output>
	);
}

function LeaveButton() {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate("/other")}>
			Leave chat
		</button>
	);
}

function SwitchSessionButton({ sessionId }: { sessionId: string }) {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate(`/chat/${sessionId}`)}>
			Switch Session
		</button>
	);
}

function HistoryBackButton() {
	const navigate = useNavigate();
	return (
		<button type="button" onClick={() => navigate(-1)}>
			Back
		</button>
	);
}

function createSession(): ChatSession {
	return createSessionForId(rememberedSessionId, "Remembered Session");
}

function createSessionForId(id: string, title: string): ChatSession {
	return {
		id,
		title,
		updatedAt: "2026-07-26T00:00:00.000Z",
		model: modelSelectionFor("gpt-5.4"),
		askMode: "Ask",
		messages: [],
	};
}
