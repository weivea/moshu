import { AppIcon, type AppIconName } from "@moshu/ui";
import { NavLink } from "react-router-dom";
import { useI18n } from "../app/i18n";
import type { MessageKey } from "../app/i18n";

interface TabDef {
	readonly to: string;
	readonly icon: AppIconName;
	readonly labelKey: MessageKey;
	readonly badge?: number;
}

export function TabBar({ pendingApprovals = 0 }: { pendingApprovals?: number }) {
	const { t } = useI18n();
	const tabs: readonly TabDef[] = [
		{ to: "/chats", icon: "chat", labelKey: "tab.chats" },
		{ to: "/projects", icon: "projects", labelKey: "tab.projects" },
		{ to: "/activity", icon: "notifications", labelKey: "tab.activity", badge: pendingApprovals },
		{ to: "/settings", icon: "settings", labelKey: "tab.settings" },
	];
	return (
		<nav className="tabbar" aria-label={t("app.name")}>
			{tabs.map((tab) => (
				<NavLink
					key={tab.to}
					to={tab.to}
					aria-label={t(tab.labelKey)}
					className={({ isActive }) =>
						`relative flex flex-col items-center gap-0.5 py-2 text-[0.68rem] font-medium ${
							isActive ? "text-[var(--accent)]" : "text-[var(--text-faint)]"
						}`
					}
				>
					<span className="relative">
						<AppIcon name={tab.icon} size={22} />
						{tab.badge && tab.badge > 0 ? (
							<span
								className="absolute -right-2 -top-1 min-w-4 rounded-full bg-[var(--danger)] px-1 text-center text-[0.6rem] font-bold text-white"
								aria-hidden="true"
							>
								{tab.badge > 99 ? "99+" : tab.badge}
							</span>
						) : null}
					</span>
					<span>{t(tab.labelKey)}</span>
				</NavLink>
			))}
		</nav>
	);
}
