import { Button } from "@heroui/react";
import type { Project, ProjectPathPreview, RuntimeBoxConnectionInfo } from "@moshu/contracts";
import { AppIcon } from "@moshu/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { errorMessage, isPreviewStaleError, PathPreviewDetails } from "./project-shared";

export function ProjectAdd({
	runtimeBox,
	isRuntimeReady,
	onCreated,
}: {
	runtimeBox: RuntimeBoxConnectionInfo | undefined;
	isRuntimeReady: boolean;
	onCreated(project: Project): void;
}) {
	const { t } = useI18n();
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [preview, setPreview] = useState<ProjectPathPreview>();
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [isPreviewing, setIsPreviewing] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const requestRef = useRef(0);
	const isLocal = runtimeBox?.runtimeBox.kind === "local";
	const runtimeBoxId = runtimeBox?.runtimeBox.runtimeBoxId;

	// biome-ignore lint/correctness/useExhaustiveDependencies: Runtime identity resets in-flight form work.
	useEffect(() => {
		requestRef.current += 1;
		setPath("");
		setName("");
		setPreview(undefined);
		setError(undefined);
		setNotice(undefined);
		setIsPreviewing(false);
		setIsCreating(false);
	}, [runtimeBoxId]);

	const previewPath = async (nextPath: string): Promise<boolean> => {
		if (runtimeBox === undefined || nextPath.trim().length === 0) {
			return false;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setIsPreviewing(true);
		setError(undefined);
		setNotice(undefined);
		setPreview(undefined);
		try {
			const output = await desktopClient.previewProjectPath({
				runtimeBoxId: runtimeBox.runtimeBox.runtimeBoxId,
				path: nextPath.trim(),
			});
			if (requestRef.current === requestId) {
				setPath(nextPath.trim());
				setPreview(output.preview);
				setName(output.preview.displayName);
				return true;
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.preview")));
			}
		} finally {
			if (requestRef.current === requestId) {
				setIsPreviewing(false);
			}
		}
		return false;
	};

	const chooseDirectory = async () => {
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setError(undefined);
		try {
			const result = await desktopClient.pickProjectDirectory();
			if (requestRef.current === requestId && !result.cancelled) {
				await previewPath(result.path);
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				setError(errorMessage(caught, t("projects.error.picker")));
			}
		}
	};

	const submitRemotePath = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void previewPath(path);
	};

	const confirm = async () => {
		if (preview === undefined || name.trim().length === 0) {
			return;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setIsCreating(true);
		setError(undefined);
		setNotice(undefined);
		try {
			const output = await desktopClient.confirmCreateProject({
				runtimeBoxId: preview.runtimeBoxId,
				path: preview.inputPath,
				name: name.trim(),
				confirmationToken: preview.confirmationToken,
			});
			if (requestRef.current === requestId) {
				onCreated(output.project);
				setPreview(undefined);
				setPath("");
				setName("");
			}
		} catch (caught) {
			if (requestRef.current === requestId) {
				if (isPreviewStaleError(caught)) {
					setIsCreating(false);
					const refreshed = await previewPath(preview.inputPath);
					if (refreshed) {
						setNotice(t("projects.preview.stale"));
					}
				} else {
					setError(errorMessage(caught, t("projects.error.create")));
				}
			}
		} finally {
			if (requestRef.current === requestId) {
				setIsCreating(false);
			}
		}
	};

	return (
		<section className="project-add">
			<div className="project-add__intro">
				<div>
					<h2>{t("action.addProject")}</h2>
					<p>
						{isLocal ? t("projects.add.localDescription") : t("projects.add.remoteDescription")}
					</p>
				</div>
				{isLocal ? (
					<Button
						className="chat-button chat-button--primary"
						isDisabled={!isRuntimeReady || isPreviewing || isCreating}
						onPress={() => void chooseDirectory()}
					>
						<AppIcon name="projects" size={17} />
						{isPreviewing ? t("projects.validating") : t("projects.chooseFolder")}
					</Button>
				) : (
					<form className="project-remote-path" onSubmit={submitRemotePath}>
						<label className="chat-field">
							<span>{t("projects.path")}</span>
							<input
								required
								value={path}
								placeholder={t("projects.pathPlaceholder")}
								disabled={!isRuntimeReady || isCreating}
								onChange={(event) => {
									requestRef.current += 1;
									setPath(event.currentTarget.value);
									setPreview(undefined);
									setError(undefined);
									setNotice(undefined);
									setIsPreviewing(false);
								}}
							/>
						</label>
						<Button
							type="submit"
							className="chat-button chat-button--primary"
							isDisabled={!isRuntimeReady || path.trim().length === 0 || isPreviewing || isCreating}
						>
							{isPreviewing ? t("projects.validating") : t("projects.preview.action")}
						</Button>
					</form>
				)}
			</div>
			{notice ? (
				<p className="project-form-notice" role="status">
					{notice}
				</p>
			) : null}
			{error ? (
				<p className="session-sidebar__error" role="alert">
					{error}
				</p>
			) : null}
			{preview ? (
				<>
					<PathPreviewDetails preview={preview} name={name} onNameChange={setName} />
					<div className="project-add__actions">
						<Button
							className="chat-button"
							isDisabled={isCreating}
							onPress={() => setPreview(undefined)}
						>
							{t("action.cancel")}
						</Button>
						<Button
							className="chat-button chat-button--primary"
							isDisabled={isCreating || name.trim().length === 0}
							onPress={() => void confirm()}
						>
							{isCreating ? t("projects.creating") : t("projects.createConfirm")}
						</Button>
					</div>
				</>
			) : null}
		</section>
	);
}
