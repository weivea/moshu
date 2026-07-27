import { AppIcon, type AppIconName } from "@moshu/ui";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { CanvasPanel, type CanvasTab } from "./canvas-panel";
import { chatTransport } from "./chat/rpc-chat-transport";
import { ChatSessionRecoveryRoot } from "./chat/session-recovery-coordinator";
import { SessionSidebar } from "./chat/session-sidebar";
import type { ChatSessionSummary } from "./chat/transport";
import { type MessageKey, useI18n } from "./i18n";
import { useLocalProfile } from "./local-profile";
import { AppShellContext, type ShellSessionUpdate } from "./shell-context";
import { usePersistedPanelResize } from "./use-persisted-panel-resize";

const primaryNavigation = [
	{ label: "nav.home", icon: "home", active: true },
	{ label: "nav.myWork", icon: "myWork" },
	{ label: "nav.automations", icon: "automations" },
	{ label: "nav.search", icon: "search" },
] as const satisfies readonly {
	label: MessageKey;
	icon: AppIconName;
	active?: boolean;
}[];

const lastChatSessionStorageKey = "moshu.lastChatSessionId";
const sidebarOpenStorageKey = "moshu.shell.sidebarOpen";
const sidebarWidthStorageKey = "moshu.shell.sidebarWidth";
const canvasOpenStorageKey = "moshu.shell.canvasOpen";
const canvasWidthStorageKey = "moshu.shell.canvasWidth";
const minimumSidebarWidth = 220;
const maximumSidebarWidth = 420;
const minimumCanvasWidth = 320;
const maximumCanvasWidth = 720;

