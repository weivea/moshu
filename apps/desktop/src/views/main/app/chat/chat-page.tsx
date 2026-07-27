import { Button } from "@heroui/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { useAppShellContext } from "../shell-context";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { SessionSidebar } from "./session-sidebar";
import type { ChatSession, ChatTransport } from "./transport";
import { useChatController } from "./use-chat-controller";

export type {
	ChatMessage,
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
}: ChatPageProps) {
	const { t } = useI18n();
	const shell = useAppShellContext();
	const controller = useChatController({
		transport,
		sessionId,
		initialSession,
		onSessionChange,
		onSessionHydrated,
		onSessionRetired,
	});
	const sessionRefreshKey = [
		controller.session?.id ?? "",
		controller.session?.messages.length ?? 0,
		controller.isResponding ? "responding" : "idle",
	].join(":");
	const isArchived = controller.session?.archivedAt !== undefined;
	const title = controller.session?.title ?? t("chat.header.title");
	const activeSessionId = controller.session?.id ?? sessionId;
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
			{shell === null ? (
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

						{isArchived ? (
							<div className="chat-notice chat-notice--info" role="status">
								<span>{t("chat.notice.archived")}</span>
							</div>
						) : null}

						<MessageList
							compact={shell !== null}
							isLoading={controller.isSessionLoading && controller.session === null}
							messages={controller.session?.messages ?? []}
							sessionId={activeSessionId}
						/>
						{controller.hasConfiguredProvider ? (
							<ChatComposer
								canSend={controller.canSend && !isArchived}
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
