import type { Language } from "../app/i18n";

const locales: Record<Language, string> = { en: "en-US", zh: "zh-CN" };

/** Compact, locale-aware timestamp for list rows. Falls back gracefully on unpar. */
export function formatTimestamp(iso: string, language: Language): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const now = Date.now();
	const sameDay = new Date(now).toDateString() === date.toDateString();
	try {
		return new Intl.DateTimeFormat(locales[language], {
			month: sameDay ? undefined : "short",
			day: sameDay ? undefined : "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(date);
	} catch {
		return date.toISOString();
	}
}