export function AppShell() {
	const { t } = useI18n();
	const profile = useLocalProfile();
	const location = useLocation();
	const navigate = useNavigate();
	const navigationType = useNavigationType();
	const { pathname } = location;
	const activeSessionId = readActiveChatSessionId(pathname);
	const isChatWorkspace =
		pathname === "/" || pathname === "/chats" || pathname.startsWith("/chat/");
	// Project-scoped Sessions (/projects/:projectId/chat/:sessionId) should also enable
	// Canvas once their local-project workspace is implemented.
	const isCanvasAvailable = activeSessionId !== null;
	const [isSidebarOpen, setIsSidebarOpen] = useState(() =>
		readStoredBoolean(sidebarOpenStorageKey, true),
	);
	const [isCanvasOpen, setIsCanvasOpen] = useState(() =>
		readStoredBoolean(canvasOpenStorageKey, false),
	);
	const [activeCanvasTab, setActiveCanvasTab] = useState<CanvasTab>("changes");
	const [isCanvasExpanded, setIsCanvasExpanded] = useState(false);
	const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
	const [isNewSessionDisabled, setNewSessionDisabled] = useState(false);
	const [sessionUpdate, setSessionUpdate] = useState<ShellSessionUpdate | null>(null);
	const [routeHistory, setRouteHistory] = useState<RouteHistoryState>(() => ({
		entries: [location.key],
		index: 0,
	}));
	const sidebarResize = usePersistedPanelResize({
		storageKey: sidebarWidthStorageKey,
		minimumWidth: minimumSidebarWidth,
		maximumWidth: maximumSidebarWidth,
		dragDirection: 1,
		getDefaultWidth: getResponsiveDefaultSidebarWidth,
	});
	const canvasResize = usePersistedPanelResize({
		storageKey: canvasWidthStorageKey,
		minimumWidth: minimumCanvasWidth,
		maximumWidth: maximumCanvasWidth,
		dragDirection: -1,
		getDefaultWidth: getResponsiveDefaultCanvasWidth,
	});
	const displayName = profile.username ?? t("profile.defaultName");
	const canNavigateBack = routeHistory.index > 0;
	const canNavigateForward = routeHistory.index < routeHistory.entries.length - 1;
	const isCanvasVisible = isCanvasAvailable && isCanvasOpen;
	const isCanvasFullscreen = isCanvasVisible && isCanvasExpanded;

	useEffect(() => {
		localStorage.setItem(sidebarOpenStorageKey, String(isSidebarOpen));
	}, [isSidebarOpen]);

	useEffect(() => {
		localStorage.setItem(canvasOpenStorageKey, String(isCanvasOpen));
		if (!isCanvasOpen) {
			setIsCanvasExpanded(false);
		}
	}, [isCanvasOpen]);

	useEffect(() => {
		if (!isCanvasAvailable) {
			setIsCanvasExpanded(false);
		}
	}, [isCanvasAvailable]);

	useEffect(() => {
		setRouteHistory((current) => {
			const existingIndex = current.entries.indexOf(location.key);

			if (navigationType === "POP") {
				if (existingIndex < 0) {
					return {
						entries: [location.key, ...current.entries.slice(current.index)],
						index: 0,
					};
				}
				return existingIndex === current.index ? current : { ...current, index: existingIndex };
			}

			if (navigationType === "REPLACE") {
				if (current.entries[current.index] === location.key) {
					return current;
				}
				const entries = [...current.entries];
				entries[current.index] = location.key;
				return { entries, index: current.index };
			}

			if (current.entries[current.index] === location.key) {
				return current;
			}
			const entries = [...current.entries.slice(0, current.index + 1), location.key];
			return { entries, index: entries.length - 1 };
		});
	}, [location.key, navigationType]);

	const handleNavigateBack = useCallback(() => {
		if (canNavigateBack) {
			navigate(-1);
		}
	}, [canNavigateBack, navigate]);

	const handleNavigateForward = useCallback(() => {
		if (canNavigateForward) {
			navigate(1);
		}
	}, [canNavigateForward, navigate]);

	const handleActiveSessionRetired = useCallback(
		(retiredSessionId: string) => {
			const rememberedSessionId = localStorage.getItem(lastChatSessionStorageKey);
			navigate("/chat/new", {
				replace: true,
				state:
					rememberedSessionId !== null && rememberedSessionId !== retiredSessionId
						? { preserveRememberedSession: true }
						: null,
			});
		},
		[navigate],
	);

	const handleSessionUpdated = useCallback((session: ChatSessionSummary) => {
		setSessionUpdate((current) => ({
			revision: (current?.revision ?? 0) + 1,
			session,
		}));
	}, []);

	const shellContext = useMemo(
		() => ({
			sessionSidebarOwned: true as const,
			sessionUpdate,
			titlebarTarget,
			setNewSessionDisabled,
		}),
		[sessionUpdate, titlebarTarget],
	);
	const shellStyle: AppShellStyle = {
		...(sidebarResize.width === null ? {} : { "--sidebar-width": `${sidebarResize.width}px` }),
		...(canvasResize.width === null ? {} : { "--canvas-width": `${canvasResize.width}px` }),
	};

	return (
		<ChatSessionRecoveryRoot
			activeSessionId={activeSessionId}
			onActiveSessionRetired={handleActiveSessionRetired}
			routeKey={`${location.key}:${pathname}`}
			transport={chatTransport}
		>
			<AppShellContext.Provider value={shellContext}>
				<div
					className={isCanvasFullscreen ? "app-shell is-canvas-expanded" : "app-shell"}
					data-sidebar-open={isSidebarOpen}
					data-sidebar-resizing={sidebarResize.isResizing}
					data-canvas-open={isCanvasVisible}
					data-canvas-resizing={isCanvasVisible && canvasResize.isResizing}
					style={shellStyle}
				>
					<div className="shell-sidebar-toggle" data-sidebar-open={isSidebarOpen}>
						<span className="window-controls-spacer" aria-hidden="true" />
						<PanelToggleButton
							label={t(isSidebarOpen ? "shell.collapseSidebar" : "shell.expandSidebar")}
							isOpen={isSidebarOpen}
							openIcon="panelLeftOpen"
							closedIcon="panelLeft"
							onClick={() => setIsSidebarOpen((current) => !current)}
						/>
					</div>

					{isSidebarOpen ? (
						<>
							<aside className="app-sidebar" ref={sidebarResize.panelRef}>
								<header className="app-titlebar app-sidebar__titlebar electrobun-webkit-app-region-drag">
									<TitlebarButton
										label={t("shell.back")}
										icon="back"
										disabled={!canNavigateBack}
										onClick={handleNavigateBack}
									/>
									<TitlebarButton
										label={t("shell.forward")}
										icon="forward"
										disabled={!canNavigateForward}
										onClick={handleNavigateForward}
									/>
								</header>

								<div className="app-sidebar__body">
									<nav className="sidebar-primary" aria-label="Primary">
										{primaryNavigation.map((item) => (
											<button
												key={item.label}
												type="button"
												className={
													"active" in item && item.active
														? "sidebar-nav-item is-active"
														: "sidebar-nav-item"
												}
												aria-disabled="true"
											>
												<AppIcon name={item.icon} size={18} />
												<span>{t(item.label)}</span>
											</button>
										))}
									</nav>

									<SessionSidebar
										transport={chatTransport}
										selectedSessionId={activeSessionId ?? undefined}
										refreshKey={`${location.key}:${pathname}`}
										isNewSessionDisabled={isNewSessionDisabled}
										onNewSession={() => navigate("/chat/new")}
										onSessionUpdated={handleSessionUpdated}
										onSelectSession={(sessionId) => navigate(`/chat/${sessionId}`)}
									/>

									<section className="projects-sidebar" aria-labelledby="projects-sidebar-title">
										<header>
											<h2 id="projects-sidebar-title">{t("nav.projects")}</h2>
											<button
												type="button"
												aria-label={t("action.addProject")}
												title={t("action.addProject")}
												disabled
											>
												<AppIcon name="plus" size={17} />
											</button>
										</header>
										<div className="projects-sidebar__empty" />
									</section>
								</div>

								<footer className="app-sidebar__footer">
									<Link className="local-profile-link" to="/settings/profile">
										<span className="local-profile-avatar" aria-hidden="true">
											{displayName.slice(0, 1).toUpperCase()}
										</span>
										<strong>{displayName}</strong>
									</Link>
									<Link
										className="sidebar-footer-button"
										to="/settings/profile"
										aria-label={t("nav.settings")}
										title={t("nav.settings")}
									>
										<AppIcon name="settings" size={18} />
									</Link>
								</footer>
							</aside>
							{!isCanvasFullscreen ? (
								<hr
									className="app-sidebar__resize-handle electrobun-webkit-app-region-no-drag"
									aria-label={t("shell.resizeSidebar")}
									title={t("shell.resizeSidebar")}
									aria-orientation="vertical"
									aria-valuemin={minimumSidebarWidth}
									aria-valuemax={maximumSidebarWidth}
									aria-valuenow={Math.round(sidebarResize.reportedWidth)}
									tabIndex={0}
									onKeyDown={sidebarResize.handleResizeKeyDown}
									onLostPointerCapture={sidebarResize.handleResizeEnd}
									onPointerCancel={sidebarResize.handleResizeEnd}
									onPointerDown={sidebarResize.handleResizeStart}
									onPointerMove={sidebarResize.handleResizeMove}
									onPointerUp={sidebarResize.handleResizeEnd}
								/>
							) : null}
						</>
					) : null}

					<header className="app-titlebar workspace-titlebar electrobun-webkit-app-region-drag">
						<div className="workspace-titlebar__slot" ref={setTitlebarTarget}>
							{!isChatWorkspace ? <h1>{getWorkspaceTitle(pathname, t)}</h1> : null}
						</div>

						{isCanvasAvailable ? (
							<PanelToggleButton
								label={t(isCanvasOpen ? "canvas.close" : "shell.openCanvas")}
								isOpen={isCanvasOpen}
								openIcon="panelRightOpen"
								closedIcon="panelRight"
								onClick={() => setIsCanvasOpen((current) => !current)}
							/>
						) : null}
					</header>

					<section className="workspace-shell">
						<main className="content">
							<Outlet />
						</main>
					</section>

					{isCanvasVisible ? (
						<>
							<CanvasPanel
								activeTab={activeCanvasTab}
								isExpanded={isCanvasExpanded}
								panelRef={canvasResize.panelRef}
								onActiveTabChange={setActiveCanvasTab}
								onExpandedChange={setIsCanvasExpanded}
							/>
							{!isCanvasExpanded ? (
								<hr
									className="canvas-panel__resize-handle electrobun-webkit-app-region-no-drag"
									aria-label={t("canvas.resize")}
									title={t("canvas.resize")}
									aria-orientation="vertical"
									aria-valuemin={minimumCanvasWidth}
									aria-valuemax={maximumCanvasWidth}
									aria-valuenow={Math.round(canvasResize.reportedWidth)}
									tabIndex={0}
									onKeyDown={canvasResize.handleResizeKeyDown}
									onLostPointerCapture={canvasResize.handleResizeEnd}
									onPointerCancel={canvasResize.handleResizeEnd}
									onPointerDown={canvasResize.handleResizeStart}
									onPointerMove={canvasResize.handleResizeMove}
									onPointerUp={canvasResize.handleResizeEnd}
								/>
							) : null}
						</>
					) : null}
				</div>
			</AppShellContext.Provider>
		</ChatSessionRecoveryRoot>
	);
}

