import type { AppIconName } from "@moshu/ui";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { isAgentsUnavailableError } from "../../../shared/rpc-errors";
import { ChatPage } from "./chat/chat-page";
import { chatTransport } from "./chat/rpc-chat-transport";
import {
	isRendererSessionRetired,
	useChatSessionRecovery,
} from "./chat/session-recovery-coordinator";
import type { ChatSession, ChatTransport } from "./chat/transport";
import { EmptyState } from "./empty-state";
import { type MessageKey, useI18n } from "./i18n";
import { useProjectData } from "./projects/project-data";
import { ProjectSettingsPage } from "./projects/project-settings";
import { useProjectDetail } from "./projects/use-project-detail";
import { ProjectDetailPage, ProjectsPage } from "./projects-page";
import { useRuntimeBoxes } from "./runtime-boxes";
import { DefaultModelSettingsPage } from "./settings/default-model-page";
import { GeneralSettingsPage } from "./settings/general-page";
import { MobileAccessSettingsPage } from "./settings/mobile-access-page";
import { ProvidersSettingsPage } from "./settings/providers/providers-page";
import { RuntimeBoxesSettingsPage } from "./settings/runtime-boxes-page";
import { McpServersSettingsPage, SkillsSettingsPage } from "./settings/runtime-resources-page";

const lastChatSessionStorageKey = "moshu.lastChatSessionId";
const initialHydrationRetryDelayMs = 100;
const maxInitialHydrationAttempts = 5;

interface ChatHomePageProps {
	transport?: ChatTransport;
	retryDelayMs?: number;
	maxAttempts?: number;
}

export function ChatHomePage({
	transport = chatTransport,
	retryDelayMs = initialHydrationRetryDelayMs,
	maxAttempts = maxInitialHydrationAttempts,
}: ChatHomePageProps = {}) {
	const navigate = useNavigate();
	const { coordinator: sessionRecoveryCoordinator } = useChatSessionRecovery(transport, undefined);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	useEffect(() => {
		const lastSessionId = localStorage.getItem(lastChatSessionStorageKey);
		if (lastSessionId === null) {
			navigate("/chat/new", { replace: true });
			return;
		}
		if (isRendererSessionRetired(lastSessionId)) {
			localStorage.removeItem(lastChatSessionStorageKey);
			navigate("/chat/new", { replace: true });
			return;
		}

		let active = true;
		let attempts = 0;
		let inFlight = false;
		let retryRequested = false;
		let waitingForReadiness = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const scheduleRetry = () => {
			if (!active || inFlight || !waitingForReadiness || attempts >= maxAttempts) {
				return;
			}
			if (retryTimer !== undefined) {
				clearTimeout(retryTimer);
			}
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				retryRequested = false;
				void hydrate();
			}, retryDelayMs);
		};
		const hydrate = async () => {
			if (!active || inFlight || attempts >= maxAttempts) {
				return;
			}
			inFlight = true;
			attempts += 1;
			try {
				const hydratedSession = await transport.getSession(lastSessionId);
				if (!active) {
					return;
				}
				waitingForReadiness = false;
				setErrorMessage(null);
				navigate(`/chat/${lastSessionId}`, {
					replace: true,
					state: { hydratedSession },
				});
			} catch (error) {
				const sessionMiss = sessionRecoveryCoordinator.handleSessionMiss(lastSessionId, error);
				if (!active) {
					return;
				}
				if (sessionMiss) {
					waitingForReadiness = false;
					navigate("/chat/new", { replace: true });
					return;
				}
				setErrorMessage(
					error instanceof Error ? error.message : "Failed to restore the remembered chat Session.",
				);
				waitingForReadiness = isAgentsUnavailableError(error);
			} finally {
				inFlight = false;
				if (retryRequested) {
					scheduleRetry();
				}
			}
		};
		const unsubscribeReady = transport.subscribeAgentsReady?.(() => {
			retryRequested = true;
			scheduleRetry();
		});
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void hydrate();
		}, 0);

		return () => {
			active = false;
			if (retryTimer !== undefined) {
				clearTimeout(retryTimer);
			}
			unsubscribeReady?.();
		};
	}, [maxAttempts, navigate, retryDelayMs, sessionRecoveryCoordinator, transport]);

	return errorMessage === null ? null : <div role="alert">{errorMessage}</div>;
}

