import { defaultLocalRuntimeBoxId, type Project } from "@moshu/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { projectPreviewStaleMessagePrefix } from "../../../../shared/rpc-errors";
import { I18nProvider } from "../i18n";
import { ProjectDataProvider } from "./project-data";
import { ProjectSettingsPage } from "./project-settings";

const projectId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const project: Project = {
	schemaVersion: 1,
	id: projectId,
	runtimeBoxId: defaultLocalRuntimeBoxId,
	name: "Settings Project",
	path: "/workspace/settings",
	pathRevision: 2,
	pathStatus: "available",
	createdAt: "2026-07-28T00:00:00.000Z",
	updatedAt: "2026-07-28T00:00:00.000Z",
};
const rpc = vi.hoisted(() => ({
	getProject: vi.fn(),
	updateProject: vi.fn(),
	checkProjectPath: vi.fn(),
	pickProjectDirectory: vi.fn(),
	previewProjectRelink: vi.fn(),
	relinkProject: vi.fn(),
	setProjectArchived: vi.fn(),
	getProjectDeleteConfirmation: vi.fn(),
	requestProjectDeletion: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ desktopClient: rpc }));

beforeEach(() => {
	vi.clearAllMocks();
	rpc.getProject.mockResolvedValue({
		project,
		sessionCounts: { active: 2, archived: 1, total: 3 },
	});
	rpc.updateProject.mockResolvedValue({ project: { ...project, name: "Renamed" } });
	rpc.checkProjectPath.mockResolvedValue({ project });
	rpc.pickProjectDirectory.mockResolvedValue({ cancelled: false, path: "/workspace/relinked" });
	rpc.previewProjectRelink.mockResolvedValue({
		preview: {
			schemaVersion: 1,
			runtimeBoxId: defaultLocalRuntimeBoxId,
			runtimeBoxDisplayName: "Local Runtime Box",
			runtimeBoxPlatform: "darwin",
			inputPath: "/workspace/relinked",
			normalizedPath: "/workspace/relinked",
			displayName: "relinked",
			rootAgents: { status: "missing" },
			confirmationToken: "b".repeat(64),
		},
	});
	rpc.relinkProject.mockResolvedValue({
		project: { ...project, path: "/workspace/relinked", pathRevision: 3 },
	});
	rpc.getProjectDeleteConfirmation.mockResolvedValue({
		confirmation: {
			projectId,
			projectName: project.name,
			sessionCounts: { active: 2, archived: 1, total: 3 },
		},
	});
	rpc.requestProjectDeletion.mockResolvedValue({
		projectId,
		deletionRequestedAt: "2026-07-30T09:00:00.000Z",
	});
});

describe("ProjectSettingsPage", () => {
	test("renames, checks, and relinks through preview and explicit confirmation", async () => {
		renderSettings();
		const name = await screen.findByLabelText("Display name (optional)");
		fireEvent.change(name, { target: { value: "Renamed" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(rpc.updateProject).toHaveBeenCalledWith({ projectId, name: "Renamed" }),
		);

		fireEvent.click(screen.getByRole("button", { name: "Check now" }));
		await waitFor(() => expect(rpc.checkProjectPath).toHaveBeenCalledWith(projectId));

		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
		expect(await screen.findByRole("heading", { name: "Review Project access" })).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Confirm relink" }));
		await waitFor(() =>
			expect(rpc.relinkProject).toHaveBeenCalledWith({
				projectId,
				path: "/workspace/relinked",
				runtimeBoxId: defaultLocalRuntimeBoxId,
				expectedPathRevision: 2,
				confirmationToken: "b".repeat(64),
			}),
		);
	});

	test("requires the current name and shows Session counts before deletion", async () => {
		renderSettings();
		await screen.findByRole("heading", { name: "Project settings" });
		const deleteTriggers = screen.getAllByText("Delete");
		fireEvent.click(deleteTriggers.at(-1) as HTMLElement);
		expect(await screen.findByText("2")).toBeVisible();
		expect(screen.getByText("1")).toBeVisible();
		const typedName = screen.getByLabelText('Type "Settings Project" to confirm');
		const confirm = screen.getByRole("button", { name: "Delete" });
		expect(confirm).toBeDisabled();
		fireEvent.change(typedName, { target: { value: "Settings Project" } });
		expect(confirm).toBeEnabled();
		fireEvent.click(confirm);
		await waitFor(() =>
			expect(rpc.requestProjectDeletion).toHaveBeenCalledWith({
				projectId,
				expectedName: "Settings Project",
			}),
		);
		expect(await screen.findByText(/Deletion started/)).toBeVisible();
		expect(screen.getByText(/files on the host remain/i)).toBeVisible();
	});

	test("refreshes a stale relink preview and requires confirmation again", async () => {
		rpc.relinkProject.mockRejectedValueOnce(
			new Error(`${projectPreviewStaleMessagePrefix}The Project path preview is stale.`),
		);
		renderSettings();
		await screen.findByRole("heading", { name: "Project settings" });
		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
		await screen.findByRole("heading", { name: "Review Project access" });
		fireEvent.click(screen.getByRole("button", { name: "Confirm relink" }));

		await waitFor(() => expect(rpc.previewProjectRelink).toHaveBeenCalledTimes(2));
		expect(rpc.relinkProject).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/directory changed since preview/i)).toBeVisible();
		expect(screen.getByRole("button", { name: "Confirm relink" })).toBeEnabled();
	});

	test("replaces a checked path snapshot when a newer authoritative Project arrives", async () => {
		const checkedProject = {
			...project,
			pathCheckedAt: "2026-07-30T08:00:00.000Z",
		};
		const renamedProject = {
			...checkedProject,
			name: "Authoritative rename",
			path: "/workspace/authoritative",
			pathRevision: 3,
			updatedAt: "2026-07-30T09:00:00.000Z",
		};
		rpc.checkProjectPath.mockResolvedValue({ project: checkedProject });
		rpc.getProject
			.mockResolvedValueOnce({
				project,
				sessionCounts: { active: 2, archived: 1, total: 3 },
			})
			.mockResolvedValueOnce({
				project: { ...project },
				sessionCounts: { active: 2, archived: 1, total: 3 },
			})
			.mockResolvedValue({
				project: renamedProject,
				sessionCounts: { active: 2, archived: 1, total: 3 },
			});
		rpc.updateProject.mockResolvedValue({ project: renamedProject });
		renderSettingsWithProjectData();
		await screen.findByRole("heading", { name: "Project settings" });

		fireEvent.click(screen.getByRole("button", { name: "Check now" }));
		await waitFor(() => expect(rpc.getProject).toHaveBeenCalledTimes(2));
		const name = screen.getByLabelText("Display name (optional)");
		fireEvent.change(name, { target: { value: "Authoritative rename" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				screen.getAllByText("/workspace/authoritative", { selector: "code" }).length,
			).toBeGreaterThan(0),
		);
		expect(rpc.getProject.mock.calls.length).toBeGreaterThanOrEqual(3);
	});
});

function renderSettings() {
	return render(
		<I18nProvider>
			<MemoryRouter initialEntries={[`/projects/${projectId}/settings`]}>
				<Routes>
					<Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
				</Routes>
			</MemoryRouter>
		</I18nProvider>,
	);
}

function renderSettingsWithProjectData() {
	return render(
		<I18nProvider>
			<ProjectDataProvider>
				<MemoryRouter initialEntries={[`/projects/${projectId}/settings`]}>
					<Routes>
						<Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
					</Routes>
				</MemoryRouter>
			</ProjectDataProvider>
		</I18nProvider>,
	);
}
