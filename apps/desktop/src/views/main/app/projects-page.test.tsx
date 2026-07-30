import {
	defaultLocalRuntimeBoxId,
	type Project,
	type ProjectPathPreview,
	type RuntimeBoxConnectionInfo,
} from "@moshu/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { projectPreviewStaleMessagePrefix } from "../../../shared/rpc-errors";
import { I18nProvider } from "./i18n";
import { ProjectAdd } from "./projects/project-add";
import { ProjectsPage } from "./projects-page";

const projectId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ce";
const project: Project = {
	schemaVersion: 1,
	id: projectId,
	runtimeBoxId: defaultLocalRuntimeBoxId,
	name: "Moshu",
	path: "/workspace/moshu",
	pathRevision: 1,
	pathStatus: "available",
	gitRootPath: "/workspace/moshu",
	gitBranch: "main",
	createdAt: "2026-07-28T00:00:00.000Z",
	updatedAt: "2026-07-28T00:00:00.000Z",
};
const preview: ProjectPathPreview = {
	schemaVersion: 1,
	runtimeBoxId: defaultLocalRuntimeBoxId,
	runtimeBoxDisplayName: "Local Runtime Box",
	runtimeBoxPlatform: "darwin",
	inputPath: "/workspace/new-project",
	normalizedPath: "/workspace/new-project",
	displayName: "new-project",
	gitRootPath: "/workspace/new-project",
	gitBranch: "main",
	rootAgents: { status: "missing" },
	confirmationToken: "a".repeat(64),
};

const rpc = vi.hoisted(() => ({
	listProjects: vi.fn(),
	pickProjectDirectory: vi.fn(),
	previewProjectPath: vi.fn(),
	confirmCreateProject: vi.fn(),
	setProjectArchived: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({ desktopClient: rpc }));

beforeEach(() => {
	vi.clearAllMocks();
	rpc.listProjects.mockResolvedValue({ items: [project] });
	rpc.pickProjectDirectory.mockResolvedValue({
		cancelled: false,
		path: "/workspace/new-project",
	});
	rpc.previewProjectPath.mockResolvedValue({ preview });
	rpc.confirmCreateProject.mockResolvedValue({ project });
});

describe("ProjectsPage", () => {
	test("uses the native picker, previews, and explicitly confirms a local Project", async () => {
		renderProjects();
		expect(await screen.findByText("Moshu")).toBeVisible();

		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
		expect(await screen.findByRole("heading", { name: "Review Project access" })).toBeVisible();
		expect(screen.getAllByText("/workspace/new-project", { selector: "code" })).toHaveLength(2);
		fireEvent.change(screen.getByLabelText("Display name (optional)"), {
			target: { value: "New project" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Confirm and create" }));

		await waitFor(() =>
			expect(rpc.confirmCreateProject).toHaveBeenCalledWith({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				path: "/workspace/new-project",
				name: "New project",
				confirmationToken: "a".repeat(64),
			}),
		);
	});

	test("treats native picker cancellation as a non-error", async () => {
		rpc.pickProjectDirectory.mockResolvedValue({ cancelled: true });
		renderProjects();
		await screen.findByText("Moshu");
		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
		await waitFor(() => expect(rpc.pickProjectDirectory).toHaveBeenCalledOnce());
		expect(rpc.previewProjectPath).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	test("accepts a remote absolute path before preview", async () => {
		const remote = {
			...localRuntimeBox,
			runtimeBox: {
				...localRuntimeBox.runtimeBox,
				runtimeBoxId: "remote-box",
				kind: "remote" as const,
				displayName: "Build host",
				platform: "linux" as const,
			},
		};
		render(
			<I18nProvider>
				<ProjectAdd runtimeBox={remote} isRuntimeReady onCreated={() => undefined} />
			</I18nProvider>,
		);
		fireEvent.change(screen.getByLabelText("Absolute path on Runtime Box"), {
			target: { value: "/srv/repository" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		await waitFor(() =>
			expect(rpc.previewProjectPath).toHaveBeenCalledWith({
				runtimeBoxId: "remote-box",
				path: "/srv/repository",
			}),
		);
	});

	test("refreshes a stale preview and requires confirmation again", async () => {
		const staleError = new Error(
			`${projectPreviewStaleMessagePrefix}The Project path preview is stale.`,
		);
		rpc.confirmCreateProject.mockRejectedValueOnce(staleError);
		renderProjects();
		await screen.findByText("Moshu");
		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }));
		await screen.findByRole("heading", { name: "Review Project access" });
		fireEvent.click(screen.getByRole("button", { name: "Confirm and create" }));
		await waitFor(() => expect(rpc.previewProjectPath).toHaveBeenCalledTimes(2));
		expect(rpc.confirmCreateProject).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("heading", { name: "Review Project access" })).toBeVisible();
		expect(screen.getByText(/directory changed since preview/i)).toBeVisible();
	});

	test("discards a pending remote preview when the path changes", async () => {
		const remote = {
			...localRuntimeBox,
			runtimeBox: {
				...localRuntimeBox.runtimeBox,
				runtimeBoxId: "remote-box",
				kind: "remote" as const,
				displayName: "Build host",
				platform: "linux" as const,
			},
		};
		const pendingPreview = Promise.withResolvers<{ preview: ProjectPathPreview }>();
		rpc.previewProjectPath.mockImplementationOnce(() => pendingPreview.promise);
		render(
			<I18nProvider>
				<ProjectAdd runtimeBox={remote} isRuntimeReady onCreated={() => undefined} />
			</I18nProvider>,
		);
		const pathInput = screen.getByLabelText("Absolute path on Runtime Box");
		fireEvent.change(pathInput, { target: { value: "/srv/old" } });
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		fireEvent.change(pathInput, { target: { value: "/srv/new" } });
		pendingPreview.resolve({ preview: { ...preview, inputPath: "/srv/old" } });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(pathInput).toHaveValue("/srv/new");
		expect(
			screen.queryByRole("heading", { name: "Review Project access" }),
		).not.toBeInTheDocument();
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
		renderProjects();
		fireEvent.click(screen.getByRole("button", { name: "Archived" }));
		expect(await screen.findByText("Archived")).toBeVisible();
		activeRequest.resolve({ items: [project] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.queryByText("Moshu")).not.toBeInTheDocument();
	});
});

const localRuntimeBox: RuntimeBoxConnectionInfo = {
	runtimeBox: {
		schemaVersion: 1,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		kind: "local",
		displayName: "Local Runtime Box",
		runtimeBoxVersion: "test",
		platform: "darwin",
		arch: "arm64",
		capabilities: [],
	},
	connected: true,
	registered: true,
	deviceKeyIds: [],
	state: "online",
	compatibility: "compatible",
	negotiatedProtocolVersion: 1,
	transportSecurity: "relay-tls",
};

function renderProjects() {
	return render(
		<I18nProvider>
			<MemoryRouter>
				<ProjectsPage />
			</MemoryRouter>
		</I18nProvider>,
	);
}
