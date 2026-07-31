import { Outlet } from "react-router-dom";
import { TabBar } from "../components/tab-bar";
import { useKeyboardInset } from "./keyboard";
import { useWorkspace, WorkspaceProvider } from "./workspace";

function ShellChrome() {
	const { pendingApprovals } = useWorkspace();
	useKeyboardInset();
	return (
		<div className="app-shell">
			<main className="min-h-0 flex-1 overflow-hidden">
				<Outlet />
			</main>
			<TabBar pendingApprovals={pendingApprovals.length} />
		</div>
	);
}

export function ConnectedShell() {
	return (
		<WorkspaceProvider>
			<ShellChrome />
		</WorkspaceProvider>
	);
}
