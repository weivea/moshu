import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { readStoredLanguage, type StoredLanguage, writeStoredLanguage } from "./preferences";

export type Language = StoredLanguage;

// English is the source of truth for the key set. The Chinese dictionary is validated for exact
// key parity by an i18n test, so a missing or extra translation fails CI rather than silently
// falling back at runtime.
const en = {
	"app.name": "墨枢 Moshu",
	"tab.chats": "Chats",
	"tab.projects": "Projects",
	"tab.activity": "Activity",
	"tab.settings": "Settings",

	"conn.connecting": "Connecting…",
	"conn.reconnecting": "Reconnecting…",
	"conn.offline.title": "You're offline",
	"conn.offline.body":
		"Moshu needs a network connection to reach your Agent Server. Reconnecting automatically.",
	"conn.offline.retry": "Try again",
	"conn.waiting.title": "Waiting for Desktop confirmation",
	"conn.waiting.body": "Approve this device on your Moshu Desktop to finish pairing.",
	"conn.waiting.device": "Device",
	"conn.waiting.fingerprint": "Server fingerprint",
	"conn.waiting.cancel": "Cancel pairing",
	"conn.preparing": "Preparing secure channel…",

	"onboarding.title": "Connect to your Agent Server",
	"onboarding.body":
		"Moshu on iPhone pairs with one Agent Server running on your Desktop. Your Desktop must be online with Remote Access enabled.",
	"onboarding.requirement.desktop": "Keep Moshu Desktop open and online",
	"onboarding.requirement.qr": "Open Settings → Mobile Access on Desktop to show a pairing QR code",
	"onboarding.requirement.single": "One iPhone binds to one Agent Server until you unpair",
	"onboarding.scan": "Scan pairing QR code",
	"onboarding.scanAgain": "Scan again",

	"scan.title": "Scan the pairing QR",
	"scan.body": "Point your camera at the QR code shown in Moshu Desktop.",
	"scan.manual": "Paste pairing code",
	"scan.manualPlaceholder": "Paste the QR payload here",
	"scan.manualSubmit": "Continue",
	"scan.cancel": "Cancel",
	"scan.cameraUnavailable": "Camera is unavailable on this device.",
	"scan.invalid": "That QR code isn't a valid Moshu pairing code.",

	"error.authRevoked.title": "This device was unpaired",
	"error.authRevoked.body": "Your Agent Server revoked this device. Pair again to reconnect.",
	"error.authFailed.title": "Authorization failed",
	"error.authFailed.body":
		"Your Agent Server refused this device's credentials. Unpair and pair again from your Desktop to reconnect.",
	"error.protocolMismatch.title": "Update required",
	"error.protocolMismatch.body":
		"This app and your Agent Server speak different protocol versions. Update both to the latest release.",
	"error.identityMismatch.title": "Server identity changed",
	"error.identityMismatch.body":
		"The Agent Server identity does not match the one you paired with. For your safety, connection was blocked. Unpair and pair again only if you trust this server.",
	"error.urlInvalid.title": "Can't reach the Agent Server",
	"error.urlInvalid.body":
		"The stored connection address is invalid. Unpair and scan a fresh QR code.",
	"error.pairingRejected.title": "Pairing was rejected",
	"error.pairingRejected.body": "Your Desktop rejected or expired this pairing request.",
	"error.unpairAction": "Unpair this device",
	"error.retry": "Retry",

	"chats.title": "Chats",
	"chats.search": "Search chats",
	"chats.new": "New chat",
	"chats.empty": "No chats yet. Start one to talk to your agent.",
	"chats.loading": "Loading chats…",
	"chats.newTitlePlaceholder": "Chat title",
	"chats.create": "Create chat",
	"chats.creating": "Creating…",
	"chats.lastActivity": "Updated {0}",
	"chats.runtimeBox": "Runtime Box",

	"chat.back": "Back to chats",
	"chat.composer.placeholder": "Message your agent…",
	"chat.composer.send": "Send",
	"chat.composer.stop": "Stop",
	"chat.composer.stopping": "Stopping…",
	"chat.composer.retryHint":
		"Last send's result is unknown. Sending again reuses the same request so it won't duplicate.",
	"chat.streaming": "Assistant is responding…",
	"chat.empty": "No messages yet. Say hello.",
	"chat.loadError": "Unable to load this chat.",
	"chat.model": "Model",
	"chat.thinking": "Thinking",
	"chat.noModel": "No model selected",
	"chat.role.user": "You",
	"chat.role.assistant": "Assistant",
	"chat.status.failed": "This response failed.",
	"chat.status.cancelled": "Stopped.",

	"approval.title": "Approval requested",
	"approval.shell": "shell [arguments hidden]",
	"approval.tool": "Tool",
	"approval.operation": "Operation",
	"approval.risk": "Risk",
	"approval.approve": "Approve once",
	"approval.reject": "Reject",
	"approval.deciding": "Submitting…",
	"approval.allowAll": "Allow all for this session",
	"approval.allowAllOn": "Allow all is on for this session",
	"approval.superseded": "Another device already decided this. Showing the final result.",
	"approval.conflict": "This approval changed. Refreshed to the latest state.",

	"projects.title": "Projects",
	"projects.empty": "No projects yet.",
	"projects.loading": "Loading projects…",
	"projects.sessions": "{0} chats",
	"projects.activeSessions": "{0} active",
	"projects.overview": "Overview",
	"projects.recentSessions": "Recent chats",
	"projects.newChat": "New project chat",
	"projects.openChat": "Open",
	"projects.noSessions": "No chats in this project yet.",
	"projects.branch": "Branch",
	"projects.path": "Path",

	"activity.title": "Activity",
	"activity.pending": "Pending approvals",
	"activity.running": "Running & recent",
	"activity.empty": "Nothing needs your attention.",
	"activity.loading": "Loading activity…",
	"activity.openSession": "Open chat",
	"activity.approve": "Approve",
	"activity.reject": "Reject",
	"activity.allowAll": "Allow all",

	"settings.title": "Settings",
	"settings.connection": "Connection",
	"settings.server": "Agent Server",
	"settings.serverFingerprint": "Server fingerprint",
	"settings.deviceFingerprint": "Device key fingerprint",
	"settings.protocol": "Protocol version",
	"settings.transport": "Transport security",
	"settings.security": "Security",
	"settings.securityNote":
		"Your device key is stored in the iOS Keychain and never leaves this iPhone. Business data is never cached; it lives only while connected.",
	"settings.softwareKey": "Software Ed25519 key (not Secure Enclave)",
	"settings.relayVisible": "Traffic transits a TLS Dev Tunnel relay",
	"settings.runtimeBox": "Runtime Box",
	"settings.runtimeBoxNote":
		"Choose which Runtime Box this device talks to. This selection is specific to this device.",
	"settings.appearance": "Appearance",
	"settings.theme": "Theme",
	"settings.theme.light": "Light",
	"settings.theme.dark": "Dark",
	"settings.language": "Language",
	"settings.language.en": "English",
	"settings.language.zh": "中文",
	"settings.unpair": "Unpair this device",
	"settings.unpair.title": "Unpair this device?",
	"settings.unpair.body":
		"This deletes the device key and connection binding from this iPhone. You'll need to scan a new QR code to reconnect.",
	"settings.unpair.confirm": "Unpair",
	"settings.unpair.cancel": "Keep paired",
	"settings.unpairing": "Unpairing…",

	"settings.notifications": "Notifications",
	"settings.notifications.toggle": "Local notifications",
	"settings.notifications.note":
		"Best effort only. Moshu never uses a cloud push service. You'll only be alerted while the app is open or briefly in the background; suspended or closed, you won't get a notification, but unread items are restored from your Agent Server on reconnect.",
	"settings.notifications.enable": "Enable notifications",
	"settings.notifications.status.granted": "Enabled",
	"settings.notifications.status.denied": "Blocked in iOS Settings",
	"settings.notifications.status.prompt": "Not yet enabled",
	"settings.notifications.status.unavailable": "Unavailable on this device",
	"settings.notifications.deniedHint":
		"Turn on notifications for Moshu in iOS Settings to receive alerts.",

	"notification.attention.title": "墨枢 Moshu",
	"notification.attention.body": "You have new activity that needs your attention.",

	"common.cancel": "Cancel",
	"common.retry": "Retry",
	"common.loading": "Loading…",
	"common.none": "—",
	"common.error": "Something went wrong.",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
	"app.name": "墨枢 Moshu",
	"tab.chats": "对话",
	"tab.projects": "项目",
	"tab.activity": "动态",
	"tab.settings": "设置",

	"conn.connecting": "连接中…",
	"conn.reconnecting": "重新连接中…",
	"conn.offline.title": "当前离线",
	"conn.offline.body": "墨枢需要网络连接才能访问你的 Agent Server，正在自动重连。",
	"conn.offline.retry": "重试",
	"conn.waiting.title": "等待桌面端确认",
	"conn.waiting.body": "请在墨枢桌面端批准此设备以完成配对。",
	"conn.waiting.device": "设备",
	"conn.waiting.fingerprint": "服务器指纹",
	"conn.waiting.cancel": "取消配对",
	"conn.preparing": "正在建立安全通道…",

	"onboarding.title": "连接到你的 Agent Server",
	"onboarding.body":
		"iPhone 上的墨枢会与桌面端运行的一个 Agent Server 配对。桌面端必须在线并已启用远程访问。",
	"onboarding.requirement.desktop": "保持墨枢桌面端打开并在线",
	"onboarding.requirement.qr": "在桌面端打开 设置 → 移动接入 以显示配对二维码",
	"onboarding.requirement.single": "一台 iPhone 在解绑前只绑定一个 Agent Server",
	"onboarding.scan": "扫描配对二维码",
	"onboarding.scanAgain": "重新扫描",

	"scan.title": "扫描配对二维码",
	"scan.body": "将摄像头对准墨枢桌面端显示的二维码。",
	"scan.manual": "粘贴配对码",
	"scan.manualPlaceholder": "在此粘贴二维码内容",
	"scan.manualSubmit": "继续",
	"scan.cancel": "取消",
	"scan.cameraUnavailable": "此设备无法使用摄像头。",
	"scan.invalid": "该二维码不是有效的墨枢配对码。",

	"error.authRevoked.title": "此设备已被解绑",
	"error.authRevoked.body": "你的 Agent Server 已吊销此设备。请重新配对以连接。",
	"error.authFailed.title": "授权失败",
	"error.authFailed.body": "你的 Agent Server 拒绝了此设备的凭据。请在桌面端解绑并重新配对以连接。",
	"error.protocolMismatch.title": "需要更新",
	"error.protocolMismatch.body":
		"此应用与 Agent Server 的协议版本不一致，请将两端都更新到最新版本。",
	"error.identityMismatch.title": "服务器身份已变更",
	"error.identityMismatch.body":
		"Agent Server 身份与配对时不一致。出于安全考虑已阻止连接。仅在你信任该服务器时才解绑并重新配对。",
	"error.urlInvalid.title": "无法访问 Agent Server",
	"error.urlInvalid.body": "已保存的连接地址无效。请解绑并扫描新的二维码。",
	"error.pairingRejected.title": "配对被拒绝",
	"error.pairingRejected.body": "桌面端拒绝了此配对请求或请求已过期。",
	"error.unpairAction": "解绑此设备",
	"error.retry": "重试",

	"chats.title": "对话",
	"chats.search": "搜索对话",
	"chats.new": "新建对话",
	"chats.empty": "还没有对话。开始一个与你的智能体交流吧。",
	"chats.loading": "正在加载对话…",
	"chats.newTitlePlaceholder": "对话标题",
	"chats.create": "创建对话",
	"chats.creating": "创建中…",
	"chats.lastActivity": "更新于 {0}",
	"chats.runtimeBox": "Runtime Box",

	"chat.back": "返回对话列表",
	"chat.composer.placeholder": "给你的智能体发消息…",
	"chat.composer.send": "发送",
	"chat.composer.stop": "停止",
	"chat.composer.stopping": "停止中…",
	"chat.composer.retryHint": "上一条发送结果未知。再次发送会复用同一请求，不会重复创建。",
	"chat.streaming": "智能体正在回复…",
	"chat.empty": "还没有消息，打个招呼吧。",
	"chat.loadError": "无法加载此对话。",
	"chat.model": "模型",
	"chat.thinking": "思考",
	"chat.noModel": "未选择模型",
	"chat.role.user": "你",
	"chat.role.assistant": "智能体",
	"chat.status.failed": "该回复失败了。",
	"chat.status.cancelled": "已停止。",

	"approval.title": "请求审批",
	"approval.shell": "shell [参数已隐藏]",
	"approval.tool": "工具",
	"approval.operation": "操作",
	"approval.risk": "风险",
	"approval.approve": "批准一次",
	"approval.reject": "拒绝",
	"approval.deciding": "提交中…",
	"approval.allowAll": "本会话全部允许",
	"approval.allowAllOn": "本会话已开启全部允许",
	"approval.superseded": "另一台设备已处理该审批，显示最终结果。",
	"approval.conflict": "该审批已变化，已刷新到最新状态。",

	"projects.title": "项目",
	"projects.empty": "还没有项目。",
	"projects.loading": "正在加载项目…",
	"projects.sessions": "{0} 个对话",
	"projects.activeSessions": "{0} 个进行中",
	"projects.overview": "概览",
	"projects.recentSessions": "最近对话",
	"projects.newChat": "新建项目对话",
	"projects.openChat": "打开",
	"projects.noSessions": "此项目还没有对话。",
	"projects.branch": "分支",
	"projects.path": "路径",

	"activity.title": "动态",
	"activity.pending": "待审批",
	"activity.running": "运行中与最近",
	"activity.empty": "暂无需要处理的事项。",
	"activity.loading": "正在加载动态…",
	"activity.openSession": "打开对话",
	"activity.approve": "批准",
	"activity.reject": "拒绝",
	"activity.allowAll": "全部允许",

	"settings.title": "设置",
	"settings.connection": "连接",
	"settings.server": "Agent Server",
	"settings.serverFingerprint": "服务器指纹",
	"settings.deviceFingerprint": "设备密钥指纹",
	"settings.protocol": "协议版本",
	"settings.transport": "传输安全",
	"settings.security": "安全",
	"settings.securityNote":
		"你的设备密钥保存在 iOS 钥匙串中，绝不会离开这台 iPhone。业务数据从不缓存，仅在连接期间存在。",
	"settings.softwareKey": "软件 Ed25519 密钥（非安全隔区）",
	"settings.relayVisible": "流量经由 TLS Dev Tunnel 中继",
	"settings.runtimeBox": "Runtime Box",
	"settings.runtimeBoxNote": "选择此设备连接的 Runtime Box。该选择仅对本设备生效。",
	"settings.appearance": "外观",
	"settings.theme": "主题",
	"settings.theme.light": "浅色",
	"settings.theme.dark": "深色",
	"settings.language": "语言",
	"settings.language.en": "English",
	"settings.language.zh": "中文",
	"settings.unpair": "解绑此设备",
	"settings.unpair.title": "解绑此设备？",
	"settings.unpair.body":
		"这将从此 iPhone 删除设备密钥和连接绑定。你需要扫描新的二维码才能重新连接。",
	"settings.unpair.confirm": "解绑",
	"settings.unpair.cancel": "保持绑定",
	"settings.unpairing": "解绑中…",

	"settings.notifications": "通知",
	"settings.notifications.toggle": "本地通知",
	"settings.notifications.note":
		"仅尽力而为。墨枢从不使用云推送服务。只有在应用打开或短暂后台时才可能收到提醒；应用被挂起或关闭时不会收到通知，但重新连接后会从 Agent Server 恢复未读项。",
	"settings.notifications.enable": "开启通知",
	"settings.notifications.status.granted": "已开启",
	"settings.notifications.status.denied": "已在 iOS 设置中被禁用",
	"settings.notifications.status.prompt": "尚未开启",
	"settings.notifications.status.unavailable": "此设备不可用",
	"settings.notifications.deniedHint": "请在 iOS 设置中为墨枢开启通知以接收提醒。",

	"notification.attention.title": "墨枢 Moshu",
	"notification.attention.body": "有新的动态需要你处理。",

	"common.cancel": "取消",
	"common.retry": "重试",
	"common.loading": "加载中…",
	"common.none": "—",
	"common.error": "出错了。",
};

export const messagesByLanguage: Record<Language, Record<MessageKey, string>> = { en, zh };

function format(template: string, args: readonly (string | number)[]): string {
	if (args.length === 0) {
		return template;
	}
	return template.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? match : String(value);
	});
}

export type TranslateFn = (key: MessageKey, ...args: (string | number)[]) => string;

interface I18nContextValue {
	language: Language;
	setLanguage(language: Language): void;
	t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function defaultLanguage(): Language {
	const stored = readStoredLanguage();
	if (stored) {
		return stored;
	}
	if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh")) {
		return "zh";
	}
	return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [language, setLanguageState] = useState<Language>(defaultLanguage);

	const setLanguage = useCallback((next: Language) => {
		writeStoredLanguage(next);
		setLanguageState(next);
	}, []);

	const t = useCallback<TranslateFn>(
		(key, ...args) => format(messagesByLanguage[language][key] ?? en[key], args),
		[language],
	);

	const value = useMemo<I18nContextValue>(
		() => ({ language, setLanguage, t }),
		[language, setLanguage, t],
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
