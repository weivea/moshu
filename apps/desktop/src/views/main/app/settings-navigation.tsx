import { AppIcon } from "@moshu/ui";
import { NavLink } from "react-router-dom";
import { useI18n } from "./i18n";

const settingsSections = [
	{ to: "/settings/profile", icon: "person", label: "settings.profile" },
	{ to: "/settings/providers", icon: "agents", label: "settings.provider" },
] as const;

export function SettingsNavigation() {
	const { t } = useI18n();

	return (
		<nav className="settings-navigation" aria-label={t("settings.navigation")}>
			{settingsSections.map((section) => (
				<NavLink
					key={section.to}
					to={section.to}
					className={({ isActive }) =>
						isActive ? "settings-navigation__item is-active" : "settings-navigation__item"
					}
				>
					<AppIcon name={section.icon} size={18} />
					<span>{t(section.label)}</span>
				</NavLink>
			))}
		</nav>
	);
}
