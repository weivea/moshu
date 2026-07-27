import { createContext, useContext } from "react";
import type { ChatSessionSummary } from "./chat/transport";

export interface ShellSessionUpdate {
	revision: number;
	session: ChatSessionSummary;
}

export interface AppShellContextValue {
	sessionSidebarOwned: true;
	sessionUpdate: ShellSessionUpdate | null;
	titlebarTarget: HTMLElement | null;
	setNewSessionDisabled(disabled: boolean): void;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShellContext(): AppShellContextValue | null {
	return useContext(AppShellContext);
}