interface TitlebarButtonProps {
	label: string;
	icon: AppIconName;
	disabled?: boolean;
	onClick(): void;
}

interface RouteHistoryState {
	entries: string[];
	index: number;
}

interface AppShellStyle extends CSSProperties {
	"--sidebar-width"?: string;
	"--canvas-width"?: string;
}

interface PanelToggleButtonProps {
	label: string;
	isOpen: boolean;
	openIcon: AppIconName;
	closedIcon: AppIconName;
	onClick(): void;
}

function PanelToggleButton({
	label,
	isOpen,
	openIcon,
	closedIcon,
	onClick,
}: PanelToggleButtonProps) {
	return (
		<button
			type="button"
			className="titlebar-button electrobun-webkit-app-region-no-drag"
			aria-label={label}
			aria-expanded={isOpen}
			title={label}
			onClick={onClick}
		>
			<span className="panel-toggle-icon" data-panel-open={isOpen} aria-hidden="true">
				<AppIcon className="panel-toggle-icon__open" name={openIcon} size={18} />
				<AppIcon className="panel-toggle-icon__closed" name={closedIcon} size={18} />
			</span>
		</button>
	);
}

function TitlebarButton({ label, icon, disabled = false, onClick }: TitlebarButtonProps) {
	return (
		<button
			type="button"
			className="titlebar-button electrobun-webkit-app-region-no-drag"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
		>
			<AppIcon name={icon} size={18} />
		</button>
	);
}

