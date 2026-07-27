import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { LocalProfileProvider } from "./local-profile";
import { AppearanceProvider } from "./providers";
import { AppShell } from "./shell";

const fakeChatTransport = vi.hoisted(() => ({
	getSession: vi.fn(),
	listSessions: vi.fn(async () => []),
	retireSession: vi.fn(),
	subscribeAgentsReady: vi.fn(() => () => undefined),
	subscribeSessionInvalidations: vi.fn(() => () => undefined),
}));

vi.mock("./chat/rpc-chat-transport", () => ({
	chatTransport: fakeChatTransport,
}));

class MockPointerEvent extends MouseEvent {
	readonly pointerId: number;

	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 0;
	}
}

beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	Object.defineProperty(window, "PointerEvent", {
		configurable: true,
		value: MockPointerEvent,
	});
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	});
});

describe("AppShell", () => {
	test("provides collapsible navigation and an interactive empty Canvas container", async () => {
		render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/session-1"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/:sessionId" element={<div>Workspace</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		expect(screen.getByRole("button", { name: "Home" })).toBeVisible();
		expect(screen.getByRole("heading", { name: "Sessions", level: 2 })).toBeVisible();
		expect(screen.getByRole("heading", { name: "Projects" })).toBeVisible();
		expect(screen.getByRole("link", { name: "Local user" })).toBeVisible();
		await waitFor(() => expect(fakeChatTransport.listSessions).toHaveBeenCalled());

		const sidebarToggle = screen.getByRole("button", { name: "Collapse sidebar" });
		expect(sidebarToggle).toHaveAttribute("title", "Collapse sidebar");
		expect(within(sidebarToggle).getByRole("generic", { hidden: true })).toHaveAttribute(
			"data-panel-open",
			"true",
		);
		expect(screen.getByRole("button", { name: "Go back" })).toHaveAttribute("title", "Go back");
		expect(screen.getByRole("button", { name: "Go forward" })).toHaveAttribute(
			"title",
			"Go forward",
		);
		expect(screen.getByRole("button", { name: "Add a project" })).toHaveAttribute(
			"title",
			"Add a project",
		);
		expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("title", "Settings");
		expect(screen.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute(
			"title",
			"Resize sidebar",
		);
		fireEvent.click(sidebarToggle);
		expect(screen.queryByRole("button", { name: "Home" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Go forward" })).not.toBeInTheDocument();
		const collapsedSidebarToggle = screen.getByRole("button", { name: "Expand sidebar" });
		expect(collapsedSidebarToggle).toBe(sidebarToggle);
		expect(collapsedSidebarToggle).toHaveAttribute("title", "Expand sidebar");
		expect(within(collapsedSidebarToggle).getByRole("generic", { hidden: true })).toHaveAttribute(
			"data-panel-open",
			"false",
		);
		fireEvent.click(collapsedSidebarToggle);
		expect(screen.getByRole("button", { name: "Home" })).toBeVisible();

		const canvasToggle = screen.getByRole("button", { name: "Open Canvas" });
		expect(canvasToggle).toHaveAttribute("title", "Open Canvas");
		const sharedTitlebar = canvasToggle.closest(".workspace-titlebar");
		fireEvent.click(canvasToggle);
		const closeCanvasToggle = screen.getByRole("button", { name: "Close Canvas" });
		expect(closeCanvasToggle).toBe(canvasToggle);
		expect(closeCanvasToggle).toHaveAttribute("title", "Close Canvas");
		expect(sharedTitlebar).toContainElement(closeCanvasToggle);
		expect(within(closeCanvasToggle).getByRole("generic", { hidden: true })).toHaveAttribute(
			"data-panel-open",
			"true",
		);
		const canvas = screen.getByRole("complementary", { name: "Canvas" });
		expect(canvas.querySelector(".canvas-panel__titlebar")).not.toBeInTheDocument();
		expect(within(canvas).getByRole("button", { name: "Add Canvas tab" })).toHaveAttribute(
			"title",
			"Add Canvas tab",
		);
		expect(within(canvas).getByRole("button", { name: "Expand Canvas" })).toHaveAttribute(
			"title",
			"Expand Canvas",
		);
		expect(screen.getByRole("separator", { name: "Resize Canvas" })).toHaveAttribute(
			"title",
			"Resize Canvas",
		);
		const terminalTab = within(canvas).getByRole("tab", { name: "Terminal" });
		expect(within(canvas).getByRole("tab", { name: "Changes" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		fireEvent.click(terminalTab);
		expect(terminalTab).toHaveAttribute("aria-selected", "true");

		fireEvent.click(within(canvas).getByRole("button", { name: "Expand Canvas" }));
		expect(screen.getByText("Workspace").closest(".app-shell")).toHaveClass("is-canvas-expanded");
		fireEvent.click(closeCanvasToggle);
		expect(screen.queryByRole("complementary", { name: "Canvas" })).not.toBeInTheDocument();
	});

	test("navigates backward and forward through UI routes", async () => {
		localStorage.setItem("moshu.shell.canvasOpen", "true");
		render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/new"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/new" element={<div>Chat route</div>} />
									<Route path="/settings/general" element={<div>General route</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		const backButton = screen.getByRole("button", { name: "Go back" });
		const forwardButton = screen.getByRole("button", { name: "Go forward" });
		expect(backButton).toBeDisabled();
		expect(forwardButton).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Open Canvas" })).not.toBeInTheDocument();
		expect(screen.queryByRole("complementary", { name: "Canvas" })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("link", { name: "Local user" }));
		expect(await screen.findByText("General route")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Open Canvas" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close Canvas" })).not.toBeInTheDocument();
		expect(screen.queryByRole("complementary", { name: "Canvas" })).not.toBeInTheDocument();
		await waitFor(() => expect(backButton).toBeEnabled());
		expect(forwardButton).toBeDisabled();

		fireEvent.click(backButton);
		expect(await screen.findByText("Chat route")).toBeVisible();
		await waitFor(() => expect(forwardButton).toBeEnabled());
		expect(backButton).toBeDisabled();

		fireEvent.click(forwardButton);
		expect(await screen.findByText("General route")).toBeVisible();
		await waitFor(() => expect(backButton).toBeEnabled());
		expect(forwardButton).toBeDisabled();
	});

	test("resizes the sidebar and restores the remembered width", () => {
		const firstRender = render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/new"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/new" element={<div>Resizable workspace</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		const sidebar = screen.getByRole("button", { name: "Home" }).closest(".app-sidebar");
		if (sidebar === null) {
			throw new Error("Expected the application sidebar to be rendered.");
		}
		vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			width: 248,
			height: 760,
			top: 0,
			right: 248,
			bottom: 760,
			left: 0,
			toJSON: () => ({}),
		});

		const resizeHandle = screen.getByRole("separator", { name: "Resize sidebar" });
		const shell = screen.getByText("Resizable workspace").closest<HTMLElement>(".app-shell");
		if (shell === null) {
			throw new Error("Expected the application shell to be rendered.");
		}

		fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 248, pointerId: 1 });
		fireEvent.pointerMove(resizeHandle, { clientX: 328, pointerId: 1 });
		expect(shell.style.getPropertyValue("--sidebar-width")).toBe("328px");
		fireEvent.pointerUp(resizeHandle, { clientX: 328, pointerId: 1 });
		expect(localStorage.getItem("moshu.shell.sidebarWidth")).toBe("328");

		firstRender.unmount();
		render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/new"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/new" element={<div>Restored workspace</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		const restoredShell = screen.getByText("Restored workspace").closest<HTMLElement>(".app-shell");
		if (restoredShell === null) {
			throw new Error("Expected the restored application shell to be rendered.");
		}
		expect(restoredShell.style.getPropertyValue("--sidebar-width")).toBe("328px");

		fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), {
			key: "ArrowRight",
		});
		expect(restoredShell.style.getPropertyValue("--sidebar-width")).toBe("336px");
		expect(localStorage.getItem("moshu.shell.sidebarWidth")).toBe("336");
	});

	test("resizes the Canvas from its left edge and restores the remembered width", () => {
		const firstRender = render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/session-1"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/:sessionId" element={<div>Canvas workspace</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open Canvas" }));
		const canvas = screen.getByRole("complementary", { name: "Canvas" });
		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			x: 800,
			y: 40,
			width: 480,
			height: 720,
			top: 40,
			right: 1280,
			bottom: 760,
			left: 800,
			toJSON: () => ({}),
		});

		const resizeHandle = screen.getByRole("separator", { name: "Resize Canvas" });
		const shell = screen.getByText("Canvas workspace").closest<HTMLElement>(".app-shell");
		if (shell === null) {
			throw new Error("Expected the application shell to be rendered.");
		}

		fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 800, pointerId: 2 });
		fireEvent.pointerMove(resizeHandle, { clientX: 700, pointerId: 2 });
		expect(shell.style.getPropertyValue("--canvas-width")).toBe("580px");
		fireEvent.pointerUp(resizeHandle, { clientX: 700, pointerId: 2 });
		expect(localStorage.getItem("moshu.shell.canvasWidth")).toBe("580");

		firstRender.unmount();
		render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/chat/session-1"]}>
							<Routes>
								<Route element={<AppShell />}>
									<Route path="/chat/:sessionId" element={<div>Restored Canvas workspace</div>} />
								</Route>
							</Routes>
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		const restoredShell = screen
			.getByText("Restored Canvas workspace")
			.closest<HTMLElement>(".app-shell");
		if (restoredShell === null) {
			throw new Error("Expected the restored application shell to be rendered.");
		}
		expect(restoredShell.style.getPropertyValue("--canvas-width")).toBe("580px");

		fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Canvas" }), {
			key: "ArrowLeft",
		});
		expect(restoredShell.style.getPropertyValue("--canvas-width")).toBe("588px");
		expect(localStorage.getItem("moshu.shell.canvasWidth")).toBe("588");
	});
});
