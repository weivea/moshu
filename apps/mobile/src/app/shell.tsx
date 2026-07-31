import { Outlet } from "react-router-dom";
import { TabBar } from "../components/tab-bar";
import { useAttention } from "./attention";
import { useKeyboardInset } from "./keyboard";
import { useWorkspace, WorkspaceProvider } from "./workspace";

function ShellChrome() {
	const { pendingApprovals } = useWorkspace();
	const { snapshot } = useAttention();
	useKeyboardInset();
	// The Activity badge reflects the durable, server-owned unread count when it is higher than the
	// live pending-approvals count, so unread items recovered on reconnect (including terminal runs)
	// still surface even before their business rows stream back in.
	const badge = Math.max(pendingApprovals.length, snapshot.unreadCount);
	return (
		<div className="app-shell">
			<main className="min-h-0 flex-1 overflow-hidden">
				<Outlet />
			</main>
			<TabBar pendingApprovals={badge} />
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
