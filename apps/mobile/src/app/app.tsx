import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useConnection } from "./connection";
import { ConnectedShell } from "./shell";
import { ActivityScreen } from "../screens/activity";
import { ChatSessionScreen } from "../screens/chat-session";
import { ChatsScreen } from "../screens/chats";
import {
	ConnectingScreen,
	FatalErrorScreen,
	OfflineScreen,
	OnboardingScreen,
	PairingClaimingScreen,
	ScanScreen,
	SplashScreen,
	WaitingScreen,
} from "../screens/connection-screens";
import { ProjectDetailScreen, ProjectsScreen } from "../screens/projects";
import { SettingsScreen } from "../screens/settings";

function ConnectedRoutes() {
	return (
		<Routes>
			<Route element={<ConnectedShell />}>
				<Route path="/chats" element={<ChatsScreen />} />
				<Route path="/chats/:sessionId" element={<ChatSessionScreen />} />
				<Route path="/projects" element={<ProjectsScreen />} />
				<Route path="/projects/:projectId" element={<ProjectDetailScreen />} />
				<Route path="/activity" element={<ActivityScreen />} />
				<Route path="/settings" element={<SettingsScreen />} />
				<Route path="*" element={<Navigate to="/chats" replace />} />
			</Route>
		</Routes>
	);
}

/**
 * Renders exactly one root state derived from the connection state machine. Business UI (the tab
 * shell) exists ONLY while `connected`; any other state unmounts it, which is what guarantees no
 * cached business data is shown offline. Fatal states never offer a blind retry.
 */
export function App() {
	const { state } = useConnection();
	const [showScan, setShowScan] = useState(false);

	useEffect(() => {
		if (state.kind !== "unpaired") {
			setShowScan(false);
		}
	}, [state.kind]);

	switch (state.kind) {
		case "initializing":
			return <SplashScreen />;
		case "unpaired":
			return showScan ? (
				<ScanScreen onDone={() => setShowScan(false)} />
			) : (
				<OnboardingScreen onScan={() => setShowScan(true)} />
			);
		case "pairing":
			return <PairingClaimingScreen />;
		case "waiting":
			return <WaitingScreen info={state.info} />;
		case "connecting":
			return <ConnectingScreen />;
		case "reconnecting":
			return <ConnectingScreen reconnecting />;
		case "offline":
			return <OfflineScreen />;
		case "error":
			return <FatalErrorScreen code={state.code} />;
		case "connected":
			return <ConnectedRoutes />;
		default:
			return <SplashScreen />;
	}
}
