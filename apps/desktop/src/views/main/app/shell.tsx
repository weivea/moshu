import { AppIcon, type AppIconName } from "@moshu/ui";
import { Button } from "@heroui/react";
import { NavLink, Outlet } from "react-router-dom";
import { useI18n, type MessageKey } from "./i18n";
import { useAppearance } from "./providers";
import { RuntimeStatus } from "./runtime-status";

const navigation = [
	{ to: "/chat/new", label: "nav.newChat", icon: "plus" },
	{ to: "/chats", label: "nav.chats", icon: "chat" },
	{ to: "/projects", label: "nav.projects", icon: "projects" },
	{ to: "/tasks", label: "nav.tasks", icon: "tasks" },
	{ to: "/agents", label: "nav.agents", icon: "agents" },
	{ to: "/canvas", label: "nav.canvas", icon: "canvas" },
	{ to: "/settings/general", label: "nav.settings", icon: "settings" },
] as const satisfies readonly {
	to: string;
	label: MessageKey;
	icon: AppIconName;
}[];

export function AppShell() {
	const { t, toggleLocale } = useI18n();
	const { toggleTheme } = useAppearance();

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<header className="brand">
					<span className="brand__mark">
						<AppIcon name="agents" size={20} />
					</span>
					<div>
						<strong>{t("app.name")}</strong>
						<small>{t("app.phase")}</small>
					</div>
				</header>

				<nav aria-label="Primary">
					{navigation.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							className={({ isActive }) => (isActive ? "nav-item is-active" : "nav-item")}
						>
							<AppIcon name={item.icon} />
							<span>{t(item.label)}</span>
						</NavLink>
					))}
				</nav>

				<footer className="sidebar__footer">
					<Button onPress={toggleTheme}>{t("action.toggleTheme")}</Button>
					<Button onPress={toggleLocale}>{t("action.toggleLanguage")}</Button>
				</footer>
			</aside>

			<main className="content">
				<Outlet />
			</main>

			<aside className="inspector">
				<RuntimeStatus />
			</aside>
		</div>
	);
}
