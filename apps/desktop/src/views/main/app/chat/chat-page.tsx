import { Button } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";
import { useAppShellContext } from "../shell-context";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { SessionSidebar } from "./session-sidebar";
import type { ChatSession, ChatTransport } from "./transport";
import { useChatController } from "./use-chat-controller";

export type {
	ChatSession,
	ChatTransport,
	ChatTransportEvent,
	ProviderSummary,
} from "./transport";

export interface ChatPageProps {
	transport: ChatTransport;
	sessionId?: string;
	initialSession?: ChatSession;
	onSessionChange?(sessionId: string): void;
	onSessionHydrated?(sessionId: string): void;
	onSessionRetired?(sessionId: string): void;
	onNewSession?(): void;
	onSelectSession?(sessionId: string): void;
	onOpenProviderSettings?(): void;
	routeProjectId?: string;
	projectContext?: ProjectChatContext;
}

export interface ProjectChatContext {
	projectId: string;
	name?: string;
	path?: string;
	pathStatus?: "unknown" | "available" | "unavailable";
	runtimeBoxName?: string;
	overviewHref: string;
	settingsHref: string;
	runtimeReady: boolean;
	status: "loading" | "ready" | "error";
	disabledReason?: string;
}

export function ChatPage({
	transport,
	sessionId,
	initialSession,
	onSessionChange,
	onSessionHydrated,
	onSessionRetired,
	onNewSession = () => {},
	onSelectSession = () => {},
	onOpenProviderSettings = () => {},
	routeProjectId,
	projectContext,
}: ChatPageProps) {
	const { t } = useI18n();
	const shell = useAppShellContext();
	const runtimeBoxes = useRuntimeBoxes();
	const controller = useChatController({
		transport,
		sessionId,
		initialSession,
		projectId: routeProjectId,
		expectedProjectId: routeProjectId,
		interactionDisabledReason: projectContext?.disabledReason,
		onSessionChange,
		onSessionHydrated,
		onSessionRetired,
	});
	const sessionRefreshKey = [
		controller.session?.id ?? "",
		controller.session?.runs.length ?? 0,
		controller.isResponding ? "responding" : "idle",
	].join(":");
	const isArchived = controller.session?.archivedAt !== undefined;
	const title = controller.session?.title ?? t("chat.header.title");
	const activeSessionId = controller.session?.id ?? sessionId;
	const sessionRuntimeReady =
		projectContext !== undefined
			? projectContext.runtimeReady
			: controller.session === null
				? runtimeBoxes.isActiveReady
				: runtimeBoxes.isRuntimeBoxReady(controller.session.runtimeBoxId);
	const ownershipMismatch = controller.ownershipMismatch;
	const disabledReason = ownershipMismatch
		? t("projects.chat.mismatch")
		: (projectContext?.disabledReason ??
			(isArchived
				? t("chat.notice.archived")
				: !sessionRuntimeReady
					? t("projects.chat.runtimeOffline")
					: undefined));
	const projectPathStatus =
		projectContext?.pathStatus === undefined
			? undefined
			: t(
					projectContext.pathStatus === "available"
						? "projects.status.available"
						: projectContext.pathStatus === "unavailable"
							? "projects.status.unavailable"
							: "projects.status.unknown",
				);
	const updateSessionSummaryRef = useRef(controller.updateSessionSummary);
	updateSessionSummaryRef.current = controller.updateSessionSummary;

	useEffect(() => {
		const setNewSessionDisabled = shell?.setNewSessionDisabled;
		if (setNewSessionDisabled === undefined) {
			return;
		}
		setNewSessionDisabled(controller.isSending);
		return () => setNewSessionDisabled(false);
	}, [controller.isSending, shell?.setNewSessionDisabled]);

	useEffect(() => {
		const updatedSession = shell?.sessionUpdate?.session;
		if (updatedSession !== undefined && updatedSession.id === activeSessionId) {
			updateSessionSummaryRef.current(updatedSession);
		}
	}, [activeSessionId, shell?.sessionUpdate]);

	const providerCta = (
		<section
			className={
				sessionId === undefined
					? "chat-card provider-cta"
					: "chat-card provider-cta provider-cta--compact"
			}
		>
			<div>
				<span className="chat-card__eyebrow">{t("chat.provider.eyebrow")}</span>
				<h2>{t("chat.provider.title")}</h2>
				<p>{t("chat.provider.routedDescription")}</p>
			</div>
			<Button className="chat-button chat-button--primary" onPress={onOpenProviderSettings}>
				{t("chat.action.providerSettings")}
			</Button>
		</section>
	);

	return (
		<section className={shell === null ? "chat-page" : "chat-page chat-page--embedded"}>
			{shell === null &&
			!ownershipMismatch &&
			(sessionId === undefined || controller.session !== null) ? (
				<SessionSidebar
					transport={transport}
					selectedSessionId={activeSessionId}
					refreshKey={sessionRefreshKey}
					isNewSessionDisabled={controller.isSending}
					onNewSession={onNewSession}
					onSessionUpdated={controller.updateSessionSummary}
					onSelectSession={onSelectSession}
				/>
			) : null}

			{shell?.titlebarTarget
				? createPortal(<h1 className="workspace-session-title">{title}</h1>, shell.titlebarTarget)
				: null}

			<div className="chat-workspace">
				<p className="chat-live-region" aria-live="polite">
					{controller.announcement}
				</p>

				{shell === null ? (
					<header className="chat-page__header">
						<h1>{title}</h1>
					</header>
				) : null}

				{projectContext ? (
					<header className="project-chat-header">
						<Link to={projectContext.overviewHref}>
							<AppIcon name="back" size={16} />
							<span>{projectContext.name ?? t("page.project.title")}</span>
						</Link>
						<div className="project-chat-header__details">
							<div className="project-chat-header__identity">
								<strong>{projectContext.name ?? t("projects.chat.loadingProject")}</strong>
								{projectContext.path ? <code>{projectContext.path}</code> : null}
							</div>
							{projectContext.status === "ready" ? (
								<span className="project-chat-header__status">
									{projectContext.runtimeBoxName ?? t("projects.runtime")} ·{" "}
									{t(
										projectContext.runtimeReady
											? "projects.chat.runtimeReady"
											: "projects.status.offline",
									)}
									{projectPathStatus === undefined ? "" : ` · ${projectPathStatus}`}
								</span>
							) : null}
							<p className="project-chat-header__boundary">
								<AppIcon name="terminal" size={14} />
								{t("projects.chat.boundary")}
							</p>
						</div>
					</header>
				) : null}

				{controller.isProviderLoading &&
				!controller.hasConfiguredProvider &&
				!controller.providerError ? (
					<p className="chat-loading" role="status">
						{t("chat.status.loadingProvider")}
					</p>
				) : null}

				{controller.providerError ? (
					<section className="chat-card chat-card--error">
						<div className="chat-card__header chat-card__header--compact">
							<div>
								<span className="chat-card__eyebrow">{t("chat.error.providerEyebrow")}</span>
								<h2>{t("chat.error.providerTitle")}</h2>
							</div>
							<p>{controller.providerError}</p>
						</div>
						<Button className="chat-button" onPress={controller.reloadProviderStatus}>
							{t("chat.action.retry")}
						</Button>
					</section>
				) : null}

				{!controller.isProviderLoading &&
				!controller.providerError &&
				!controller.hasConfiguredProvider &&
				sessionId === undefined ? (
					providerCta
				) : controller.hasConfiguredProvider || sessionId !== undefined ? (
					<div className="chat-stack">
						{controller.notice ? (
							<div
								className={`chat-notice chat-notice--${controller.notice.tone}`}
								role={controller.notice.tone === "danger" ? "alert" : "status"}
							>
								<span>{controller.notice.message}</span>
								{controller.notice.action ? (
									<Button
										className="chat-button chat-button--inline"
										onPress={controller.retryNoticeAction}
									>
										{t("chat.action.retry")}
									</Button>
								) : null}
							</div>
						) : null}

						{isArchived && projectContext === undefined ? (
							<div className="chat-notice chat-notice--info" role="status">
								<span>{t("chat.notice.archived")}</span>
							</div>
						) : null}
						{!sessionRuntimeReady && projectContext === undefined ? (
							<div className="chat-notice chat-notice--info" role="status">
								<span>{t("runtime.offlineReadOnly")}</span>
							</div>
						) : null}
						{ownershipMismatch ? (
							<div className="chat-notice chat-notice--danger" role="alert">
								<span>{t("projects.chat.mismatch")}</span>
								<Link
									className="chat-button chat-button--inline"
									to={projectContext?.overviewHref ?? "/projects"}
								>
									{t("projects.chat.return")}
								</Link>
							</div>
						) : projectContext?.disabledReason ? (
							<div className="chat-notice chat-notice--info" role="status">
								<span>{projectContext.disabledReason}</span>
								<Link className="chat-button chat-button--inline" to={projectContext.settingsHref}>
									{t("projects.openSettings")}
								</Link>
							</div>
						) : null}

						<MessageList
							compact={shell !== null}
							isLoading={controller.isSessionLoading && controller.session === null}
							runs={controller.session?.runs ?? []}
							sessionId={activeSessionId}
							approvalsDisabled={disabledReason !== undefined}
						/>
						{controller.hasConfiguredProvider ? (
							<ChatComposer
								canSend={controller.canSend && disabledReason === undefined}
								{...(disabledReason === undefined ? {} : { disabledReason })}
								showDisabledReason={false}
								draft={controller.draft}
								isResponding={controller.isResponding}
								isStopping={controller.isStopping}
								availableModels={controller.availableModels}
								{...(controller.selectedModel === undefined
									? {}
									: { selectedModel: controller.selectedModel })}
								{...(controller.modelSelection?.thinkingLevel === undefined
									? {}
									: { thinkingLevel: controller.modelSelection.thinkingLevel })}
								onDraftChange={controller.setDraft}
								onModelChange={(selection) => void controller.changeSessionModel(selection)}
								onSend={() => void controller.sendMessage()}
								onStop={() => void controller.stopMessage()}
							/>
						) : controller.isProviderLoading ? null : (
							providerCta
						)}
					</div>
				) : null}
			</div>
		</section>
	);
}
