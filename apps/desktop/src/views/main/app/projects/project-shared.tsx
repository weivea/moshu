import { AlertDialog, Button } from "@heroui/react";
import type {
	Project,
	ProjectDeleteConfirmation,
	ProjectPathPreview,
	ProjectSessionCounts,
} from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isProjectPreviewStaleError } from "../../../../shared/rpc-errors";
import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";

export function ProjectStatus({
	project,
	runtimeReady,
	compact = false,
}: {
	project: Project;
	runtimeReady: boolean;
	compact?: boolean;
}) {
	const { t } = useI18n();
	const status = project.deletionRequestedAt
		? t("projects.status.deleting")
		: project.archivedAt
			? t("projects.status.archived")
			: !runtimeReady
				? t("projects.status.offline")
				: project.pathStatus === "unavailable"
					? t("projects.status.unavailable")
					: project.pathStatus === "available"
						? t("projects.status.available")
						: t("projects.status.unknown");
	return (
		<span
			className={`project-status project-status--${project.deletionRequestedAt ? "danger" : project.pathStatus}`}
			data-compact={compact}
		>
			<span aria-hidden="true" />
			{status}
		</span>
	);
}

export function ProjectStatusBanner({
	project,
	runtimeReady,
	children,
}: {
	project: Project;
	runtimeReady: boolean;
	children?: ReactNode;
}) {
	const { t } = useI18n();
	const key = project.deletionRequestedAt
		? "projects.banner.deleting"
		: project.archivedAt
			? "projects.banner.archived"
			: !runtimeReady
				? "projects.banner.offline"
				: project.pathStatus === "unavailable"
					? "projects.banner.unavailable"
					: undefined;
	if (key === undefined) {
		return null;
	}
	return (
		<div className="project-banner" role={project.deletionRequestedAt ? "alert" : "status"}>
			<span>{t(key)}</span>
			{children}
		</div>
	);
}

export function PathPreviewDetails({
	preview,
	name,
	onNameChange,
	showName = true,
}: {
	preview: ProjectPathPreview;
	name: string;
	onNameChange(value: string): void;
	showName?: boolean;
}) {
	const { t } = useI18n();
	return (
		<section className="project-preview" aria-label={t("projects.preview.title")}>
			<header>
				<div>
					<h3>{t("projects.preview.title")}</h3>
					<p>{t("projects.preview.description")}</p>
				</div>
				<span className="project-runtime-pill">
					{preview.runtimeBoxDisplayName} · {preview.runtimeBoxPlatform}
				</span>
			</header>
			<dl className="project-facts">
				<div>
					<dt>{t("projects.preview.inputPath")}</dt>
					<dd>
						<code>{preview.inputPath}</code>
					</dd>
				</div>
				<div>
					<dt>{t("projects.preview.canonicalPath")}</dt>
					<dd>
						<code>{preview.normalizedPath}</code>
					</dd>
				</div>
				<div>
					<dt>{t("projects.preview.git")}</dt>
					<dd>
						{preview.gitRootPath === undefined
							? t("projects.preview.notGit")
							: `${preview.gitRootPath} · ${preview.gitBranch ?? t("projects.detached")}`}
					</dd>
				</div>
				<div>
					<dt>{t("projects.preview.agents")}</dt>
					<dd>{formatRootAgentsStatus(preview, t)}</dd>
				</div>
				<div>
					<dt>{t("projects.preview.scope")}</dt>
					<dd>{t("projects.preview.scopeValue", preview.normalizedPath)}</dd>
				</div>
			</dl>
			{showName ? (
				<label className="chat-field">
					<span>{t("projects.name")}</span>
					<input
						maxLength={128}
						value={name}
						onChange={(event) => onNameChange(event.currentTarget.value)}
					/>
				</label>
			) : null}
			<div className="project-boundary-note">
				<AppIcon name="terminal" size={18} />
				<div>
					<p>{t("projects.preview.boundary")}</p>
					<p>{t("projects.preview.agentsBoundary")}</p>
				</div>
			</div>
		</section>
	);
}

function formatRootAgentsStatus(
	preview: ProjectPathPreview,
	t: ReturnType<typeof useI18n>["t"],
): string {
	if (preview.rootAgents.status === "available") {
		return t("projects.preview.agentsAvailable");
	}
	if (preview.rootAgents.status === "missing") {
		return t("projects.preview.agentsMissing");
	}
	return t("projects.preview.agentsWarning", preview.rootAgents.issueCode);
}

