import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";

interface AppearanceContextValue {
	theme: Theme;
	toggleTheme(): void;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

function systemTheme(): Theme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
	const [theme, setTheme] = useState<Theme>(systemTheme);

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	const value = useMemo(
		() => ({
			theme,
			toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
		}),
		[theme],
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
