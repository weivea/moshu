import { createHashRouter, Navigate } from "react-router-dom";
import {
	ChatsPage,
	ChatHomePage,
	ChatSessionPage,
	NewChatPage,
	PlaceholderPage,
	ProviderSettingsRoutePage,
} from "./pages";
import { AppShell } from "./shell";

export const router = createHashRouter([
	{
		path: "/",
		element: <AppShell />,
		children: [
			{ index: true, element: <ChatHomePage /> },
			{ path: "chat/new", element: <NewChatPage /> },
			{
				path: "chat/:sessionId",
				element: <ChatSessionPage />,
			},
			{
				path: "chats",
				element: <ChatsPage />,
			},
			{
				path: "projects",
				element: <PlaceholderPage titleKey="page.projects.title" icon="projects" />,
			},
			{
				path: "projects/:projectId",
				element: <PlaceholderPage titleKey="page.project.title" icon="projects" />,
			},
			{
				path: "projects/:projectId/chat/new",
				element: <PlaceholderPage titleKey="page.projectChat.title" icon="chat" />,
			},
			{
				path: "projects/:projectId/chat/:sessionId",
				element: <PlaceholderPage titleKey="page.projectChat.title" icon="chat" />,
			},
			{
				path: "tasks",
				element: <PlaceholderPage titleKey="page.tasks.title" icon="tasks" />,
			},
			{
				path: "agents",
				element: <PlaceholderPage titleKey="page.agents.title" icon="agents" />,
			},
			{
				path: "agents/new",
				element: <PlaceholderPage titleKey="page.agent.title" icon="agents" />,
			},
			{
				path: "agents/:agentId",
				element: <PlaceholderPage titleKey="page.agent.title" icon="agents" />,
			},
			{
				path: "canvas",
				element: <PlaceholderPage titleKey="page.canvas.title" icon="canvas" />,
			},
			{
				path: "canvas/:canvasId",
				element: <PlaceholderPage titleKey="page.canvasDetail.title" icon="canvas" />,
			},
			{ path: "settings", element: <Navigate to="/settings/providers" replace /> },
			{
				path: "settings/providers",
				element: <ProviderSettingsRoutePage />,
			},
			{
				path: "settings/:section",
				element: <PlaceholderPage titleKey="page.settings.title" icon="settings" />,
			},
		],
	},
]);
