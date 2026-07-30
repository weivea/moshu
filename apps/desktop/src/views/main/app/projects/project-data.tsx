import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

interface ProjectDataContextValue {
	revision: number;
	getRuntimeRevision(runtimeBoxId: string): number;
	getProjectRevision(projectId: string): number;
	invalidateRuntime(runtimeBoxId: string): void;
	invalidateProject(projectId: string, runtimeBoxId?: string): void;
}

const fallbackContext: ProjectDataContextValue = {
	revision: 0,
	getRuntimeRevision: () => 0,
	getProjectRevision: () => 0,
	invalidateRuntime: () => undefined,
	invalidateProject: () => undefined,
};
const ProjectDataContext = createContext<ProjectDataContextValue>(fallbackContext);

export function ProjectDataProvider({ children }: { children: ReactNode }) {
	const runtimeRevisions = useRef(new Map<string, number>());
	const projectRevisions = useRef(new Map<string, number>());
	const [revision, setRevision] = useState(0);
	const bump = useCallback(() => setRevision((current) => current + 1), []);
	const invalidateRuntime = useCallback(
		(runtimeBoxId: string) => {
			runtimeRevisions.current.set(
				runtimeBoxId,
				(runtimeRevisions.current.get(runtimeBoxId) ?? 0) + 1,
			);
			bump();
		},
		[bump],
	);
	const invalidateProject = useCallback(
		(projectId: string, runtimeBoxId?: string) => {
			projectRevisions.current.set(projectId, (projectRevisions.current.get(projectId) ?? 0) + 1);
			if (runtimeBoxId !== undefined) {
				runtimeRevisions.current.set(
					runtimeBoxId,
					(runtimeRevisions.current.get(runtimeBoxId) ?? 0) + 1,
				);
			}
			bump();
		},
		[bump],
	);
	const value = useMemo<ProjectDataContextValue>(
		() => ({
			revision,
			getRuntimeRevision: (runtimeBoxId) => runtimeRevisions.current.get(runtimeBoxId) ?? 0,
			getProjectRevision: (projectId) => projectRevisions.current.get(projectId) ?? 0,
			invalidateRuntime,
			invalidateProject,
		}),
		[invalidateProject, invalidateRuntime, revision],
	);
	return <ProjectDataContext.Provider value={value}>{children}</ProjectDataContext.Provider>;
}

export function useProjectData(): ProjectDataContextValue {
	return useContext(ProjectDataContext);
}
