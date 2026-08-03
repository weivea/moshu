import {
	defaultLocalRuntimeBoxId,
	type ProjectSidebarSummary,
	type SessionModelSelection,
} from "@moshu/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { testAvailableModel, testDefaultModel } from "../chat/test-transport-defaults";
import type {
	ChatSendResult,
	ChatSession,
	ChatSessionInvalidationListener,
	ChatSessionSummary,
	ChatTransport,
} from "../chat/transport";
import { I18nProvider } from "../i18n";
import { ProjectNewChatPage } from "../pages";
import { ProjectDataProvider } from "./project-data";
import { ProjectOverviewPage } from "./project-overview";
import { ProjectsSidebar } from "./projects-sidebar";

const rpc = vi.hoisted(() => ({
	getProjectSidebar: vi.fn(),
	getProject: vi.fn(),
	checkProjectPath: vi.fn(),
	setProjectArchived: vi.fn(),
	getProjectDeleteConfirmation: vi.fn(),
	requestProjectDeletion: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ desktopClient: rpc }));

const projectId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const summary: ProjectSidebarSummary = {
	project: {
		schemaVersion: 1,
		id: projectId,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		name: "Sidebar Project",
		path: "/workspace/sidebar",
		pathRevision: 1,
		pathStatus: "available",
		createdAt: "2026-07-29T00:00:00.000Z",
		updatedAt: "2026-07-29T00:00:00.000Z",
	},
	activeSessionCount: 10,
	recentSessions: Array.from({ length: 8 }, (_, index) => ({
		id: `01984df0-cf17-7e6e-9a7d-4d98c1f0d5${String(10 + index).padStart(2, "0")}`,
		title: `Session ${index + 1}`,
		updatedAt: `2026-07-${String(29 - index).padStart(2, "0")}T00:00:00.000Z`,
	})),
};

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	rpc.getProjectSidebar.mockResolvedValue({ items: [summary] });
	rpc.getProject.mockResolvedValue({
		project: summary.project,
		sessionCounts: { active: 0, archived: 0, total: 0 },
	});
	rpc.checkProjectPath.mockResolvedValue({ project: summary.project });
	rpc.setProjectArchived.mockResolvedValue({
		project: { ...summary.project, archivedAt: "2026-07-30T00:00:00.000Z" },
	});
});

