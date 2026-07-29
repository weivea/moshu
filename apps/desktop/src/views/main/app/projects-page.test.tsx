import { defaultLocalRuntimeBoxId, type Project } from "@moshu/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { ProjectsPage } from "./projects-page";

const projectId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const project: Project = {
	schemaVersion: 1,
	id: projectId,
	runtimeBoxId: defaultLocalRuntimeBoxId,
	name: "Moshu",
	path: "/workspace/moshu",
	gitRootPath: "/workspace/moshu",
	gitBranch: "main",
	createdAt: "2026-07-28T00:00:00.000Z",
	updatedAt: "2026-07-28T00:00:00.000Z",
};

const rpc = vi.hoisted(() => ({
	listProjects: vi.fn(),
	createProject: vi.fn(),
	setProjectArchived: vi.fn(),
	deleteProject: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
	desktopClient: {
		...rpc,
	},
}));

beforeEach(() => {
	vi.clearAllMocks();
	rpc.listProjects.mockResolvedValue({ items: [project] });
	rpc.createProject.mockResolvedValue({ project });
	rpc.setProjectArchived.mockResolvedValue({
		project: { ...project, archivedAt: "2026-07-28T01:00:00.000Z" },
	});
	rpc.deleteProject.mockResolvedValue({ deletedProjectId: projectId });
});

describe("ProjectsPage", () => {
	test("lists active Runtime Projects and validates a new path through the bridge", async () => {
		render(
			<I18nProvider>
				<MemoryRouter>
					<ProjectsPage />
				</MemoryRouter>
			</I18nProvider>,
		);

		expect(await screen.findByText("Moshu")).toBeVisible();
		expect(screen.getByText("/workspace/moshu")).toBeVisible();
		fireEvent.change(screen.getByLabelText("Absolute path on Runtime Box"), {
			target: { value: "/workspace/new-project" },
		});
		fireEvent.change(screen.getByLabelText("Display name (optional)"), {
			target: { value: "New project" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add a project" }));

		await waitFor(() =>
			expect(rpc.createProject).toHaveBeenCalledWith({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				path: "/workspace/new-project",
				name: "New project",
			}),
		);
		expect(rpc.listProjects).toHaveBeenCalledWith({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			archived: false,
		});
	});

	test("discards a stale active-list response after switching to archived Projects", async () => {
		const activeRequest = Promise.withResolvers<{ items: Project[] }>();
		const archivedProject = {
			...project,
			id: "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cf",
			name: "Archived",
			archivedAt: "2026-07-28T01:00:00.000Z",
		};
		rpc.listProjects
			.mockImplementationOnce(() => activeRequest.promise)
			.mockResolvedValueOnce({ items: [archivedProject] });
		render(
			<I18nProvider>
				<MemoryRouter>
					<ProjectsPage />
				</MemoryRouter>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
		expect(await screen.findByText("Archived")).toBeVisible();
		activeRequest.resolve({ items: [project] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.queryByText("Moshu")).not.toBeInTheDocument();
	});
});
