import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

const messages = {
	en: {
		"app.name": "墨枢",
		"app.phase": "Phase 0 foundation",
		"nav.newChat": "New Chat",
		"nav.chats": "Chats",
		"nav.projects": "Projects",
		"nav.tasks": "Tasks",
		"nav.agents": "Agents",
		"nav.canvas": "Canvas",
		"nav.settings": "Settings",
		"page.newChat.title": "What should the agent help with?",
		"page.newChat.description":
			"Configure a provider next, then start a normal chat or connect a local project.",
		"page.chats.title": "Chats",
		"page.projects.title": "Projects",
		"page.project.title": "Project overview",
		"page.projectChat.title": "Project chat",
		"page.tasks.title": "Task center",
		"page.agents.title": "Agents",
		"page.agent.title": "Agent details",
		"page.canvas.title": "Canvas",
		"page.canvasDetail.title": "Canvas details",
		"page.settings.title": "Settings",
		"page.placeholder": "This route is wired and ready for its Phase 1 vertical slice.",
		"action.addProject": "Add a project",
		"action.openSettings": "Configure provider",
		"action.toggleTheme": "Toggle theme",
		"action.toggleLanguage": "切换中文",
		"runtime.title": "Runtime status",
		"runtime.checking": "Checking application host…",
		"runtime.ready": "Host connected",
		"runtime.failed": "Host unavailable",
		"runtime.electrobun": "Electrobun",
		"runtime.bun": "Bun runtime",
		"runtime.deepAgents": "Deep Agents",
		"runtime.channel": "Channel",
		"runtime.retry": "Retry",
	},
	"zh-CN": {
		"app.name": "墨枢",
		"app.phase": "Phase 0 工程底座",
		"nav.newChat": "新对话",
		"nav.chats": "会话",
		"nav.projects": "项目",
		"nav.tasks": "任务",
		"nav.agents": "Agent",
		"nav.canvas": "Canvas",
		"nav.settings": "设置",
		"page.newChat.title": "今天想让 Agent 帮你做什么？",
		"page.newChat.description": "下一步配置模型 Provider，然后开始普通对话或连接本地项目。",
		"page.chats.title": "会话",
		"page.projects.title": "项目",
		"page.project.title": "项目概览",
		"page.projectChat.title": "项目会话",
		"page.tasks.title": "任务中心",
		"page.agents.title": "Agent",
		"page.agent.title": "Agent 详情",
		"page.canvas.title": "Canvas",
		"page.canvasDetail.title": "Canvas 详情",
		"page.settings.title": "设置",
		"page.placeholder": "路由已接通，可在对应 Phase 1 垂直切片中继续实现。",
		"action.addProject": "添加项目",
		"action.openSettings": "配置 Provider",
		"action.toggleTheme": "切换主题",
		"action.toggleLanguage": "Switch to English",
		"runtime.title": "运行时状态",
		"runtime.checking": "正在连接 Application Host…",
		"runtime.ready": "Host 已连接",
		"runtime.failed": "Host 不可用",
		"runtime.electrobun": "Electrobun",
		"runtime.bun": "Bun runtime",
		"runtime.deepAgents": "Deep Agents",
		"runtime.channel": "更新通道",
		"runtime.retry": "重试",
	},
} as const;

export type Locale = keyof typeof messages;
export type MessageKey = keyof (typeof messages)["en"];

interface I18nContextValue {
	locale: Locale;
	t(key: MessageKey): string;
	toggleLocale(): void;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function resolveLocale(language: string): Locale {
	return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocale] = useState<Locale>(() => resolveLocale(navigator.language));

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const value = useMemo<I18nContextValue>(
		() => ({
			locale,
			t: (key) => messages[locale][key],
			toggleLocale: () => setLocale((current) => (current === "en" ? "zh-CN" : "en")),
		}),
		[locale],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const context = useContext(I18nContext);
	if (!context) {
		throw new Error("useI18n must be used inside I18nProvider.");
	}
	return context;
}
