import { Button } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useCallback, useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { chatTransport } from "../chat/rpc-chat-transport";
import { SessionSidebar } from "../chat/session-sidebar";
import type { ChatTransport } from "../chat/transport";
import { useI18n } from "../i18n";
import { useProjectData } from "./project-data";
import { ProjectRepairLink, ProjectStatus, ProjectStatusBanner } from "./project-shared";
import { useProjectDetail } from "./use-project-detail";

export function ProjectOverviewPage({
	transport = chatTransport,
}: {
	transport?: ChatTransport;
} = {}) {
	const { projectId } = useParams();
	const { t } = useI18n();
	const navigate = useNavigate();
	const detail = useProjectDetail(projectId, true);
	const { invalidateProject, invalidateRuntime } = useProjectData();
	const owningProjectId = detail.project?.id;
	const owningRuntimeBoxId = detail.project?.runtimeBoxId;
	const reconciledSidebarScopeRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (owningProjectId === undefined || owningRuntimeBoxId === undefined) {
			return;
		}
		const scope = `${owningRuntimeBoxId}:${owningProjectId}`;
		if (reconciledSidebarScopeRef.current === scope) {
			return;
		}
		reconciledSidebarScopeRef.current = scope;
		invalidateRuntime(owningRuntimeBoxId);
	}, [invalidateRuntime, owningProjectId, owningRuntimeBoxId]);
	const invalidateProjectSessionMetadata = useCallback(() => {
		if (detail.project !== undefined) {
			invalidateProject(detail.project.id, detail.project.runtimeBoxId);
		}
	}, [detail.project, invalidateProject]);
	const invalidateProjectSessionCount = useCallback(() => {
		if (detail.project !== undefined) {
			invalidateProject(detail.project.id);
		}
	}, [detail.project, invalidateProject]);

	if (detail.error) {
		return (
			<section className="projects-page project-error-page" role="alert">
				<h1>{t("projects.error.title")}</h1>
				<p>{detail.error.message}</p>
				<Button className="chat-button" onPress={() => void detail.reload()}>
					{t("chat.action.retry")}
				</Button>
			</section>
		);
	}
	if (detail.project === undefined) {
		return (
			<section className="projects-page" role="status">
				{t("projects.loading")}
			</section>
		);
	}
	const project = detail.project;
	const canCreateSession =
		project.archivedAt === undefined &&
		project.deletionRequestedAt === undefined &&
		detail.runtimeReady &&
		project.pathStatus === "available" &&
		detail.healthError === undefined &&
		!detail.isCheckingPath;

	return (
		<section className="projects-page project-overview">
			<header className="project-detail-header">
				<div className="project-detail-header__identity">
					<Link className="project-back-link" to="/projects">
						<AppIcon name="back" size={16} />
						{t("page.projects.title")}
					</Link>
					<div>
						<h1>{project.name}</h1>
						<ProjectStatus project={project} runtimeReady={detail.runtimeReady} />
					</div>
					<code>{project.path}</code>
				</div>
				<div className="project-detail-header__actions">
					<Button
						className="chat-button chat-button--primary"
						isDisabled={!canCreateSession}
						onPress={() => navigate(`/projects/${project.id}/chat/new`)}
					>
						<AppIcon name="plus" size={17} />
						{t("projects.sessions.new")}
					</Button>
					<Link className="chat-button" to={`/projects/${project.id}/settings`}>
						<AppIcon name="settings" size={16} />
						{t("projects.edit")}
					</Link>
				</div>
			</header>

			<ProjectStatusBanner project={project} runtimeReady={detail.runtimeReady}>
				<ProjectRepairLink projectId={project.id} />
			</ProjectStatusBanner>
			{detail.healthError ? (
				<div className="project-banner" role="alert">
					<span>{t("projects.banner.checkFailed")}</span>
					<ProjectRepairLink projectId={project.id} />
				</div>
			) : null}

			<section className="project-overview__facts" aria-label={t("projects.details")}>
				<div>
					<span>{t("projects.runtime")}</span>
					<strong>{project.runtimeBoxId}</strong>
				</div>
				<div>
					<span>{t("projects.git")}</span>
					<strong>
						{project.gitRootPath
							? `${project.gitBranch ?? t("projects.detached")} · ${project.gitRootPath}`
							: t("projects.preview.notGit")}
					</strong>
				</div>
				<div>
					<span>{t("projects.pathStatus")}</span>
					<strong>
						{project.pathCheckedAt
							? t("projects.lastChecked", new Date(project.pathCheckedAt).toLocaleString())
							: t("projects.neverChecked")}
					</strong>
					<Button
						className="chat-button chat-button--inline"
						isDisabled={
							!detail.runtimeReady || project.archivedAt !== undefined || detail.isCheckingPath
						}
						onPress={() => void detail.refreshPath()}
					>
						{detail.isCheckingPath ? t("projects.checking") : t("projects.checkNow")}
					</Button>
				</div>
			</section>

			<section className="project-session-section">
				<SessionSidebar
					transport={transport}
					refreshKey={`${project.updatedAt}:${detail.sessionCounts?.total ?? 0}`}
					scope={{ kind: "project", projectId: project.id }}
					variant="page"
					initialShowAllSessions
					isNewSessionDisabled={!canCreateSession}
					onNewSession={() => navigate(`/projects/${project.id}/chat/new`)}
					onSessionRetired={invalidateProjectSessionCount}
					onSessionUpdated={invalidateProjectSessionMetadata}
					onSelectSession={(sessionId) => navigate(`/projects/${project.id}/chat/${sessionId}`)}
				/>
			</section>
		</section>
	);
}
