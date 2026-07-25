import type { AppIconName } from "@moshu/ui";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChatPage } from "./chat/chat-page";
import { createRpcChatTransport } from "./chat/rpc-transport";
import { EmptyState } from "./empty-state";
import { type MessageKey, useI18n } from "./i18n";
import { ProviderSettingsPage } from "./provider-settings-page";
import { desktopClient } from "../lib/rpc";

const chatTransport = createRpcChatTransport(desktopClient);
const lastChatSessionStorageKey = "moshu.lastChatSessionId";

export function ChatHomePage() {
	const navigate = useNavigate();

	useEffect(() => {
		const lastSessionId = localStorage.getItem(lastChatSessionStorageKey);
		if (lastSessionId === null) {
			navigate("/chat/new", { replace: true });
			return;
		}

		let active = true;
		void chatTransport
			.getSession(lastSessionId)
			.then(() => {
				if (active) {
					navigate(`/chat/${lastSessionId}`, { replace: true });
				}
			})
			.catch(() => {
				if (active) {
					localStorage.removeItem(lastChatSessionStorageKey);
					navigate("/chat/new", { replace: true });
				}
			});

		return () => {
			active = false;
		};
	}, [navigate]);

	return null;
}

export function NewChatPage() {
	const navigate = useNavigate();

	useEffect(() => {
		localStorage.removeItem(lastChatSessionStorageKey);
	}, []);

	return (
		<ChatPage
			transport={chatTransport}
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

export function ChatSessionPage() {
	const { sessionId } = useParams();
	const navigate = useNavigate();
	useEffect(() => {
		if (sessionId !== undefined) {
			localStorage.setItem(lastChatSessionStorageKey, sessionId);
		}
	}, [sessionId]);

	if (sessionId === undefined) {
		throw new Error("Chat session route is missing its session ID.");
	}

	return (
		<ChatPage
			transport={chatTransport}
			sessionId={sessionId}
			onSessionChange={(nextSessionId) => navigate(`/chat/${nextSessionId}`, { replace: true })}
			onNewSession={() => navigate("/chat/new")}
			onSelectSession={(nextSessionId) => navigate(`/chat/${nextSessionId}`)}
			onOpenProviderSettings={() => navigate("/settings/providers")}
		/>
	);
}

export function ProviderSettingsRoutePage() {
	const navigate = useNavigate();

	return <ProviderSettingsPage transport={chatTransport} onBackToChat={() => navigate(-1)} />;
}

export function PlaceholderPage({ titleKey, icon }: { titleKey: MessageKey; icon: AppIconName }) {
	const { t } = useI18n();

	return <EmptyState icon={icon} title={t(titleKey)} description={t("page.placeholder")} />;
}
