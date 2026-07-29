import { Button } from "@heroui/react";
import type { Project } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { desktopClient } from "../lib/rpc";
import { ConfirmationDialog } from "./confirmation-dialog";
import { useI18n } from "./i18n";
import { useRuntimeBoxes } from "./runtime-boxes";

const projectChangeListeners = new Set<(runtimeBoxId: string) => void>();

function publishProjectsChanged(runtimeBoxId: string): void {
	for (const listener of projectChangeListeners) {
		listener(runtimeBoxId);
	}
}

export function ProjectsPage() {
	const { t } = useI18n();
	const runtimeBoxes = useRuntimeBoxes();
	const [projects, setProjects] = useState<Project[]>([]);
	const [showArchived, setShowArchived] = useState(false);
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [pendingProjectId, setPendingProjectId] = useState<string>();
	const [projectToDelete, setProjectToDelete] = useState<Project>();
	const [errorMessage, setErrorMessage] = useState<string>();
	const [mutationRevision, setMutationRevision] = useState(0);
	const requestNumberRef = useRef(0);
	const activeRuntimeBoxIdRef = useRef(runtimeBoxes.snapshot.active.runtimeBoxId);
	activeRuntimeBoxIdRef.current = runtimeBoxes.snapshot.active.runtimeBoxId;

	const loadProjects = useCallback(async () => {
		const runtimeBoxId = runtimeBoxes.snapshot.active.runtimeBoxId;
		const requestNumber = requestNumberRef.current + 1;
		requestNumberRef.current = requestNumber;
		setIsLoading(true);
		setErrorMessage(undefined);
		try {
			const output = await desktopClient.listProjects({
				runtimeBoxId,
				archived: showArchived,
			});
			if (
				requestNumberRef.current === requestNumber &&
				activeRuntimeBoxIdRef.current === runtimeBoxId
			) {
				setProjects(output.items);
			}
		} catch (error) {
			if (
				requestNumberRef.current === requestNumber &&
				activeRuntimeBoxIdRef.current === runtimeBoxId
			) {
				setErrorMessage(error instanceof Error ? error.message : t("projects.error.load"));
			}
		} finally {
			if (
				requestNumberRef.current === requestNumber &&
				activeRuntimeBoxIdRef.current === runtimeBoxId
			) {
				setIsLoading(false);
			}
		}
	}, [runtimeBoxes.snapshot.active.runtimeBoxId, showArchived, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: these revisions explicitly invalidate the active query.
	useEffect(() => {
		void loadProjects();
	}, [loadProjects, mutationRevision, runtimeBoxes.snapshot.active.revision]);

	const createProject = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!runtimeBoxes.isActiveReady || path.trim().length === 0) {
			return;
		}
		setPendingProjectId("create");
		setErrorMessage(undefined);
		try {
			await desktopClient.createProject({
				runtimeBoxId: runtimeBoxes.snapshot.active.runtimeBoxId,
				path: path.trim(),
				...(name.trim().length === 0 ? {} : { name: name.trim() }),
			});
			setPath("");
			setName("");
			publishProjectsChanged(runtimeBoxes.snapshot.active.runtimeBoxId);
			setMutationRevision((current) => current + 1);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("projects.error.create"));
		} finally {
			setPendingProjectId(undefined);
		}
	};

	const toggleArchived = async (project: Project) => {
		setPendingProjectId(project.id);
		setErrorMessage(undefined);
		try {
			await desktopClient.setProjectArchived({
				projectId: project.id,
				archived: project.archivedAt === undefined,
			});
			publishProjectsChanged(project.runtimeBoxId);
			setMutationRevision((current) => current + 1);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("projects.error.update"));
		} finally {
			setPendingProjectId(undefined);
		}
	};

	const deleteProject = async (project: Project) => {
		setPendingProjectId(project.id);
		try {
			await desktopClient.deleteProject(project.id);
			setProjectToDelete(undefined);
			publishProjectsChanged(project.runtimeBoxId);
			setMutationRevision((current) => current + 1);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("projects.error.delete"));
		} finally {
			setPendingProjectId(undefined);
		}
	};

	return (
		<section className="projects-page">
			<header className="projects-page__header">
				<div>
					<span className="chat-page__eyebrow">{t("projects.eyebrow")}</span>
					<h1>{t("page.projects.title")}</h1>
					<p>
						{t(runtimeBoxes.isActiveReady ? "projects.description" : "projects.offlineDescription")}
					</p>
				</div>
				<div className="projects-page__filters">
					<Button className="chat-button" onPress={() => setShowArchived((current) => !current)}>
						{showArchived ? t("projects.showActive") : t("projects.showArchived")}
					</Button>
				</div>
			</header>

			<form className="chat-card project-create-form" onSubmit={createProject}>
				<label className="chat-field">
					<span>{t("projects.path")}</span>
					<input
						value={path}
						placeholder={t("projects.pathPlaceholder")}
						disabled={!runtimeBoxes.isActiveReady}
						onChange={(event) => setPath(event.currentTarget.value)}
					/>
				</label>
				<label className="chat-field">
					<span>{t("projects.name")}</span>
					<input
						value={name}
						placeholder={t("projects.namePlaceholder")}
						disabled={!runtimeBoxes.isActiveReady}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
				</label>
				<Button
					type="submit"
					className="chat-button chat-button--primary"
					isDisabled={
						!runtimeBoxes.isActiveReady ||
						path.trim().length === 0 ||
						pendingProjectId !== undefined
					}
				>
					{pendingProjectId === "create" ? t("projects.validating") : t("action.addProject")}
				</Button>
			</form>

			{errorMessage ? (
				<p className="session-sidebar__error" role="alert">
					{errorMessage}
				</p>
			) : null}

			<div className="projects-grid">
				{isLoading ? (
					<p role="status">{t("projects.loading")}</p>
				) : projects.length === 0 ? (
					<p>{showArchived ? t("projects.emptyArchived") : t("projects.empty")}</p>
				) : (
					projects.map((project) => (
						<article className="chat-card project-card" key={project.id}>
							<div className="project-card__header">
								<AppIcon name="projects" size={20} />
								<div>
									<strong>{project.name}</strong>
									<code>{project.path}</code>
								</div>
							</div>
							{project.gitRootPath ? (
								<span className="project-card__git">
									{project.gitBranch ?? t("projects.detached")}
								</span>
							) : null}
							<div className="provider-form__actions">
								<Button
									className="chat-button"
									isDisabled={!runtimeBoxes.isActiveReady || pendingProjectId !== undefined}
									onPress={() => void toggleArchived(project)}
								>
									{project.archivedAt ? t("projects.restore") : t("projects.archive")}
								</Button>
								<ConfirmationDialog
									isOpen={projectToDelete?.id === project.id}
									isPending={pendingProjectId === project.id}
									isTriggerDisabled={!runtimeBoxes.isActiveReady || pendingProjectId !== undefined}
									triggerLabel={t("projects.delete")}
									triggerClassName="chat-button chat-button--danger"
									title={t("projects.deleteTitle")}
									description={t("projects.deleteConfirm", project.name)}
									cancelLabel={t("action.cancel")}
									confirmLabel={t("projects.delete")}
									pendingLabel={t("projects.deleting")}
									onOpenChange={(isOpen) => setProjectToDelete(isOpen ? project : undefined)}
									onConfirm={() => deleteProject(project)}
								/>
							</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}

export function ProjectDetailPage() {
	const { projectId } = useParams();
	const { t } = useI18n();
	const [project, setProject] = useState<Project>();
	const [errorMessage, setErrorMessage] = useState<string>();
	useEffect(() => {
		setProject(undefined);
		setErrorMessage(undefined);
		if (projectId === undefined) {
			return;
		}
		let active = true;
		void desktopClient
			.getProject(projectId)
			.then((output) => {
				if (active) {
					setProject(output.project);
				}
			})
			.catch((error: unknown) => {
				if (active) {
					setErrorMessage(error instanceof Error ? error.message : t("projects.error.load"));
				}
			});
		return () => {
			active = false;
		};
	}, [projectId, t]);
	if (errorMessage) {
		return <p role="alert">{errorMessage}</p>;
	}
	if (project === undefined) {
		return <p role="status">{t("projects.loading")}</p>;
	}
	return (
		<section className="projects-page">
			<header className="projects-page__header">
				<div>
					<span className="chat-page__eyebrow">{t("page.project.title")}</span>
					<h1>{project.name}</h1>
					<code>{project.path}</code>
				</div>
			</header>
		</section>
	);
}

export function ProjectsSidebar({ refreshKey, onAdd }: { refreshKey: string; onAdd(): void }) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const runtimeBoxes = useRuntimeBoxes();
	const [projects, setProjects] = useState<Project[]>([]);
	const [mutationRevision, setMutationRevision] = useState(0);
	useEffect(() => {
		const listener = (runtimeBoxId: string) => {
			if (runtimeBoxId === runtimeBoxes.snapshot.active.runtimeBoxId) {
				setMutationRevision((current) => current + 1);
			}
		};
		projectChangeListeners.add(listener);
		return () => {
			projectChangeListeners.delete(listener);
		};
	}, [runtimeBoxes.snapshot.active.runtimeBoxId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: shell and mutation revisions explicitly invalidate the sidebar query.
	useEffect(() => {
		let active = true;
		void desktopClient
			.listProjects({
				runtimeBoxId: runtimeBoxes.snapshot.active.runtimeBoxId,
				limit: 8,
			})
			.then((output) => {
				if (active) {
					setProjects(output.items);
				}
			})
			.catch(() => {
				if (active) {
					setProjects([]);
				}
			});
		return () => {
			active = false;
		};
	}, [
		refreshKey,
		mutationRevision,
		runtimeBoxes.snapshot.active.revision,
		runtimeBoxes.snapshot.active.runtimeBoxId,
	]);
	return (
		<section className="projects-sidebar" aria-labelledby="projects-sidebar-title">
			<header>
				<h2 id="projects-sidebar-title">{t("nav.projects")}</h2>
				<button
					type="button"
					aria-label={t("action.addProject")}
					title={t("action.addProject")}
					disabled={!runtimeBoxes.isActiveReady}
					onClick={onAdd}
				>
					<AppIcon name="plus" size={17} />
				</button>
			</header>
			{projects.length === 0 ? (
				<p className="projects-sidebar__empty">{t("projects.empty")}</p>
			) : (
				<ul className="projects-sidebar__list">
					{projects.map((project) => (
						<li key={project.id}>
							<button type="button" onClick={() => navigate(`/projects/${project.id}`)}>
								<AppIcon name="projects" size={16} />
								<span>{project.name}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
