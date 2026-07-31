import type { ChatSession, ProjectSidebarSummary } from "@moshu/contracts";
import { Button } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useConnectedSession } from "../app/connection";
import { useI18n } from "../app/i18n";
import { useWorkspace } from "../app/workspace";
import {
	CenteredState,
	EmptyRow,
	LoadingState,
	Screen,
	ScreenHeader,
	ScrollArea,
} from "../components/layout";
import { formatTimestamp } from "../lib/format";
import { newUuid } from "../lib/uuid";

export function ProjectsScreen() {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { client } = useConnectedSession();
	const { activeRuntimeBoxId } = useWorkspace();
	const [items, setItems] = useState<ProjectSidebarSummary[] | null>(null);
	const mounted = useRef(true);

	const load = useCallback(async () => {
		if (!activeRuntimeBoxId) {
			return;
		}
		const result = await client.getProjectSidebar({ runtimeBoxId: activeRuntimeBoxId });
		if (mounted.current) {
			setItems([...result.items]);
		}
	}, [client, activeRuntimeBoxId]);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	return (
		<Screen>
			<ScreenHeader title={t("projects.title")} />
			<ScrollArea>
				{items === null ? (
					<LoadingState label={t("projects.loading")} />
				) : items.length === 0 ? (
					<EmptyRow label={t("projects.empty")} />
				) : (
					<ul>
						{items.map((item) => (
							<li key={item.project.id}>
								<button
									type="button"
									className="list-row"
									onClick={() => navigate(`/projects/${item.project.id}`)}
								>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="projects" size={20} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-[var(--text)]">
											{item.project.name}
										</span>
										<span className="block truncate text-xs text-[var(--text-muted)]">
											{t("projects.activeSessions", item.activeSessionCount)}
										</span>
									</span>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="forward" size={18} />
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</ScrollArea>
		</Screen>
	);
}

export function ProjectDetailScreen() {
	const { projectId = "" } = useParams();
	const { t, language } = useI18n();
	const navigate = useNavigate();
	const { client } = useConnectedSession();
	const [name, setName] = useState<string | null>(null);
	const [runtimeBoxId, setRuntimeBoxId] = useState<string | null>(null);
	const [branch, setBranch] = useState<string | undefined>(undefined);
	const [sessions, setSessions] = useState<ChatSession[] | null>(null);
	const [creating, setCreating] = useState(false);
	const mounted = useRef(true);

	const load = useCallback(async () => {
		const [project, sessionList] = await Promise.all([
			client.getProject(projectId),
			client.listSessions({ scope: { kind: "project", projectId } }),
		]);
		if (!mounted.current) {
			return;
		}
		setName(project.project.name);
		setRuntimeBoxId(project.project.runtimeBoxId);
		setBranch(project.project.gitBranch);
		setSessions([...sessionList.items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
	}, [client, projectId]);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	async function createChat(): Promise<void> {
		if (!runtimeBoxId || !name) {
			return;
		}
		setCreating(true);
		try {
			const result = await client.createSession({
				schemaVersion: 1,
				title: name,
				defaultMode: "agent",
				createKey: newUuid(),
				runtimeBoxId,
				projectId,
			});
			navigate(`/chats/${result.session.id}`);
		} finally {
			setCreating(false);
		}
	}

	if (name === null || sessions === null) {
		return <LoadingState label={t("projects.loading")} />;
	}

	return (
		<Screen>
			<ScreenHeader
				title={name}
				subtitle={branch ? `${t("projects.branch")}: ${branch}` : undefined}
				leading={
					<Button
						variant="ghost"
						size="sm"
						isIconOnly
						aria-label={t("projects.title")}
						onPress={() => navigate("/projects")}
					>
						<AppIcon name="back" size={22} />
					</Button>
				}
			/>
			<ScrollArea>
				<div className="p-4">
					<Button variant="primary" fullWidth isDisabled={creating} onPress={() => void createChat()}>
						{t("projects.newChat")}
					</Button>
				</div>
				<p className="section-label">{t("projects.recentSessions")}</p>
				{sessions.length === 0 ? (
					<EmptyRow label={t("projects.noSessions")} />
				) : (
					<ul>
						{sessions.map((session) => (
							<li key={session.id}>
								<button
									type="button"
									className="list-row"
									onClick={() => navigate(`/chats/${session.id}`)}
								>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="chat" size={20} />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-[var(--text)]">
											{session.title}
										</span>
										<span className="block truncate text-xs text-[var(--text-muted)]">
											{formatTimestamp(session.updatedAt, language)}
										</span>
									</span>
									<span className="text-[var(--text-faint)]">
										<AppIcon name="forward" size={18} />
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</ScrollArea>
		</Screen>
	);
}

export function ProjectMissingScreen() {
	const { t } = useI18n();
	return <CenteredState title={t("projects.empty")} />;
}
