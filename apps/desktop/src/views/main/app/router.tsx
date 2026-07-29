import { createHashRouter, Navigate } from "react-router-dom";
import {
	ChatHomePage,
	ChatSessionPage,
	ChatsPage,
	DefaultModelSettingsRoutePage,
	GeneralSettingsRoutePage,
	NewChatPage,
	PlaceholderPage,
	ProviderSettingsRoutePage,
	RuntimeBoxesSettingsRoutePage,
	ProjectDetailRoutePage,
	ProjectsRoutePage,
	SettingsPlaceholderPage,
} from "./pages";
import { SettingsLayout } from "./settings/settings-layout";
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
				element: <ProjectsRoutePage />,
			},
			{
				path: "projects/:projectId",
				element: <ProjectDetailRoutePage />,
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
			{
				path: "settings",
				element: <SettingsLayout />,
				children: [
					{ index: true, element: <Navigate to="/settings/providers" replace /> },
					{ path: "providers", element: <ProviderSettingsRoutePage /> },
					{ path: "default-model", element: <DefaultModelSettingsRoutePage /> },
					{ path: "general", element: <GeneralSettingsRoutePage /> },
					{ path: "runtime-boxes", element: <RuntimeBoxesSettingsRoutePage /> },
					{ path: ":section", element: <SettingsPlaceholderPage /> },
				],
			},
		],
	},
]);
