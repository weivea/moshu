import type { GetProjectOutput, Project } from "@moshu/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopClient } from "../../lib/rpc";
import { useRuntimeBoxes } from "../runtime-boxes";
import { useProjectData } from "./project-data";
import { useProjectQuery } from "./use-project-query";

export function useProjectDetail(projectId: string | undefined, checkPath = false) {
	const runtimeBoxes = useRuntimeBoxes();
	const projectData = useProjectData();
	const projectRevision = projectId === undefined ? 0 : projectData.getProjectRevision(projectId);
	const load = useCallback(() => {
		if (projectId === undefined) {
			return Promise.reject(new Error("Project route is missing its Project ID."));
		}
		return desktopClient.getProject(projectId);
	}, [projectId]);
	const query = useProjectQuery<GetProjectOutput>(
		`${projectId ?? "missing"}:${projectRevision}`,
		load,
		{ enabled: projectId !== undefined, retainData: true },
	);
	const [checkedProject, setCheckedProject] = useState<{
		project: Project;
		authoritativeProject: Project;
	}>();
	const [healthError, setHealthError] = useState<Error>();
	const [isCheckingPath, setIsCheckingPath] = useState(false);
	const checkRequestRef = useRef(0);
	const previousProjectIdRef = useRef(projectId);
	const queryProject = query.data?.project;
	const authoritativeProject = queryProject?.id === projectId ? queryProject : undefined;
	const project =
		authoritativeProject === undefined
			? checkedProject !== undefined && checkedProject.project.id === projectId
				? checkedProject.project
				: undefined
			: checkedProject?.authoritativeProject === authoritativeProject
				? checkedProject.project
				: authoritativeProject;
	const runtimeReady =
		project !== undefined && runtimeBoxes.isRuntimeBoxReady(project.runtimeBoxId);

	useLayoutEffect(() => {
		if (previousProjectIdRef.current === projectId) {
			return;
		}
		previousProjectIdRef.current = projectId;
		checkRequestRef.current += 1;
		setCheckedProject(undefined);
		setHealthError(undefined);
		setIsCheckingPath(false);
	}, [projectId]);

	useEffect(() => {
		if (
			authoritativeProject === undefined ||
			checkedProject === undefined ||
			checkedProject.authoritativeProject === authoritativeProject
		) {
			return;
		}
		checkRequestRef.current += 1;
		setCheckedProject(undefined);
		setIsCheckingPath(false);
	}, [authoritativeProject, checkedProject]);

	useEffect(() => {
		const candidate = authoritativeProject;
		if (
			!checkPath ||
			candidate === undefined ||
			candidate.archivedAt !== undefined ||
			candidate.deletionRequestedAt !== undefined ||
			!runtimeBoxes.isRuntimeBoxReady(candidate.runtimeBoxId)
		) {
			return;
		}
		const requestId = checkRequestRef.current + 1;
		checkRequestRef.current = requestId;
		setIsCheckingPath(true);
		setHealthError(undefined);
		void desktopClient
			.checkProjectPath(candidate.id)
			.then((output) => {
				if (checkRequestRef.current === requestId) {
					setCheckedProject({
						project: output.project,
						authoritativeProject: candidate,
					});
				}
			})
			.catch((caught: unknown) => {
				if (checkRequestRef.current === requestId) {
					setHealthError(
						caught instanceof Error ? caught : new Error("Unable to check Project path."),
					);
				}
			})
			.finally(() => {
				if (checkRequestRef.current === requestId) {
					setIsCheckingPath(false);
				}
			});
		return () => {
			checkRequestRef.current += 1;
		};
	}, [authoritativeProject, checkPath, runtimeBoxes]);

	const refreshPath = useCallback(async () => {
		if (project === undefined) {
			return false;
		}
		const requestId = checkRequestRef.current + 1;
		checkRequestRef.current = requestId;
		setIsCheckingPath(true);
		setHealthError(undefined);
		try {
			const output = await desktopClient.checkProjectPath(project.id);
			if (checkRequestRef.current === requestId) {
				if (authoritativeProject !== undefined) {
					setCheckedProject({
						project: output.project,
						authoritativeProject,
					});
				}
				projectData.invalidateProject(project.id);
			}
			return true;
		} catch (caught) {
			if (checkRequestRef.current === requestId) {
				setHealthError(
					caught instanceof Error ? caught : new Error("Unable to check Project path."),
				);
			}
			return false;
		} finally {
			if (checkRequestRef.current === requestId) {
				setIsCheckingPath(false);
			}
		}
	}, [authoritativeProject, project, projectData]);

	return {
		...query,
		project,
		sessionCounts: queryProject?.id === projectId ? query.data?.sessionCounts : undefined,
		runtimeReady,
		healthError,
		isCheckingPath,
		refreshPath,
	};
}