export function ProjectDeleteDialog({
	project,
	isOpen,
	onOpenChange,
	onDeletionRequested,
	trigger,
	triggerClassName,
	triggerRole,
}: {
	project: Project;
	isOpen: boolean;
	onOpenChange(isOpen: boolean): void;
	onDeletionRequested(output: { projectId: string; deletionRequestedAt: string }): void;
	trigger: ReactNode;
	triggerClassName?: string;
	triggerRole?: "button" | "menuitem";
}) {
	const { t } = useI18n();
	const [confirmation, setConfirmation] = useState<ProjectDeleteConfirmation>();
	const [typedName, setTypedName] = useState("");
	const [error, setError] = useState<string>();
	const [isLoading, setIsLoading] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const requestRef = useRef(0);

	useEffect(() => {
		if (!isOpen) {
			requestRef.current += 1;
			setConfirmation(undefined);
			setTypedName("");
			setError(undefined);
			return;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setIsLoading(true);
		void desktopClient
			.getProjectDeleteConfirmation(project.id)
			.then((output) => {
				if (requestRef.current === requestId) {
					setConfirmation(output.confirmation);
				}
			})
			.catch((caught: unknown) => {
				if (requestRef.current === requestId) {
					setError(errorMessage(caught, t("projects.error.deleteConfirmation")));
				}
			})
			.finally(() => {
				if (requestRef.current === requestId) {
					setIsLoading(false);
				}
			});
	}, [isOpen, project.id, t]);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (confirmation === undefined || typedName !== confirmation.projectName) {
			return;
		}
		setIsDeleting(true);
		setError(undefined);
		try {
			const output = await desktopClient.requestProjectDeletion({
				projectId: project.id,
				expectedName: typedName,
			});
			onDeletionRequested(output);
			onOpenChange(false);
		} catch (caught) {
			setError(errorMessage(caught, t("projects.error.delete")));
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<AlertDialog isOpen={isOpen} onOpenChange={(open) => !isDeleting && onOpenChange(open)}>
			<AlertDialog.Trigger className={triggerClassName} role={triggerRole ?? "button"}>
				{trigger}
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop className="confirmation-dialog__backdrop" isDismissable={false}>
				<AlertDialog.Container
					className="confirmation-dialog__container"
					placement="center"
					size="sm"
				>
					<AlertDialog.Dialog className="confirmation-dialog">
						<AlertDialog.Header className="confirmation-dialog__header">
							<AlertDialog.Icon status="danger" />
							<AlertDialog.Heading>{t("projects.deleteTitle")}</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body className="confirmation-dialog__body project-delete-dialog">
							<p>{t("projects.deleteRecordsWarning")}</p>
							<p>{t("projects.deleteFilesRemain")}</p>
							{isLoading ? (
								<p role="status">{t("projects.deleteLoadingCounts")}</p>
							) : confirmation ? (
								<>
									<SessionCounts counts={confirmation.sessionCounts} />
									<form id={`delete-project-${project.id}`} onSubmit={submit}>
										<label className="chat-field">
											<span>{t("projects.deleteTypeName", confirmation.projectName)}</span>
											<input
												autoComplete="off"
												value={typedName}
												onChange={(event) => setTypedName(event.currentTarget.value)}
											/>
										</label>
									</form>
								</>
							) : null}
							{error ? <p role="alert">{error}</p> : null}
						</AlertDialog.Body>
						<AlertDialog.Footer className="confirmation-dialog__footer">
							<Button
								className="chat-button"
								isDisabled={isDeleting}
								onPress={() => onOpenChange(false)}
							>
								{t("action.cancel")}
							</Button>
							<Button
								type="submit"
								form={`delete-project-${project.id}`}
								className="chat-button chat-button--danger"
								isDisabled={
									isDeleting || confirmation === undefined || typedName !== confirmation.projectName
								}
							>
								{isDeleting ? t("projects.deleting") : t("projects.delete")}
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

function SessionCounts({ counts }: { counts: ProjectSessionCounts }) {
	const { t } = useI18n();
	return (
		<dl className="project-delete-counts">
			<div>
				<dt>{t("sessions.filter.active")}</dt>
				<dd>{counts.active}</dd>
			</div>
			<div>
				<dt>{t("sessions.filter.archived")}</dt>
				<dd>{counts.archived}</dd>
			</div>
			<div>
				<dt>{t("projects.sessions.total")}</dt>
				<dd>{counts.total}</dd>
			</div>
		</dl>
	);
}

export function ProjectRepairLink({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	return (
		<Link className="chat-button chat-button--inline" to={`/projects/${projectId}/settings`}>
			{t("projects.openSettings")}
		</Link>
	);
}

export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function isPreviewStaleError(error: unknown): boolean {
	return isProjectPreviewStaleError(error);
}
