import { AppIcon, type AppIconName } from "@moshu/ui";
import { NavLink } from "react-router-dom";

import { type MessageKey, useI18n } from "../i18n";

const settingsGroups = [
	{
		label: "settings.group.application",
		items: [
			{ to: "/settings/general", icon: "person", label: "settings.general" },
			{ to: "/settings/runtime-boxes", icon: "terminal", label: "settings.runtimeBoxes" },
			{ to: "/settings/mobile-access", icon: "smartphone", label: "settings.mobileAccess" },
			{ to: "/settings/usage", icon: "tasks", label: "settings.usage" },
			{ to: "/settings/security", icon: "globe", label: "settings.security" },
		],
	},
	{
		label: "settings.group.extensions",
		items: [
			{ to: "/settings/mcp", icon: "terminal", label: "settings.mcp" },
			{ to: "/settings/skills", icon: "automations", label: "settings.skills" },
		],
	},
	{
		label: "settings.group.models",
		items: [
			{ to: "/settings/providers", icon: "agents", label: "settings.providers" },
			{ to: "/settings/default-model", icon: "check", label: "settings.defaultModel" },
		],
	},
] as const satisfies readonly {
	label: MessageKey;
	items: readonly { to: string; icon: AppIconName; label: MessageKey }[];
}[];

export function SettingsNavigation() {
	const { t } = useI18n();

	return (
		<nav className="settings-navigation" aria-label={t("settings.navigation")}>
			{settingsGroups.map((group) => (
				<div className="settings-navigation__group" key={group.label}>
					<span className="settings-navigation__group-label">{t(group.label)}</span>
					{group.items.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							className={({ isActive }) =>
								isActive ? "settings-navigation__item is-active" : "settings-navigation__item"
							}
						>
							<AppIcon name={item.icon} size={18} />
							<span>{t(item.label)}</span>
						</NavLink>
					))}
				</div>
			))}
		</nav>
	);
}
