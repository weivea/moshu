import { Button } from "@heroui/react";
import { useNavigate } from "react-router-dom";
import type { AppIconName } from "@moshu/ui";
import { EmptyState } from "./empty-state";
import { type MessageKey, useI18n } from "./i18n";

export function NewChatPage() {
	const navigate = useNavigate();
	const { t } = useI18n();

	return (
		<section className="new-chat">
			<div className="new-chat__eyebrow">{t("app.phase")}</div>
			<h1>{t("page.newChat.title")}</h1>
			<p>{t("page.newChat.description")}</p>
			<div className="new-chat__actions">
				<Button onPress={() => navigate("/settings/providers")}>{t("action.openSettings")}</Button>
				<Button onPress={() => navigate("/projects")}>{t("action.addProject")}</Button>
			</div>
			<div className="foundation-grid">
				<FoundationCard index="01" title="Typed RPC" detail="Host ↔ WebView" />
				<FoundationCard index="02" title="Local-first" detail="Bun SQLite ports" />
				<FoundationCard index="03" title="Recoverable" detail="Deep Agents boundary" />
			</div>
		</section>
	);
}

function FoundationCard({
	index,
	title,
	detail,
}: {
	index: string;
	title: string;
	detail: string;
}) {
	return (
		<article className="foundation-card">
			<span>{index}</span>
			<strong>{title}</strong>
			<small>{detail}</small>
		</article>
	);
}

export function PlaceholderPage({ titleKey, icon }: { titleKey: MessageKey; icon: AppIconName }) {
	const { t } = useI18n();

	return <EmptyState icon={icon} title={t(titleKey)} description={t("page.placeholder")} />;
}
