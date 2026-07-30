import { Button } from "@heroui/react";
import type { Project } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";
import { ProjectAdd } from "./project-add";
import { useProjectData } from "./project-data";
import { errorMessage, ProjectDeleteDialog, ProjectStatus } from "./project-shared";
import { useProjectQuery } from "./use-project-query";

export function ProjectsListPage() {
	const { t } = useI18n();
	const runtimeBoxes = useRuntimeBoxes();
	const projectData = useProjectData();
	const [showArchived, setShowArchived] = useState(false);
	const [pendingProjectId, setPendingProjectId] = useState<string>();
	const [menuProjectId, setMenuProjectId] = useState<string>();
	const [deleteProjectId, setDeleteProjectId] = useState<string>();
	const [mutationError, setMutationError] = useState<string>();
	const [deletionNotice, setDeletionNotice] = useState<string>();
	const runtimeBoxId = runtimeBoxes.snapshot.active.runtimeBoxId;
	const runtimeRevision = projectData.getRuntimeRevision(runtimeBoxId);
	const load = useCallback(
		() => desktopClient.listProjects({ runtimeBoxId, archived: showArchived }),
		[runtimeBoxId, showArchived],
	);
	const query = useProjectQuery(
		`${runtimeBoxId}:${runtimeBoxes.snapshot.active.revision}:${runtimeRevision}:${showArchived}`,
		load,
	);
	const projects = [...(query.data?.items ?? [])].sort(
		(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
	);

	const setArchived = async (project: Project) => {
		setPendingProjectId(project.id);
		setMutationError(undefined);
		try {
			await desktopClient.setProjectArchived({
				projectId: project.id,
				archived: project.archivedAt === undefined,
			});
			projectData.invalidateProject(project.id, project.runtimeBoxId);
			await query.reload();
		} catch (caught) {
			setMutationError(errorMessage(caught, t("projects.error.update")));
		} finally {
			setPendingProjectId(undefined);
			setMenuProjectId(undefined);
		}
	};

	return (
		<section className="projects-page">
			<header className="projects-page__header">
				<div>
					<h1>{t("page.projects.title")}</h1>
					<p>
						{t(runtimeBoxes.isActiveReady ? "projects.description" : "projects.offlineDescription")}
					</p>
				</div>
				<fieldset className="projects-page__filters">
					<legend className="chat-live-region">{t("projects.filter")}</legend>
					<Button
						className={showArchived ? "chat-button" : "chat-button is-active"}
						onPress={() => setShowArchived(false)}
					>
						{t("sessions.filter.active")}
					</Button>
					<Button
						className={showArchived ? "chat-button is-active" : "chat-button"}
						onPress={() => setShowArchived(true)}
					>
						{t("sessions.filter.archived")}
					</Button>
				</fieldset>
			</header>

			{!showArchived ? (
				<ProjectAdd
					runtimeBox={runtimeBoxes.activeBox}
					isRuntimeReady={runtimeBoxes.isActiveReady}
					onCreated={(project) => {
						projectData.invalidateRuntime(project.runtimeBoxId);
						void query.reload();
					}}
				/>
			) : null}

			{deletionNotice ? (
				<p className="project-form-notice" role="status">
					{deletionNotice}
				</p>
			) : null}
			{mutationError || query.error ? (
				<div className="project-error-state" role="alert">
					<span>{mutationError ?? query.error?.message ?? t("projects.error.load")}</span>
					<Button className="chat-button chat-button--inline" onPress={() => void query.reload()}>
						{t("chat.action.retry")}
					</Button>
				</div>
			) : null}

			<div className="projects-list" aria-live="polite">
				{query.isLoading && query.data === undefined ? (
					<div className="project-list-skeleton" role="status">
						<span>{t("projects.loading")}</span>
					</div>
				) : projects.length === 0 ? (
					<div className="project-empty">
						<AppIcon name="projects" size={24} />
						<strong>{showArchived ? t("projects.emptyArchived") : t("projects.empty")}</strong>
						<p>
							{showArchived
								? t("projects.emptyArchivedDescription")
								: t("projects.emptyDescription")}
						</p>
					</div>
				) : (
					projects.map((project) => (
						<article className="project-row" key={project.id}>
							<Link className="project-row__main" to={`/projects/${project.id}`}>
								<span className="project-row__icon">
									<AppIcon name="projects" size={19} />
								</span>
								<span className="project-row__identity">
									<strong>{project.name}</strong>
									<code>{project.path}</code>
								</span>
							</Link>
							<div className="project-row__meta">
								<ProjectStatus
									project={project}
									runtimeReady={runtimeBoxes.isRuntimeBoxReady(project.runtimeBoxId)}
									compact
								/>
								<span>
									{project.gitBranch ?? (project.gitRootPath ? t("projects.detached") : "—")}
								</span>
							</div>
							<div className="project-menu">
								<button
									type="button"
									aria-label={t("projects.actions", project.name)}
									aria-expanded={menuProjectId === project.id}
									aria-haspopup="menu"
									onClick={() =>
										setMenuProjectId((current) => (current === project.id ? undefined : project.id))
									}
								>
									<AppIcon name="menu" size={17} />
								</button>
								{menuProjectId === project.id ? (
									<div className="project-menu__popover" role="menu">
										<Link role="menuitem" to={`/projects/${project.id}/settings`}>
											{t("projects.edit")}
										</Link>
										<button
											type="button"
											role="menuitem"
											disabled={pendingProjectId !== undefined}
											onClick={() => void setArchived(project)}
										>
											{project.archivedAt ? t("projects.restore") : t("projects.archive")}
										</button>
										<ProjectDeleteDialog
											project={project}
											isOpen={deleteProjectId === project.id}
											onOpenChange={(open) => setDeleteProjectId(open ? project.id : undefined)}
											onDeletionRequested={(output) => {
												setDeletionNotice(t("projects.deletionRequested", project.name));
												projectData.invalidateProject(project.id, project.runtimeBoxId);
												setMenuProjectId(undefined);
												void query.reload();
												if (output.projectId !== project.id) {
													setMutationError(t("projects.error.delete"));
												}
											}}
											trigger={t("projects.delete")}
											triggerClassName="project-menu__danger"
											triggerRole="menuitem"
										/>
									</div>
								) : null}
							</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}