export function NewChatPage({ transport = chatTransport }: { transport?: ChatTransport } = {}) {
	const navigate = useNavigate();
	const location = useLocation();

	useEffect(() => {
		if (!shouldPreserveRememberedSession(location.state)) {
			localStorage.removeItem(lastChatSessionStorageKey);
		}
	}, [location.state]);

	return (
		<ChatPage
			transport={transport}
			onSessionChange={(sessionId) => navigate(`/chat/${sessionId}`, { replace: true })}
			onNewSession={() => navigate("/chat/new")}
			onSelectSession={(sessionId) => navigate(`/chat/${sessionId}`)}
			onOpenProviderSettings={() => navigate("/settings/providers")}
		/>
	);
}

export function ChatsPage() {
	return <NewChatPage />;
}

export function ChatSessionPage({ transport = chatTransport }: { transport?: ChatTransport } = {}) {
	const { sessionId } = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const hydratedSession =
		sessionId === undefined ? undefined : readHydratedSession(location.state, sessionId);
	const handleSessionHydrated = useCallback((hydratedSessionId: string) => {
		if (isRendererSessionRetired(hydratedSessionId)) {
			return;
		}
		localStorage.setItem(lastChatSessionStorageKey, hydratedSessionId);
	}, []);
	const handleSessionRetired = useCallback(
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
	const sessionIsRetired = sessionId !== undefined && isRendererSessionRetired(sessionId);

	useEffect(() => {
		if (sessionId !== undefined && sessionIsRetired) {
			handleSessionRetired(sessionId);
		}
	}, [handleSessionRetired, sessionId, sessionIsRetired]);

	if (sessionId === undefined) {
		throw new Error("Chat session route is missing its session ID.");
	}
	if (sessionIsRetired) {
		return null;
	}

	return (
		<ChatPage
			transport={transport}
			sessionId={sessionId}
			initialSession={hydratedSession}
			onSessionChange={(nextSessionId) => navigate(`/chat/${nextSessionId}`, { replace: true })}
			onSessionHydrated={handleSessionHydrated}
			onSessionRetired={handleSessionRetired}
			onNewSession={() => navigate("/chat/new")}
			onSelectSession={(nextSessionId) => navigate(`/chat/${nextSessionId}`)}
			onOpenProviderSettings={() => navigate("/settings/providers")}
		/>
	);
}

function shouldPreserveRememberedSession(state: unknown): boolean {
	return (
		typeof state === "object" &&
		state !== null &&
		"preserveRememberedSession" in state &&
		state.preserveRememberedSession === true
	);
}

function readHydratedSession(state: unknown, sessionId: string): ChatSession | undefined {
	if (isRendererSessionRetired(sessionId)) {
		return undefined;
	}
	if (typeof state !== "object" || state === null || !("hydratedSession" in state)) {
		return undefined;
	}
	const hydratedSession = state.hydratedSession;
	return typeof hydratedSession === "object" &&
		hydratedSession !== null &&
		"id" in hydratedSession &&
		hydratedSession.id === sessionId
		? (hydratedSession as ChatSession)
		: undefined;
}

export function ProviderSettingsRoutePage({
	transport = chatTransport,
}: {
	transport?: ChatTransport;
} = {}) {
	return <ProvidersSettingsPage transport={transport} />;
}

export function DefaultModelSettingsRoutePage({
	transport = chatTransport,
}: {
	transport?: ChatTransport;
} = {}) {
	return <DefaultModelSettingsPage transport={transport} />;
}

export function GeneralSettingsRoutePage() {
	return <GeneralSettingsPage />;
}

export function RuntimeBoxesSettingsRoutePage() {
	return <RuntimeBoxesSettingsPage />;
}

export function MobileAccessSettingsRoutePage() {
	return <MobileAccessSettingsPage />;
}

export function McpServersSettingsRoutePage() {
	return <McpServersSettingsPage />;
}

export function SkillsSettingsRoutePage() {
	return <SkillsSettingsPage />;
}

export function ProjectsRoutePage() {
	return <ProjectsPage />;
}

export function ProjectDetailRoutePage() {
	return <ProjectDetailPage />;
}

export function ProjectSettingsRoutePage() {
	return <ProjectSettingsPage />;
}

export function ProjectNewChatPage({
	transport = chatTransport,
}: {
	transport?: ChatTransport;
} = {}) {
	return <ProjectChatRoute transport={transport} />;
}

export function ProjectChatSessionPage({
	transport = chatTransport,
}: {
	transport?: ChatTransport;
} = {}) {
	const { sessionId } = useParams();
	if (sessionId === undefined) {
		throw new Error("Project Chat route is missing its Session ID.");
	}
	return <ProjectChatRoute transport={transport} sessionId={sessionId} />;
}

function ProjectChatRoute({
	transport,
	sessionId,
}: {
	transport: ChatTransport;
	sessionId?: string;
}) {
	const { projectId } = useParams();
	const { t } = useI18n();
	const navigate = useNavigate();
	const runtimeBoxes = useRuntimeBoxes();
	const detail = useProjectDetail(projectId, true);
	const { invalidateProject } = useProjectData();
	if (projectId === undefined) {
		throw new Error("Project Chat route is missing its Project ID.");
	}
	const project = detail.project;
	const ownerRuntimeBox = runtimeBoxes.snapshot.items.find(
		(item) => item.runtimeBox.runtimeBoxId === project?.runtimeBoxId,
	);
	const disabledReason =
		detail.error !== undefined
			? t("projects.chat.detailsUnavailable")
			: project === undefined || detail.isCheckingPath
				? t("projects.chat.checking")
				: project.deletionRequestedAt !== undefined
					? t("projects.chat.deleting")
					: project.archivedAt !== undefined
						? t("projects.chat.archived")
						: !detail.runtimeReady
							? t("projects.chat.runtimeOffline")
							: detail.healthError !== undefined || project.pathStatus !== "available"
								? t("projects.chat.pathUnavailable")
								: undefined;
	const projectContext = {
		projectId,
		...(project?.name === undefined ? {} : { name: project.name }),
		...(project?.path === undefined ? {} : { path: project.path }),
		...(project?.pathStatus === undefined ? {} : { pathStatus: project.pathStatus }),
		...(ownerRuntimeBox === undefined
			? {}
			: { runtimeBoxName: ownerRuntimeBox.runtimeBox.displayName }),
		overviewHref: `/projects/${projectId}`,
		settingsHref: `/projects/${projectId}/settings`,
		runtimeReady: detail.runtimeReady,
		status: detail.error ? ("error" as const) : project ? ("ready" as const) : ("loading" as const),
		...(disabledReason === undefined ? {} : { disabledReason }),
	};
	return (
		<ChatPage
			transport={transport}
			{...(sessionId === undefined ? {} : { sessionId })}
			routeProjectId={projectId}
			projectContext={projectContext}
			onSessionChange={(nextSessionId) => {
				invalidateProject(projectId, project?.runtimeBoxId);
				navigate(`/projects/${projectId}/chat/${nextSessionId}`, { replace: true });
			}}
			onSessionRetired={() => navigate(`/projects/${projectId}`, { replace: true })}
			onNewSession={() => navigate(`/projects/${projectId}/chat/new`)}
			onSelectSession={(nextSessionId) => navigate(`/projects/${projectId}/chat/${nextSessionId}`)}
			onOpenProviderSettings={() => navigate("/settings/providers")}
		/>
	);
}

export function PlaceholderPage({ titleKey, icon }: { titleKey: MessageKey; icon: AppIconName }) {
	const { t } = useI18n();

	return <EmptyState icon={icon} title={t(titleKey)} description={t("page.placeholder")} />;
}

export function SettingsPlaceholderPage() {
	const { t } = useI18n();

	return (
		<EmptyState
			icon="settings"
			title={t("page.settings.title")}
			description={t("settings.sectionPlaceholder")}
		/>
	);
}
