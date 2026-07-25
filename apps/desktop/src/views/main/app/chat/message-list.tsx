import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import type { ChatMessage } from "./transport";

export interface MessageListProps {
	isLoading: boolean;
	messages: ChatMessage[];
	sessionId?: string;
}

export function MessageList({ isLoading, messages, sessionId }: MessageListProps) {
	const { t } = useI18n();
	const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		scrollAnchorRef.current?.scrollIntoView({ block: "end" });
	});

	return (
		<section className="chat-card chat-card--transcript">
			<div className="chat-card__header chat-card__header--compact">
				<div>
					<span className="chat-card__eyebrow">{t("chat.transcript.eyebrow")}</span>
					<h2>{t("chat.transcript.title")}</h2>
				</div>
				{sessionId ? <p>{t("chat.transcript.sessionLabel", sessionId)}</p> : null}
			</div>

			<div className="chat-transcript" aria-live="polite">
				{isLoading ? (
					<div className="chat-empty">
						<strong>{t("chat.transcript.loading")}</strong>
						<p>{t("chat.transcript.loadingDetail")}</p>
					</div>
				) : messages.length === 0 ? (
					<div className="chat-empty">
						<strong>{t("chat.transcript.emptyTitle")}</strong>
						<p>{t("chat.transcript.emptyDescription")}</p>
					</div>
				) : (
					<>
						<ul className="chat-message-list">
							{messages.map((message) => (
								<li key={message.id} className={`chat-message chat-message--${message.role}`}>
									<header className="chat-message__header">
										<strong>
											{message.role === "user"
												? t("chat.message.user")
												: t("chat.message.assistant")}
										</strong>
										{message.role === "assistant" && message.status ? (
											<span
												className={`chat-message__status chat-message__status--${message.status}`}
											>
												{formatStatusLabel(message.status, t)}
											</span>
										) : null}
									</header>
									<p className="chat-message__content">
										{message.content || t("chat.message.waiting")}
									</p>
									{message.role === "assistant" && message.errorMessage ? (
										<p className="chat-message__detail">{message.errorMessage}</p>
									) : null}
								</li>
							))}
						</ul>
						<div ref={scrollAnchorRef} />
					</>
				)}
			</div>
		</section>
	);
}

function formatStatusLabel(
	status: NonNullable<ChatMessage["status"]>,
	t: ReturnType<typeof useI18n>["t"],
) {
	switch (status) {
		case "streaming":
			return t("chat.message.streaming");
		case "completed":
			return t("chat.message.completed");
		case "cancelled":
			return t("chat.message.cancelled");
		case "error":
			return t("chat.message.error");
	}
}
