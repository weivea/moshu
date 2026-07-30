import { Button } from "@heroui/react";
import type { ProjectPathPreview } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";
import { useProjectData } from "./project-data";
import {
	errorMessage,
	isPreviewStaleError,
	PathPreviewDetails,
	ProjectDeleteDialog,
	ProjectStatus,
} from "./project-shared";
import { useProjectDetail } from "./use-project-detail";

export function ProjectSettingsPage() {
	const { projectId } = useParams();
	const { t } = useI18n();
	const navigate = useNavigate();
	const runtimeBoxes = useRuntimeBoxes();
	const projectData = useProjectData();
	const detail = useProjectDetail(projectId);
	const [name, setName] = useState("");
	const [relinkPath, setRelinkPath] = useState("");
	const [relinkPreview, setRelinkPreview] = useState<ProjectPathPreview>();
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [pending, setPending] = useState<"name" | "archive" | "check" | "preview" | "relink">();
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [deletionRequestedAt, setDeletionRequestedAt] = useState<string>();
	const requestRef = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Route identity resets in-flight form work.
	useEffect(() => {
		requestRef.current += 1;
		setRelinkPath("");
		setRelinkPreview(undefined);
		setDeleteOpen(false);
		setPending(undefined);
		setError(undefined);
		setNotice(undefined);
		setDeletionRequestedAt(undefined);
	}, [projectId]);

	useEffect(() => {
		if (detail.project !== undefined) {
			setName(detail.project.name);
		}
	}, [detail.project]);

	if (detail.error) {
		return (
			<section className="projects-page project-error-page" role="alert">
				<h1>{t("projects.settings.title")}</h1>
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
	const project =
		deletionRequestedAt === undefined ? detail.project : { ...detail.project, deletionRequestedAt };
	const ownerRuntimeBox = runtimeBoxes.snapshot.items.find(
		(item) => item.runtimeBox.runtimeBoxId === project.runtimeBoxId,
	);
	const isArchived = project.archivedAt !== undefined;
	const canEditPath =
		!isArchived && project.deletionRequestedAt === undefined && detail.runtimeReady;

	const saveName = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (name.trim().length === 0 || name.trim() === project.name) {
			return;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setPending("name");
		setError(undefined);
		try {
			await desktopClient.updateProject({ projectId: project.id, name: name.trim() });
			if (requestRef.current === requestId) {
				projectData.invalidateProject(project.id, project.runtimeBoxId);
				setNotice(t("projects.settings.nameSaved"));
				await detail.reload();
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.update")));
			}
		} finally {
			if (requestRef.current === requestId) {
				setPending(undefined);
			}
		}
	};

	const checkPath = async () => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setPending("check");
		setError(undefined);
		try {
			const checked = await detail.refreshPath();
			if (requestRef.current !== requestId) {
				return;
			}
			if (checked) {
				setNotice(t("projects.settings.pathChecked"));
			} else {
				setError(t("projects.error.check"));
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.check")));
			}
		} finally {
			if (requestRef.current === requestId) {
				setPending(undefined);
			}
		}
	};

	const previewRelink = async (path: string): Promise<boolean> => {
		if (path.trim().length === 0) {
			return false;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setPending("preview");
		setError(undefined);
		setNotice(undefined);
		try {
			const output = await desktopClient.previewProjectRelink({
				projectId: project.id,
				path: path.trim(),
			});
			if (requestRef.current === requestId) {
				setRelinkPath(path.trim());
				setRelinkPreview(output.preview);
				return true;
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.preview")));
			}
		} finally {
			if (requestRef.current === requestId) {
				setPending(undefined);
			}
		}
		return false;
	};

	const chooseRelinkDirectory = async () => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setError(undefined);
		try {
			const output = await desktopClient.pickProjectDirectory();
			if (requestRef.current === requestId && !output.cancelled) {
				await previewRelink(output.path);
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.picker")));
			}
		}
	};

	const confirmRelink = async () => {
		if (relinkPreview === undefined) {
			return;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setPending("relink");
		setError(undefined);
		try {
			await desktopClient.relinkProject({
				projectId: project.id,
				path: relinkPreview.inputPath,
				runtimeBoxId: project.runtimeBoxId,
				expectedPathRevision: project.pathRevision,
				confirmationToken: relinkPreview.confirmationToken,
			});
			if (requestRef.current === requestId) {
				setRelinkPreview(undefined);
				setRelinkPath("");
				projectData.invalidateProject(project.id, project.runtimeBoxId);
				setNotice(t("projects.settings.relinked"));
				await detail.reload();
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				if (isPreviewStaleError(caught)) {
					setPending(undefined);
					const refreshed = await previewRelink(relinkPreview.inputPath);
					if (refreshed) {
						setNotice(t("projects.preview.stale"));
					}
				} else {
					setError(errorMessage(caught, t("projects.error.relink")));
				}
			}
		} finally {
			if (requestRef.current === requestId) {
				setPending(undefined);
			}
		}
	};

	const toggleArchived = async () => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setPending("archive");
		setError(undefined);
		try {
			await desktopClient.setProjectArchived({
				projectId: project.id,
				archived: !isArchived,
			});
			if (requestRef.current === requestId) {
				projectData.invalidateProject(project.id, project.runtimeBoxId);
				await detail.reload();
				setNotice(t(isArchived ? "projects.settings.restored" : "projects.settings.archived"));
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.update")));
			}
		} finally {
			if (requestRef.current === requestId) {
				setPending(undefined);
			}
		}
	};

	return (
		<section className="projects-page project-settings">
			<header className="project-detail-header">
				<div className="project-detail-header__identity">
					<Link className="project-back-link" to={`/projects/${project.id}`}>
						<AppIcon name="back" size={16} />
						{project.name}
					</Link>
					<div>
						<h1>{t("projects.settings.title")}</h1>
						<ProjectStatus project={project} runtimeReady={detail.runtimeReady} />
					</div>
					<p>{t("projects.settings.description")}</p>
				</div>
			</header>

			{notice ? (
				<p className="project-form-notice" role="status">
					{notice}
				</p>
			) : null}
			{error || detail.healthError ? (
				<p className="session-sidebar__error" role="alert">
					{error ?? detail.healthError?.message}
				</p>
			) : null}
			{project.deletionRequestedAt ? (
				<div className="project-banner" role="status">
					<span>{t("projects.banner.deleting")}</span>
					<Button className="chat-button chat-button--inline" onPress={() => navigate("/projects")}>
						{t("projects.backToProjects")}
					</Button>
				</div>
			) : null}

			<section className="project-settings-section">
				<header>
					<h2>{t("projects.settings.general")}</h2>
					<p>{t("projects.settings.generalDescription")}</p>
				</header>
				<form className="project-settings-form" onSubmit={saveName}>
					<label className="chat-field">
						<span>{t("projects.name")}</span>
						<input
							maxLength={128}
							value={name}
							disabled={isArchived || project.deletionRequestedAt !== undefined}
							onChange={(event) => setName(event.currentTarget.value)}
						/>
					</label>
					<Button
						type="submit"
						className="chat-button chat-button--primary"
						isDisabled={
							isArchived ||
							project.deletionRequestedAt !== undefined ||
							pending !== undefined ||
							name.trim().length === 0 ||
							name.trim() === project.name
						}
					>
						{pending === "name" ? t("projects.settings.saving") : t("sessions.rename.save")}
					</Button>
				</form>
			</section>

			<section className="project-settings-section">
				<header>
					<h2>{t("projects.settings.path")}</h2>
					<p>{t("projects.settings.pathDescription")}</p>
				</header>
				<div className="project-path-summary">
					<code>{project.path}</code>
					<span>
						{project.pathCheckedAt
							? t("projects.lastChecked", new Date(project.pathCheckedAt).toLocaleString())
							: t("projects.neverChecked")}
						{project.pathIssueCode ? ` · ${project.pathIssueCode}` : ""}
					</span>
					<Button
						className="chat-button"
						isDisabled={!canEditPath || pending !== undefined}
						onPress={() => void checkPath()}
					>
						{pending === "check" ? t("projects.checking") : t("projects.checkNow")}
					</Button>
				</div>
				{!isArchived && project.deletionRequestedAt === undefined ? (
					<div className="project-relink">
						<h3>{t("projects.settings.relink")}</h3>
						{ownerRuntimeBox?.runtimeBox.kind === "local" ? (
							<Button
								className="chat-button"
								isDisabled={!canEditPath || pending !== undefined}
								onPress={() => void chooseRelinkDirectory()}
							>
								{t("projects.chooseFolder")}
							</Button>
						) : (
							<form
								className="project-remote-path"
								onSubmit={(event) => {
									event.preventDefault();
									void previewRelink(relinkPath);
								}}
							>
								<label className="chat-field">
									<span>{t("projects.settings.newPath")}</span>
									<input
										value={relinkPath}
										disabled={!canEditPath || pending !== undefined}
										onChange={(event) => {
											requestRef.current += 1;
											setRelinkPath(event.currentTarget.value);
											setRelinkPreview(undefined);
											setPending(undefined);
											setError(undefined);
											setNotice(undefined);
										}}
									/>
								</label>
								<Button
									type="submit"
									className="chat-button"
									isDisabled={
										!canEditPath || pending !== undefined || relinkPath.trim().length === 0
									}
								>
									{pending === "preview" ? t("projects.validating") : t("projects.preview.action")}
								</Button>
							</form>
						)}
						{relinkPreview ? (
							<>
								<PathPreviewDetails
									preview={relinkPreview}
									name={project.name}
									onNameChange={() => undefined}
									showName={false}
								/>
								<div className="project-add__actions">
									<Button className="chat-button" onPress={() => setRelinkPreview(undefined)}>
										{t("action.cancel")}
									</Button>
									<Button
										className="chat-button chat-button--primary"
										isDisabled={pending !== undefined}
										onPress={() => void confirmRelink()}
									>
										{pending === "relink"
											? t("projects.settings.relinking")
											: t("projects.settings.confirmRelink")}
									</Button>
								</div>
							</>
						) : null}
					</div>
				) : null}
			</section>

			<section className="project-settings-section">
				<header>
					<h2>{t("projects.settings.ownership")}</h2>
					<p>{t("projects.settings.ownershipDescription")}</p>
				</header>
				<dl className="project-facts">
					<div>
						<dt>{t("projects.runtime")}</dt>
						<dd>
							{ownerRuntimeBox?.runtimeBox.displayName ?? project.runtimeBoxId} ·{" "}
							{ownerRuntimeBox?.runtimeBox.platform ?? "—"}
						</dd>
					</div>
					<div>
						<dt>{t("projects.git")}</dt>
						<dd>
							{project.gitRootPath
								? `${project.gitRootPath} · ${project.gitBranch ?? t("projects.detached")}`
								: t("projects.preview.notGit")}
						</dd>
					</div>
				</dl>
			</section>

			<section className="project-settings-section project-danger-zone">
				<header>
					<h2>{t("projects.settings.danger")}</h2>
					<p>{t("projects.settings.dangerDescription")}</p>
				</header>
				<div className="project-danger-action">
					<div>
						<strong>{isArchived ? t("projects.restore") : t("projects.archive")}</strong>
						<p>
							{t(
								isArchived
									? "projects.settings.restoreDescription"
									: "projects.settings.archiveDescription",
							)}
						</p>
					</div>
					<Button
						className="chat-button"
						isDisabled={pending !== undefined || project.deletionRequestedAt !== undefined}
						onPress={() => void toggleArchived()}
					>
						{pending === "archive"
							? t("projects.settings.updating")
							: isArchived
								? t("projects.restore")
								: t("projects.archive")}
					</Button>
				</div>
				<div className="project-danger-action">
					<div>
						<strong>{t("projects.delete")}</strong>
						<p>{t("projects.settings.deleteDescription")}</p>
					</div>
					<ProjectDeleteDialog
						project={project}
						isOpen={deleteOpen}
						onOpenChange={setDeleteOpen}
						onDeletionRequested={(output) => {
							setDeletionRequestedAt(output.deletionRequestedAt);
							projectData.invalidateProject(project.id, project.runtimeBoxId);
							setNotice(t("projects.deletionRequested", project.name));
						}}
						trigger={t("projects.delete")}
						triggerClassName="chat-button chat-button--danger"
					/>
				</div>
			</section>
		</section>
	);
}
