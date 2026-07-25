import { Button } from "@heroui/react";
import { useI18n } from "../i18n";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { SessionSidebar } from "./session-sidebar";
import type { ChatTransport } from "./transport";
import { useChatController } from "./use-chat-controller";

export type {
	ChatMessage,
	ChatProviderConfiguration,
	ChatProviderStatus,
	ChatSession,
	ChatTransport,
	ChatTransportEvent,
} from "./transport";

export interface ChatPageProps {
	transport: ChatTransport;
	sessionId?: string;
	onSessionChange?(sessionId: string): void;
	onNewSession?(): void;
	onSelectSession?(sessionId: string): void;
	onOpenProviderSettings?(): void;
}

export function ChatPage({
	transport,
	sessionId,
	onSessionChange,
	onNewSession = () => {},
	onSelectSession = () => {},
	onOpenProviderSettings = () => {},
}: ChatPageProps) {
	const { t } = useI18n();
	const controller = useChatController({
		transport,
		sessionId,
		onSessionChange,
	});
	const sessionRefreshKey = [
		controller.session?.id ?? "",
		controller.session?.messages.length ?? 0,
		controller.isResponding ? "responding" : "idle",
	].join(":");
	const isArchived = controller.session?.archivedAt !== undefined;
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
		<section className="chat-page">
			<SessionSidebar
				transport={transport}
				selectedSessionId={controller.session?.id ?? sessionId}
				refreshKey={sessionRefreshKey}
				isNewSessionDisabled={controller.isSending}
				onNewSession={onNewSession}
				onSessionUpdated={controller.updateSessionSummary}
				onSelectSession={onSelectSession}
			/>

			<div className="chat-workspace">
				<p className="chat-live-region" aria-live="polite">
					{controller.announcement}
				</p>

				<header className="chat-page__header">
					<div>
						<span className="chat-page__eyebrow">{t("chat.header.eyebrow")}</span>
						<h1>{controller.session?.title ?? t("chat.header.title")}</h1>
						<p>
							{controller.meta.model} / {controller.meta.askMode}
						</p>
					</div>
					<Button className="chat-button" onPress={onOpenProviderSettings}>
						{t("chat.action.providerSettings")}
					</Button>
				</header>

				{controller.isProviderLoading && !controller.providerStatus && !controller.providerError ? (
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
							isLoading={controller.isSessionLoading}
							messages={controller.session?.messages ?? []}
							sessionId={controller.session?.id ?? sessionId}
						/>
						{controller.hasConfiguredProvider ? (
							<ChatComposer
								canSend={controller.canSend && !isArchived}
								draft={controller.draft}
								isResponding={controller.isResponding}
								isStopping={controller.isStopping}
								onDraftChange={controller.setDraft}
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
