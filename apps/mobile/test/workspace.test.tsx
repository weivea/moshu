import type { ListRuntimeBoxesOutput } from "@moshu/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileEventBus } from "../src/rpc/events";

const hoisted = vi.hoisted(() => ({
	client: undefined as unknown as {
		listRuntimeBoxes: ReturnType<typeof vi.fn>;
		listApprovals: ReturnType<typeof vi.fn>;
		switchRuntimeBox: ReturnType<typeof vi.fn>;
	},
	bus: undefined as unknown as MobileEventBus,
}));

vi.mock("../src/app/connection", () => ({
	useConnectedSession: () => ({ client: hoisted.client, bus: hoisted.bus }),
}));

import { useWorkspace, WorkspaceProvider } from "../src/app/workspace";

function boxes(activeId: string, revision: number): ListRuntimeBoxesOutput {
	return {
		active: { runtimeBoxId: activeId, revision },
		items: [
			{
				runtimeBox: {
					schemaVersion: 1,
					runtimeBoxId: "box-1",
					kind: "local",
					displayName: "Box 1",
					runtimeBoxVersion: "1.0.0",
					platform: "darwin",
					arch: "arm64",
					capabilities: [],
				},
				connected: true,
				registered: true,
				deviceKeyIds: [],
				state: "online",
				compatibility: "compatible",
			},
		],
	} as ListRuntimeBoxesOutput;
}

function Probe() {
	const { activeRuntimeBoxId, switchRuntimeBox } = useWorkspace();
	return (
		<div>
			<span data-testid="active">{activeRuntimeBoxId ?? "none"}</span>
			<button type="button" onClick={() => void switchRuntimeBox("box-2")}>
				switch
			</button>
		</div>
	);
}

beforeEach(() => {
	hoisted.bus = new MobileEventBus();
	let current = boxes("box-1", 2);
	hoisted.client = {
		listRuntimeBoxes: vi.fn(async () => current),
		listApprovals: vi.fn(async () => ({ items: [], policies: [] })),
		switchRuntimeBox: vi.fn(async () => {
			current = boxes("box-2", 3);
			return { active: { runtimeBoxId: "box-2", revision: 3 } };
		}),
	};
});

describe("WorkspaceProvider RuntimeBox selection", () => {
	it("loads the client-scoped active Runtime Box on mount", async () => {
		render(
			<WorkspaceProvider>
				<Probe />
			</WorkspaceProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("box-1"));
	});

	it("switches with the observed revision (client-scoped optimistic concurrency)", async () => {
		render(
			<WorkspaceProvider>
				<Probe />
			</WorkspaceProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("box-1"));
		await userEvent.click(screen.getByRole("button", { name: "switch" }));

		expect(hoisted.client.switchRuntimeBox).toHaveBeenCalledWith({
			runtimeBoxId: "box-2",
			expectedRevision: 2,
		});
		await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("box-2"));
	});

	it("reflects a server-pushed selection change over the event bus", async () => {
		render(
			<WorkspaceProvider>
				<Probe />
			</WorkspaceProvider>,
		);
		await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("box-1"));
		act(() => {
			hoisted.bus.emit("runtimeBoxesChanged", boxes("box-3", 5));
		});
		await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("box-3"));
	});
});
