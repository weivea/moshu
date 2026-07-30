import type { Project, ProjectSidebarSummary } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { desktopClient } from "../../lib/rpc";
import { chatTransport } from "../chat/rpc-chat-transport";
import { useChatSessionRecovery } from "../chat/session-recovery-coordinator";
import type { ChatTransport } from "../chat/transport";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";
import { useProjectData } from "./project-data";
import { errorMessage, ProjectDeleteDialog } from "./project-shared";
import { useProjectQuery } from "./use-project-query";

const expandedProjectsStoragePrefix = "moshu.projects.expanded.v1.";

export function ProjectsSidebar({
	refreshKey,
	onAdd,
	transport = chatTransport,
}: {
	refreshKey: string;
	onAdd(): void;
	transport?: ChatTransport;
}) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const runtimeBoxes = useRuntimeBoxes();
	const { getRuntimeRevision, invalidateProject, invalidateRuntime } = useProjectData();
	const { coordinator: sessionRecoveryCoordinator } = useChatSessionRecovery(transport, undefined);
	const runtimeBoxId = runtimeBoxes.snapshot.active.runtimeBoxId;
	const runtimeRevision = getRuntimeRevision(runtimeBoxId);
	const [expandedIds, setExpandedIds] = useState<Set<string>>(() => readExpanded(runtimeBoxId));
	const [menuProjectId, setMenuProjectId] = useState<string>();
	const [deleteProjectId, setDeleteProjectId] = useState<string>();
	const [pendingProjectId, setPendingProjectId] = useState<string>();
	const [mutationError, setMutationError] = useState<string>();
	const load = useCallback(() => desktopClient.getProjectSidebar(runtimeBoxId), [runtimeBoxId]);
	const query = useProjectQuery(`${refreshKey}:${runtimeBoxId}:${runtimeRevision}`, load, {
		retainData: true,
	});

	useEffect(() => {
		setExpandedIds(readExpanded(runtimeBoxId));
	}, [runtimeBoxId]);

	useEffect(
		() =>
			sessionRecoveryCoordinator.subscribeRetirements(() => {
				invalidateRuntime(runtimeBoxId);
			}),
		[invalidateRuntime, runtimeBoxId, sessionRecoveryCoordinator],
	);

	const toggleExpanded = (projectId: string) => {
		setExpandedIds((current) => {
			const next = new Set(current);
			if (next.has(projectId)) {
				next.delete(projectId);
			} else {
				next.add(projectId);
			}
			localStorage.setItem(
				`${expandedProjectsStoragePrefix}${runtimeBoxId}`,
				JSON.stringify([...next]),
			);
			return next;
		});
	};

	const openProject = (summary: ProjectSidebarSummary) => {
		if (summary.project.archivedAt !== undefined) {
			navigate(`/projects/${summary.project.id}`);
			return;
		}
		const latest = summary.recentSessions[0];
		navigate(
			latest === undefined
				? `/projects/${summary.project.id}/chat/new`
				: `/projects/${summary.project.id}/chat/${latest.id}`,
		);
	};

	const archive = async (project: Project) => {
		setPendingProjectId(project.id);
		setMutationError(undefined);
		try {
			await desktopClient.setProjectArchived({ projectId: project.id, archived: true });
			invalidateProject(project.id, project.runtimeBoxId);
			await query.reload();
		} catch (caught) {
			setMutationError(errorMessage(caught, t("projects.error.update")));
		} finally {
			setPendingProjectId(undefined);
			setMenuProjectId(undefined);
		}
	};

	return (
		<section className="projects-sidebar" aria-labelledby="projects-sidebar-title">
			<header>
				<h2 id="projects-sidebar-title">{t("nav.projects")}</h2>
				<div>
					<Link to="/projects" className="projects-sidebar__all">
						{t("projects.viewAll")}
					</Link>
					<button
						type="button"
						aria-label={t("action.addProject")}
						title={t("action.addProject")}
						disabled={!runtimeBoxes.isActiveReady}
						onClick={onAdd}
					>
						<AppIcon name="plus" size={17} />
					</button>
				</div>
			</header>
			{mutationError || query.error ? (
				<div className="projects-sidebar__error" role="alert">
					<span>{mutationError ?? query.error?.message ?? t("projects.error.load")}</span>
					<button type="button" onClick={() => void query.reload()}>
						{t("chat.action.retry")}
					</button>
				</div>
			) : query.isLoading && query.data === undefined ? (
				<p className="projects-sidebar__empty" role="status">
					{t("projects.loading")}
				</p>
			) : query.data?.items.length === 0 ? (
				<p className="projects-sidebar__empty">{t("projects.empty")}</p>
			) : (
				<ul className="projects-sidebar__list">
					{query.data?.items.map((summary) => {
						const project = summary.project;
						const expanded = expandedIds.has(project.id);
						return (
							<li className="project-tree-item" key={project.id}>
								<div className="project-tree-item__row">
									<button
										type="button"
										className="project-tree-item__expand"
										aria-label={t(expanded ? "projects.collapse" : "projects.expand", project.name)}
										aria-expanded={expanded}
										onClick={() => toggleExpanded(project.id)}
									>
										<AppIcon name={expanded ? "collapse" : "forward"} size={14} />
									</button>
									<button
										type="button"
										className="project-tree-item__name"
										onClick={() => openProject(summary)}
									>
										<AppIcon name="projects" size={16} />
										<span>{project.name}</span>
									</button>
									<button
										type="button"
										className="project-tree-item__menu"
										aria-label={t("projects.actions", project.name)}
										aria-expanded={menuProjectId === project.id}
										aria-haspopup="menu"
										onClick={() =>
											setMenuProjectId((current) =>
												current === project.id ? undefined : project.id,
											)
										}
									>
										<AppIcon name="menu" size={15} />
									</button>
									{menuProjectId === project.id ? (
										<div
											className="project-menu__popover project-menu__popover--sidebar"
											role="menu"
										>
											<Link role="menuitem" to={`/projects/${project.id}/settings`}>
												{t("projects.edit")}
											</Link>
											<button
												type="button"
												role="menuitem"
												disabled={pendingProjectId !== undefined}
												onClick={() => void archive(project)}
											>
												{t("projects.archive")}
											</button>
											<ProjectDeleteDialog
												project={project}
												isOpen={deleteProjectId === project.id}
												onOpenChange={(open) => setDeleteProjectId(open ? project.id : undefined)}
												onDeletionRequested={() => {
													invalidateProject(project.id, project.runtimeBoxId);
													setMenuProjectId(undefined);
													void query.reload();
												}}
												trigger={t("projects.delete")}
												triggerClassName="project-menu__danger"
												triggerRole="menuitem"
											/>
										</div>
									) : null}
								</div>
								{expanded ? (
									<ul className="project-tree-sessions">
										{summary.recentSessions.map((session) => (
											<li key={session.id}>
												<Link to={`/projects/${project.id}/chat/${session.id}`}>
													<AppIcon name="chat" size={14} />
													<span>{session.title}</span>
												</Link>
											</li>
										))}
										{summary.activeSessionCount === 0 ? (
											<li className="project-tree-sessions__empty">{t("sessions.empty.active")}</li>
										) : null}
										<li>
											<Link className="project-tree-sessions__all" to={`/projects/${project.id}`}>
												{t("projects.viewAllSessions", String(summary.activeSessionCount))}
											</Link>
										</li>
									</ul>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function readExpanded(runtimeBoxId: string): Set<string> {
	try {
		const stored = JSON.parse(
			localStorage.getItem(`${expandedProjectsStoragePrefix}${runtimeBoxId}`) ?? "[]",
		);
		return new Set(
			Array.isArray(stored)
				? stored.filter((value): value is string => typeof value === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}
