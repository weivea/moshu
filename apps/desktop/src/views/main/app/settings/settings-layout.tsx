import { Button } from "@heroui/react";
import { Outlet, useNavigate } from "react-router-dom";

import { useI18n } from "../i18n";
import { SettingsNavigation } from "./settings-navigation";

export function SettingsLayout() {
	const { t } = useI18n();
	const navigate = useNavigate();

	return (
		<section className="settings-page">
			<header className="settings-page__header">
				<div>
					<span className="chat-page__eyebrow">{t("settings.eyebrow")}</span>
					<h1>{t("page.settings.title")}</h1>
				</div>
				<Button className="chat-button" onPress={() => navigate(-1)}>
					{t("providers.backToChat")}
				</Button>
			</header>

			<div className="settings-page__body">
				<SettingsNavigation />
				<div className="settings-page__content">
					<Outlet />
				</div>
			</div>
		</section>
	);
}
