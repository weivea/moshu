import { createHashRouter, Navigate } from "react-router-dom";
import { NewChatPage, PlaceholderPage } from "./pages";
import { AppShell } from "./shell";

export const router = createHashRouter([
	{
		path: "/",
		element: <AppShell />,
		children: [
			{ index: true, element: <Navigate to="/chat/new" replace /> },
			{ path: "chat/new", element: <NewChatPage /> },
			{
				path: "chat/:sessionId",
				element: <PlaceholderPage titleKey="page.chats.title" icon="chat" />,
			},
			{
				path: "chats",
				element: <PlaceholderPage titleKey="page.chats.title" icon="chat" />,
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
			{ path: "settings", element: <Navigate to="/settings/general" replace /> },
			{
				path: "settings/:section",
				element: <PlaceholderPage titleKey="page.settings.title" icon="settings" />,
			},
		],
	},
]);