function readActiveChatSessionId(pathname: string): string | null {
	const match = /^\/chat\/([^/]+)$/u.exec(pathname);
	if (match?.[1] === undefined || match[1] === "new") {
		return null;
	}
	return decodeURIComponent(match[1]);
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
	const storedValue = localStorage.getItem(key);
	if (storedValue === "true") {
		return true;
	}
	if (storedValue === "false") {
		return false;
	}
	return fallback;
}

function getResponsiveDefaultSidebarWidth(): number {
	if (window.innerWidth <= 980) {
		return 232;
	}
	if (window.innerWidth <= 1240) {
		return 248;
	}
	return 268;
}

function getResponsiveDefaultCanvasWidth(): number {
	if (window.innerWidth <= 980) {
		return Math.min(480, window.innerWidth);
	}
	if (window.innerWidth <= 1240) {
		return Math.min(480, Math.max(340, window.innerWidth * 0.4));
	}
	return Math.min(560, Math.max(360, window.innerWidth * 0.38));
}

function getWorkspaceTitle(pathname: string, t: ReturnType<typeof useI18n>["t"]): string {
	if (pathname.startsWith("/settings")) {
		return t("page.settings.title");
	}
	if (pathname.startsWith("/projects")) {
		return t("page.projects.title");
	}
	if (pathname.startsWith("/tasks")) {
		return t("page.tasks.title");
	}
	if (pathname.startsWith("/agents")) {
		return t("page.agents.title");
	}
	if (pathname.startsWith("/canvas")) {
		return t("page.canvas.title");
	}
	return t("app.name");
}
