import {
	type CreateProjectOutput,
	createProjectOutputSchema,
	type DeleteProjectInput,
	type DeleteProjectOutput,
	deleteProjectInputSchema,
	deleteProjectOutputSchema,
	type GetProjectInput,
	type GetProjectOutput,
	getProjectInputSchema,
	getProjectOutputSchema,
	type ListProjectsInput,
	type ListProjectsOutput,
	listProjectsInputSchema,
	listProjectsOutputSchema,
	projectNameSchema,
	projectPathSchema,
	projectSchema,
	type SetProjectArchivedInput,
	type SetProjectArchivedOutput,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	type UpdateProjectInput,
	type UpdateProjectOutput,
	updateProjectInputSchema,
	updateProjectOutputSchema,
} from "@moshu/contracts";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import type { RuntimeBoxRepository } from "./runtime-box-repository";
import { projectsTable } from "./schema";

type ProjectRow = typeof projectsTable.$inferSelect;

interface RepositoryClock {
	now(): number;
}

interface RepositoryIdGenerator {
	create(nowMs?: number): string;
}

export interface CreateProjectRecordInput {
	runtimeBoxId: string;
	name: string;
	path: string;
	gitRootPath?: string;
	gitBranch?: string;
}

export class ProjectNotFoundError extends Error {
	constructor(readonly projectId: string) {
		super(`Project ${projectId} was not found.`);
		this.name = "ProjectNotFoundError";
	}
}

export class ProjectPathConflictError extends Error {
	constructor(
		readonly runtimeBoxId: string,
		readonly path: string,
	) {
		super(`Project path ${path} is already registered for Runtime Box ${runtimeBoxId}.`);
		this.name = "ProjectPathConflictError";
	}
}

export interface ProjectRepository {
	create(input: CreateProjectRecordInput): CreateProjectOutput;
	list(input?: ListProjectsInput): ListProjectsOutput;
	get(input: GetProjectInput): GetProjectOutput;
	update(input: UpdateProjectInput): UpdateProjectOutput;
	setArchived(input: SetProjectArchivedInput): SetProjectArchivedOutput;
	delete(input: DeleteProjectInput): DeleteProjectOutput;
}

export class SqliteProjectRepository implements ProjectRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly runtimeBoxes: RuntimeBoxRepository,
		private readonly idGenerator: RepositoryIdGenerator = { create: createUuidV7 },
		private readonly clock: RepositoryClock = { now: Date.now },
	) {}

	create(inputValue: CreateProjectRecordInput): CreateProjectOutput {
		const runtimeBoxId = inputValue.runtimeBoxId;
		const name = projectNameSchema.parse(inputValue.name);
		const path = projectPathSchema.parse(inputValue.path);
		const gitRootPath =
			inputValue.gitRootPath === undefined
				? undefined
				: projectPathSchema.parse(inputValue.gitRootPath);
		this.runtimeBoxes.get(runtimeBoxId);
		const existing = this.orm
			.select({ id: projectsTable.id })
			.from(projectsTable)
			.where(and(eq(projectsTable.runtimeBoxId, runtimeBoxId), eq(projectsTable.path, path)))
			.get();
		if (existing !== undefined) {
			throw new ProjectPathConflictError(runtimeBoxId, path);
		}
		const now = this.clock.now();
		const row: typeof projectsTable.$inferInsert = {
			id: this.idGenerator.create(now),
			runtimeBoxId,
			name,
			path,
			gitRootPath: gitRootPath ?? null,
			gitBranch: inputValue.gitBranch ?? null,
			createdAtMs: now,
			updatedAtMs: now,
			archivedAtMs: null,
		};
		this.orm.insert(projectsTable).values(row).run();
		return createProjectOutputSchema.parse({ project: buildProject(row as ProjectRow) });
	}

	list(inputValue: ListProjectsInput = {}): ListProjectsOutput {
		const input = listProjectsInputSchema.parse(inputValue);
		const runtimeBoxId = input.runtimeBoxId ?? this.runtimeBoxes.getActive().runtimeBoxId;
		this.runtimeBoxes.get(runtimeBoxId);
		const rows = this.orm
			.select()
			.from(projectsTable)
			.where(
				and(
					eq(projectsTable.runtimeBoxId, runtimeBoxId),
					input.archived
						? isNotNull(projectsTable.archivedAtMs)
						: isNull(projectsTable.archivedAtMs),
				),
			)
			.orderBy(desc(projectsTable.updatedAtMs), desc(projectsTable.id))
			.limit(input.limit ?? 100)
			.all();
		return listProjectsOutputSchema.parse({ items: rows.map(buildProject) });
	}

	get(inputValue: GetProjectInput): GetProjectOutput {
		const input = getProjectInputSchema.parse(inputValue);
		return getProjectOutputSchema.parse({ project: buildProject(this.#select(input.projectId)) });
	}

	update(inputValue: UpdateProjectInput): UpdateProjectOutput {
		const input = updateProjectInputSchema.parse(inputValue);
		this.#select(input.projectId);
		this.orm
			.update(projectsTable)
			.set({ name: input.name, updatedAtMs: this.clock.now() })
			.where(eq(projectsTable.id, input.projectId))
			.run();
		return updateProjectOutputSchema.parse({
			project: buildProject(this.#select(input.projectId)),
		});
	}

	setArchived(inputValue: SetProjectArchivedInput): SetProjectArchivedOutput {
		const input = setProjectArchivedInputSchema.parse(inputValue);
		this.#select(input.projectId);
		const now = this.clock.now();
		this.orm
			.update(projectsTable)
			.set({
				archivedAtMs: input.archived ? now : null,
				updatedAtMs: now,
			})
			.where(eq(projectsTable.id, input.projectId))
			.run();
		return setProjectArchivedOutputSchema.parse({
			project: buildProject(this.#select(input.projectId)),
		});
	}

	delete(inputValue: DeleteProjectInput): DeleteProjectOutput {
		const input = deleteProjectInputSchema.parse(inputValue);
		this.#select(input.projectId);
		this.orm.delete(projectsTable).where(eq(projectsTable.id, input.projectId)).run();
		return deleteProjectOutputSchema.parse({ deletedProjectId: input.projectId });
	}

	#select(projectId: string): ProjectRow {
		const row = this.orm.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
		if (row === undefined) {
			throw new ProjectNotFoundError(projectId);
		}
		return row;
	}
}

function buildProject(row: ProjectRow) {
	return projectSchema.parse({
		schemaVersion: 1,
		id: row.id,
		runtimeBoxId: row.runtimeBoxId,
		name: row.name,
		path: row.path,
		...(row.gitRootPath === null ? {} : { gitRootPath: row.gitRootPath }),
		...(row.gitBranch === null ? {} : { gitBranch: row.gitBranch }),
		createdAt: new Date(row.createdAtMs).toISOString(),
		updatedAt: new Date(row.updatedAtMs).toISOString(),
		...(row.archivedAtMs === null ? {} : { archivedAt: new Date(row.archivedAtMs).toISOString() }),
	});
}
