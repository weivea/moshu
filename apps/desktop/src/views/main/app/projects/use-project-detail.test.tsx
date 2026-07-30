import { defaultLocalRuntimeBoxId, type Project } from "@moshu/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectDataProvider } from "./project-data";
import { useProjectDetail } from "./use-project-detail";

const rpc = vi.hoisted(() => ({
	getProject: vi.fn(),
	checkProjectPath: vi.fn(),
}));
const projectA = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5ca";
const projectB = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cb";
const projectC = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cc";

vi.mock("../../lib/rpc", () => ({ desktopClient: rpc }));

beforeEach(() => {
	vi.clearAllMocks();
	rpc.getProject.mockImplementation((projectId: string) =>
		Promise.resolve({
			project: createProject(
				projectId,
				projectId === projectA ? "Project A" : projectId === projectB ? "Project B" : "Project C",
			),
			sessionCounts: { active: 0, archived: 0, total: 0 },
		}),
	);
});

describe("useProjectDetail", () => {
	test("resets Project-scoped path state and ignores late checks when automatic checking is disabled", async () => {
		const lateCheck = createDeferred<{ project: Project }>();
		rpc.checkProjectPath
			.mockResolvedValueOnce({ project: createProject(projectA, "Checked A") })
			.mockRejectedValueOnce(new Error("A path check failed"))
			.mockImplementationOnce(() => lateCheck.promise);
		const rendered = render(
			<ProjectDataProvider>
				<Harness projectId={projectA} checkPath />
			</ProjectDataProvider>,
		);
		expect(await screen.findByText("Checked A")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Check path" }));
		expect(await screen.findByText("A path check failed")).toBeVisible();

		rendered.rerender(
			<ProjectDataProvider>
				<Harness projectId={projectB} checkPath={false} />
			</ProjectDataProvider>,
		);
		expect(await screen.findByText("Project B")).toBeVisible();
		expect(screen.queryByText("Checked A")).not.toBeInTheDocument();
		expect(screen.queryByText("A path check failed")).not.toBeInTheDocument();
		expect(screen.getByTestId("checking")).toHaveTextContent("idle");

		fireEvent.click(screen.getByRole("button", { name: "Check path" }));
		expect(screen.getByTestId("checking")).toHaveTextContent("checking");
		rendered.rerender(
			<ProjectDataProvider>
				<Harness projectId={projectC} checkPath={false} />
			</ProjectDataProvider>,
		);
		expect(await screen.findByText("Project C")).toBeVisible();
		expect(screen.getByTestId("checking")).toHaveTextContent("idle");
		lateCheck.resolve({ project: createProject(projectB, "Late B") });
		await Promise.resolve();
		expect(screen.queryByText("Late B")).not.toBeInTheDocument();
		expect(screen.getByText("Project C")).toBeVisible();
	});
});

function Harness({ projectId, checkPath }: { projectId: string; checkPath: boolean }) {
	const detail = useProjectDetail(projectId, checkPath);
	return (
		<div>
			<span>{detail.project?.name}</span>
			<span>{detail.healthError?.message}</span>
			<output data-testid="checking">{detail.isCheckingPath ? "checking" : "idle"}</output>
			<button type="button" onClick={() => void detail.refreshPath()}>
				Check path
			</button>
		</div>
	);
}

function createProject(id: string, name: string): Project {
	return {
		schemaVersion: 1,
		id,
		runtimeBoxId: defaultLocalRuntimeBoxId,
		name,
		path: `/workspace/${name.toLocaleLowerCase().replaceAll(" ", "-")}`,
		pathRevision: 1,
		pathStatus: "available",
		createdAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
	};
}

function createDeferred<T>() {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