describe("ProjectsSidebar", () => {
	test("shows eight recent Sessions, persists expansion, and navigates Project name to latest", async () => {
		const first = renderSidebar();
		await screen.findByText("Sidebar Project");
		fireEvent.click(screen.getByRole("button", { name: "Expand Sidebar Project" }));
		expect(screen.getAllByText(/^Session \d$/)).toHaveLength(8);
		expect(screen.getByText("View all (10)")).toBeVisible();
		expect(
			localStorage.getItem(`moshu.projects.expanded.v1.${defaultLocalRuntimeBoxId}`),
		).toContain(projectId);

		fireEvent.click(screen.getByRole("button", { name: "Sidebar Project" }));
		expect(screen.getByTestId("location")).toHaveTextContent(
			`/projects/${projectId}/chat/${summary.recentSessions[0]?.id}`,
		);
		first.unmount();

		renderSidebar();
		await screen.findByText("Session 1");
	});

	test("offers edit and archive actions without requiring Runtime readiness", async () => {
		renderSidebar();
		await screen.findByText("Sidebar Project");
		fireEvent.click(screen.getByLabelText("Actions for Sidebar Project"));
		expect(screen.getByRole("menu")).toBeVisible();
		const menu = screen.getByText("Edit Project").closest<HTMLElement>(".project-menu__popover");
		if (menu === null) {
			throw new Error("Project menu was not rendered.");
		}
		expect(within(menu).getByRole("menuitem", { name: "Edit Project" })).toHaveAttribute(
			"href",
			`/projects/${projectId}/settings`,
		);
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));
		await waitFor(() =>
			expect(rpc.setProjectArchived).toHaveBeenCalledWith({
				projectId,
				archived: true,
			}),
		);
	});

	test("opens a new chat for an active Project without Sessions and overview for archived data", async () => {
		rpc.getProjectSidebar.mockResolvedValueOnce({
			items: [{ ...summary, activeSessionCount: 0, recentSessions: [] }],
		});
		const active = renderSidebar();
		fireEvent.click(await screen.findByRole("button", { name: "Sidebar Project" }));
		expect(screen.getByTestId("location")).toHaveTextContent(`/projects/${projectId}/chat/new`);
		active.unmount();

		rpc.getProjectSidebar.mockResolvedValueOnce({
			items: [
				{
					...summary,
					project: { ...summary.project, archivedAt: "2026-07-30T00:00:00.000Z" },
					activeSessionCount: 0,
					recentSessions: [],
				},
			],
		});
		renderSidebar();
		fireEvent.click(await screen.findByRole("button", { name: "Sidebar Project" }));
		expect(screen.getByTestId("location")).toHaveTextContent(`/projects/${projectId}`);
	});

	test("reloads the aggregate summary after retirement so latest navigation and count are current", async () => {
		let deliverInvalidation: ChatSessionInvalidationListener | undefined;
		const transport = {
			retireSession: vi.fn(),
			subscribe: () => () => undefined,
			subscribeSessionInvalidations(listener: ChatSessionInvalidationListener) {
				deliverInvalidation = listener;
				return () => {
					deliverInvalidation = undefined;
				};
			},
		} as unknown as ChatTransport;
		const latestSessionId = summary.recentSessions[0]?.id;
		const replacementSessionId = summary.recentSessions[1]?.id;
		if (latestSessionId === undefined || replacementSessionId === undefined) {
			throw new Error("Sidebar fixture is missing recent Sessions.");
		}
		renderSidebar(transport);
		await screen.findByText("Sidebar Project");
		fireEvent.click(screen.getByRole("button", { name: "Expand Sidebar Project" }));
		expect(screen.getByText("View all (10)")).toBeVisible();
		rpc.getProjectSidebar.mockResolvedValue({
			items: [
				{
					...summary,
					activeSessionCount: 9,
					recentSessions: summary.recentSessions.slice(1),
				},
			],
		});
		if (deliverInvalidation === undefined) {
			throw new Error("Projects sidebar did not subscribe to Session invalidations.");
		}

		await act(async () => {
			await deliverInvalidation?.({
				sessionId: latestSessionId,
				reason: "session_retired",
			});
		});

		expect(await screen.findByText("View all (9)")).toBeVisible();
		expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sidebar Project" }));
		expect(screen.getByTestId("location")).toHaveTextContent(
			`/projects/${projectId}/chat/${replacementSessionId}`,
		);
		expect(rpc.getProjectSidebar).toHaveBeenCalledTimes(2);
	});

	test("reloads a cached zero-session summary when a Project Session is created", async () => {
		let sidebarSessions: ProjectSidebarSummary["recentSessions"] = [];
		rpc.getProjectSidebar.mockImplementation(() =>
			Promise.resolve({
				items: [
					{
						...summary,
						activeSessionCount: sidebarSessions.length,
						recentSessions: sidebarSessions,
					},
				],
			}),
		);
		localStorage.setItem(
			`moshu.projects.expanded.v1.${defaultLocalRuntimeBoxId}`,
			JSON.stringify([projectId]),
		);
		const transport = createProjectTransport((session) => {
			sidebarSessions = [{ id: session.id, title: session.title, updatedAt: session.updatedAt }];
		});

		renderProjectRoutes(
			transport,
			`/projects/${projectId}/chat/new`,
			<ProjectNewChatPage transport={transport} />,
		);
		const sidebar = (await screen.findByRole("heading", { name: "Projects" })).closest("section");
		if (sidebar === null) {
			throw new Error("Projects sidebar was not rendered.");
		}
		expect(within(sidebar).getByText("No chats yet.")).toBeVisible();
		expect(screen.getByText("View all (0)")).toBeVisible();

		const prompt = await screen.findByLabelText("Prompt");
		await waitFor(() => expect(prompt).toBeEnabled());
		fireEvent.change(prompt, { target: { value: "Created from Project" } });
		fireEvent.keyDown(prompt, { key: "Enter" });

		expect(await screen.findByText("View all (1)")).toBeVisible();
		expect(screen.getAllByText("Created from Project")).not.toHaveLength(0);
		await waitFor(() =>
			expect(screen.getByTestId("location")).toHaveTextContent(
				`/projects/${projectId}/chat/project-session-1`,
			),
		);
		expect(rpc.getProjectSidebar).toHaveBeenCalledTimes(2);
	});

	test("reconciles a cached zero-session summary when Project overview opens", async () => {
		const sessions = Array.from({ length: 3 }, (_, index) =>
			createSessionSummary(`overview-session-${index + 1}`, `Overview Session ${index + 1}`),
		);
		let sidebarSessions: ProjectSidebarSummary["recentSessions"] = [];
		rpc.getProjectSidebar.mockImplementation(() =>
			Promise.resolve({
				items: [
					{
						...summary,
						activeSessionCount: sidebarSessions.length,
						recentSessions: sidebarSessions,
					},
				],
			}),
		);
		rpc.getProject.mockResolvedValue({
			project: summary.project,
			sessionCounts: { active: 3, archived: 0, total: 3 },
		});
		localStorage.setItem(
			`moshu.projects.expanded.v1.${defaultLocalRuntimeBoxId}`,
			JSON.stringify([projectId]),
		);
		const transport = createProjectTransport(undefined, sessions);

		renderProjectRoutes(
			transport,
			"/before-overview",
			<Link to={`/projects/${projectId}`}>Open Project overview</Link>,
			<ProjectOverviewPage transport={transport} />,
		);
		expect(await screen.findByText("View all (0)")).toBeVisible();

		sidebarSessions = sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
		fireEvent.click(screen.getByRole("link", { name: "Open Project overview" }));

		expect(await screen.findByText("View all (3)")).toBeVisible();
		expect(screen.getAllByText("Overview Session 1")).not.toHaveLength(0);
		expect(rpc.getProjectSidebar).toHaveBeenCalledTimes(2);
	});
});

