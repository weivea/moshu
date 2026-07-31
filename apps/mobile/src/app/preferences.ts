/**
 * The ONLY values the Mobile app is allowed to persist are non-business appearance and language
 * preferences. Business data (Sessions, Projects, messages, approvals) and any binding/credential
 * material are never written here — bindings live exclusively in the native Keychain and business
 * data lives only in React memory for the lifetime of a connection. Keeping the allowed keys in one
 * tiny module makes that boundary auditable.
 */

const THEME_KEY = "moshu.appearance.theme";
const LANGUAGE_KEY = "moshu.appearance.language";

export type StoredTheme = "light" | "dark";
export type StoredLanguage = "en" | "zh";

function safeGet(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		// Storage may be unavailable (private mode / disabled). Preferences silently fall back to the
		// in-memory default; this is intentionally non-fatal.
	}
}

export function readStoredTheme(): StoredTheme | null {
	const value = safeGet(THEME_KEY);
	return value === "light" || value === "dark" ? value : null;
}

export function writeStoredTheme(theme: StoredTheme): void {
	safeSet(THEME_KEY, theme);
}

export function readStoredLanguage(): StoredLanguage | null {
	const value = safeGet(LANGUAGE_KEY);
	return value === "en" || value === "zh" ? value : null;
}

export function writeStoredLanguage(language: StoredLanguage): void {
	safeSet(LANGUAGE_KEY, language);
}
