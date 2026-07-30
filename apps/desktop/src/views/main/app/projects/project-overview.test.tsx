import { defaultLocalRuntimeBoxId, type Project } from "@moshu/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatTransport } from "../chat/transport";
import { I18nProvider } from "../i18n";
import { ProjectDataProvider } from "./project-data";
import { ProjectOverviewPage } from "./project-overview";

const projectId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const project: Project = {
	schemaVersion: 1,
	id: projectId,
	runtimeBoxId: defaultLocalRuntimeBoxId,
	name: "Overview Project",
	path: "/workspace/overview",
	pathRevision: 1,
	pathStatus: "available",
	createdAt: "2026-07-28T00:00:00.000Z",
	updatedAt: "2026-07-28T00:00:00.000Z",
};
const rpc = vi.hoisted(() => ({
	getProject: vi.fn(),
	checkProjectPath: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ desktopClient: rpc }));

beforeEach(() => {
	vi.clearAllMocks();
	rpc.getProject.mockResolvedValue({
		project,
		sessionCounts: { active: 1, archived: 0, total: 1 },
	});
	rpc.checkProjectPath.mockResolvedValue({ project });
});

describe("ProjectOverviewPage", () => {
	test("scopes search and Session metadata actions to the Project", async () => {
		const listSessions = vi.fn().mockResolvedValue([
			{
				id: "session-a",
				runtimeBoxId: defaultLocalRuntimeBoxId,
				projectId,
				title: "Project Session",
				createdAt: "2026-07-29T00:00:00.000Z",
				updatedAt: "2026-07-29T00:00:00.000Z",
			},
		]);
		const setSessionArchived = vi.fn().mockResolvedValue({
			id: "session-a",
			runtimeBoxId: defaultLocalRuntimeBoxId,
			projectId,
			title: "Project Session",
			createdAt: "2026-07-29T00:00:00.000Z",
			updatedAt: "2026-07-29T00:00:00.000Z",
			archivedAt: "2026-07-30T00:00:00.000Z",
		});
		const transport = {
			listSessions,
			setSessionArchived,
			renameSession: vi.fn(),
			deleteSession: vi.fn(),
			subscribe: () => () => undefined,
		} as unknown as ChatTransport;
		render(
			<I18nProvider>
				<ProjectDataProvider>
					<MemoryRouter initialEntries={[`/projects/${projectId}`]}>
						<Routes>
							<Route
								path="/projects/:projectId"
								element={<ProjectOverviewPage transport={transport} />}
							/>
						</Routes>
					</MemoryRouter>
				</ProjectDataProvider>
			</I18nProvider>,
		);
		await screen.findByText("Project Session");
		expect(listSessions).toHaveBeenCalledWith({
			archived: false,
			scope: { kind: "project", projectId },
		});

		fireEvent.click(screen.getByRole("button", { name: "Filter chats" }));
		fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "Project" } });
		await waitFor(() =>
			expect(listSessions).toHaveBeenLastCalledWith({
				query: "Project",
				archived: false,
				scope: { kind: "project", projectId },
			}),
		);

		const item = screen.getByText("Project Session").closest("li");
		if (item === null) {
			throw new Error("Session row was not rendered.");
		}
		fireEvent.click(within(item).getByLabelText("Chat actions"));
		fireEvent.click(within(item).getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(setSessionArchived).toHaveBeenCalledWith("session-a", true));
		await waitFor(() => expect(rpc.getProject.mock.calls.length).toBeGreaterThanOrEqual(2));
		fireEvent.click(screen.getByRole("button", { name: "Archived" }));
		await waitFor(() =>
			expect(listSessions).toHaveBeenLastCalledWith({
				query: "Project",
				archived: true,
				scope: { kind: "project", projectId },
			}),
		);
	});
});
