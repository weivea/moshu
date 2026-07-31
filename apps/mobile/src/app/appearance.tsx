import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { readStoredTheme, type StoredTheme, writeStoredTheme } from "./preferences";

type Theme = StoredTheme;

interface AppearanceContextValue {
	theme: Theme;
	setTheme(theme: Theme): void;
	toggleTheme(): void;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

function systemTheme(): Theme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return "light";
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? systemTheme());

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		writeStoredTheme(next);
		setThemeState(next);
	}, []);

	const value = useMemo<AppearanceContextValue>(
		() => ({
			theme,
			setTheme,
			toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
		}),
		[theme, setTheme],
	);

	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
	const context = useContext(AppearanceContext);
	if (!context) {
		throw new Error("useAppearance must be used inside AppearanceProvider.");
	}
	return context;
}