function renderSidebar(transport?: ChatTransport) {
	return render(
		<I18nProvider>
			<ProjectDataProvider>
				<MemoryRouter>
					<ProjectsSidebar
						refreshKey="test"
						onAdd={() => undefined}
						{...(transport === undefined ? {} : { transport })}
					/>
					<Location />
				</MemoryRouter>
			</ProjectDataProvider>
		</I18nProvider>,
	);
}

function Location() {
	const location = useLocation();
	return <output data-testid="location">{location.pathname}</output>;
}

function renderProjectRoutes(
	transport: ChatTransport,
	initialEntry: string,
	initialElement: ReactNode,
	projectOverviewElement?: ReactNode,
) {
	return render(
		<I18nProvider>
			<ProjectDataProvider>
				<MemoryRouter initialEntries={[initialEntry]}>
					<ProjectsSidebar refreshKey="test" onAdd={() => undefined} transport={transport} />
					<Location />
					<Routes>
						<Route
							path={
								initialEntry.endsWith("/chat/new") ? "/projects/:projectId/chat/new" : initialEntry
							}
							element={initialElement}
						/>
						<Route
							path="/projects/:projectId/chat/:sessionId"
							element={<div>Created Project Session route</div>}
						/>
						{projectOverviewElement === undefined ? null : (
							<Route path="/projects/:projectId" element={projectOverviewElement} />
						)}
					</Routes>
				</MemoryRouter>
			</ProjectDataProvider>
		</I18nProvider>,
	);
}

function createProjectTransport(
	onCreated?: (session: ChatSession) => void,
	initialSessions: ChatSessionSummary[] = [],
): ChatTransport {
	const sessions = [...initialSessions];
	return {
		listAvailableModels: async () => ({
			models: [testAvailableModel],
			defaultModel: testDefaultModel,
		}),
		listSessions: async () => sessions,
		createSession: async (_model: SessionModelSelection | undefined, owningProjectId?: string) => {
			const session: ChatSession = {
				id: "project-session-1",
				runtimeBoxId: defaultLocalRuntimeBoxId,
				projectId: owningProjectId,
				title: "Created from Project",
				updatedAt: "2026-07-30T12:00:00.000Z",
				askMode: "Ask",
				runs: [],
			};
			sessions.push(createSessionSummary(session.id, session.title));
			onCreated?.(session);
			return session;
		},
		send: async ({
			requestId,
			message,
		}: {
			requestId: string;
			sessionId: string;
			message: string;
		}): Promise<ChatSendResult> => ({
			requestId,
			run: {
				schemaVersion: 1,
				id: requestId,
				sessionId: "project-session-1",
				runtimeBoxId: defaultLocalRuntimeBoxId,
				mode: "agent",
				status: "completed",
				provider: {
					schemaVersion: 1,
					providerId: "test-provider",
					name: "Test Provider",
					source: "builtin",
					api: "openai-responses",
					model: "gpt-5.4",
					status: "ready",
				},
				userMessageId: "user-message-1",
				createdAt: "2026-07-30T12:00:00.000Z",
				updatedAt: "2026-07-30T12:00:00.000Z",
				completedAt: "2026-07-30T12:00:00.000Z",
				userMessage: {
					schemaVersion: 1,
					id: "user-message-1",
					sessionId: "project-session-1",
					runId: requestId,
					role: "user",
					content: message,
					createdAt: "2026-07-30T12:00:00.000Z",
				},
				timeline: [],
				lastEventSeq: 1,
			},
		}),
		subscribe: () => () => undefined,
		subscribeSessionInvalidations: () => () => undefined,
	} as unknown as ChatTransport;
}

function createSessionSummary(id: string, title: string): ChatSessionSummary {
	return {
		id,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		projectId,
		title,
		createdAt: "2026-07-30T12:00:00.000Z",
		updatedAt: "2026-07-30T12:00:00.000Z",
	};
}
