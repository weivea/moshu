import { Button } from "@heroui/react";
import { useI18n } from "../i18n";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { ProviderSetupCard } from "./provider-setup-card";
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
}

export function ChatPage({ transport, sessionId, onSessionChange }: ChatPageProps) {
	const { t } = useI18n();
	const controller = useChatController({
		transport,
		sessionId,
		onSessionChange,
	});

	if (controller.isProviderLoading && !controller.providerStatus && !controller.providerError) {
		return (
			<section className="chat-page chat-page--centered">
				<p className="chat-loading" role="status" aria-live="polite">
					{t("chat.status.loadingProvider")}
				</p>
			</section>
		);
	}

	return (
		<section className="chat-page">
			<p className="chat-live-region" aria-live="polite">
				{controller.announcement}
			</p>

			<header className="chat-page__header">
				<div>
					<span className="chat-page__eyebrow">{t("chat.header.eyebrow")}</span>
					<h1>{t("chat.header.title")}</h1>
				</div>
				<p>{t("chat.header.description")}</p>
			</header>

			<div className="chat-meta">
				<section className="chat-card chat-card--meta">
					<div className="chat-card__header chat-card__header--compact">
						<div>
							<span className="chat-card__eyebrow">{t("chat.meta.eyebrow")}</span>
							<h2>{t("chat.meta.title")}</h2>
						</div>
					</div>
					<dl className="chat-definition-list">
						<div>
							<dt>{t("chat.meta.model")}</dt>
							<dd>{controller.meta.model}</dd>
						</div>
						<div>
							<dt>{t("chat.meta.askMode")}</dt>
							<dd>{controller.meta.askMode}</dd>
						</div>
						<div>
							<dt>{t("chat.meta.endpoint")}</dt>
							<dd>{controller.meta.endpoint}</dd>
						</div>
					</dl>
				</section>

				<section className="chat-card chat-card--meta">
					<div className="chat-card__header chat-card__header--compact">
						<div>
							<span className="chat-card__eyebrow">{t("chat.boundary.eyebrow")}</span>
							<h2>{t("chat.boundary.title")}</h2>
						</div>
					</div>
					<ul className="chat-boundary-list">
						<li>{t("chat.boundary.files")}</li>
						<li>{t("chat.boundary.commands")}</li>
						<li>{t("chat.boundary.markdown")}</li>
					</ul>
				</section>
			</div>

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

			{!controller.hasConfiguredProvider ? (
				<ProviderSetupCard
					apiKey={controller.providerDraft.apiKey}
					canSubmit={controller.canSubmitProvider}
					endpoint={controller.providerDraft.endpoint}
					errorMessage={controller.configureError}
					isLoading={controller.isConfiguring}
					model={controller.providerDraft.model}
					onApiKeyChange={(value) => controller.updateProviderField("apiKey", value)}
					onEndpointChange={(value) => controller.updateProviderField("endpoint", value)}
					onModelChange={(value) => controller.updateProviderField("model", value)}
					onSubmit={controller.configureProvider}
				/>
			) : (
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

					{controller.sessionError && sessionId ? (
						<div className="chat-notice chat-notice--danger" role="alert">
							<span>{controller.sessionError}</span>
							<Button
								className="chat-button chat-button--inline"
								onPress={controller.reloadSession}
							>
								{t("chat.action.retry")}
							</Button>
						</div>
					) : null}

					<MessageList
						isLoading={controller.isSessionLoading}
						messages={controller.session?.messages ?? []}
						sessionId={controller.session?.id ?? sessionId}
					/>
					<ChatComposer
						canSend={controller.canSend}
						draft={controller.draft}
						isResponding={controller.isResponding}
						isStopping={controller.isStopping}
						onDraftChange={controller.setDraft}
						onSend={() => void controller.sendMessage()}
						onStop={() => void controller.stopMessage()}
					/>
				</div>
			)}
		</section>
	);
}
