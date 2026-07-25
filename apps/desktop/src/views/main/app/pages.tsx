import type { AppIconName } from "@moshu/ui";
import { useNavigate, useParams } from "react-router-dom";
import { ChatPage } from "./chat/chat-page";
import { createRpcChatTransport } from "./chat/rpc-transport";
import { EmptyState } from "./empty-state";
import { type MessageKey, useI18n } from "./i18n";
import { desktopClient } from "../lib/rpc";

const chatTransport = createRpcChatTransport(desktopClient);

export function NewChatPage() {
	const navigate = useNavigate();

	return (
		<ChatPage
			transport={chatTransport}
			onSessionChange={(sessionId) => navigate(`/chat/${sessionId}`, { replace: true })}
		/>
	);
}

export function ChatSessionPage() {
	const { sessionId } = useParams();
	if (sessionId === undefined) {
		throw new Error("Chat session route is missing its session ID.");
	}

	return <ChatPage transport={chatTransport} sessionId={sessionId} />;
}

export function PlaceholderPage({ titleKey, icon }: { titleKey: MessageKey; icon: AppIconName }) {
	const { t } = useI18n();

	return <EmptyState icon={icon} title={t(titleKey)} description={t("page.placeholder")} />;
}
