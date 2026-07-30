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
	projectGitBranchSchema,
	type Project,
	type ProjectPathIssueCode,
	projectPathIssueCodeSchema,
	projectPathSchema,
	type ProjectPathStatus,
	projectPathStatusSchema,
	type ProjectSessionCounts,
	projectSessionCountsSchema,
	projectSchema,
	type GetProjectSidebarInput,
	type GetProjectSidebarOutput,
	getProjectSidebarInputSchema,
	getProjectSidebarOutputSchema,
	isoDateTimeSchema,
	type SetProjectArchivedInput,
	type SetProjectArchivedOutput,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	type UpdateProjectInput,
	type UpdateProjectOutput,
	updateProjectInputSchema,
	updateProjectOutputSchema,
} from "@moshu/contracts";
import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { AppDrizzleDatabase } from "./database";
import { createUuidV7 } from "./ids";
import type { RuntimeBoxRepository } from "./runtime-box-repository";
import { chatSessionsTable, projectDeletionJobsTable, projectsTable } from "./schema";

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
	pathStatus?: ProjectPathStatus;
	pathCheckedAt?: string;
	pathIssueCode?: ProjectPathIssueCode;
}

export interface UpdateProjectPathHealthInput {
	projectId: string;
	status: ProjectPathStatus;
	checkedAt: string;
	issueCode?: ProjectPathIssueCode;
	gitRootPath?: string;
	gitBranch?: string;
}

export interface RelinkProjectRecordInput {
	projectId: string;
	path: string;
	gitRootPath?: string;
	gitBranch?: string;
	checkedAt: string;
}

export interface ProjectDeletionJob {
	projectId: string;
	state: "pending" | "processing" | "blocked";
	attemptCount: number;
	nextAttemptAtMs: number;
	lastAttemptAtMs?: number;
	lastErrorCode?: string;
}

export type ProjectDeletionJobState = ProjectDeletionJob["state"];

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
		readonly conflictingProjectId: string,
		readonly conflictingProjectArchived: boolean,
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
	updatePathHealth(input: UpdateProjectPathHealthInput): Project;
	relinkPath(input: RelinkProjectRecordInput): Project;
	getSessionCounts(projectId: string): ProjectSessionCounts;
	getSidebar(input?: GetProjectSidebarInput): GetProjectSidebarOutput;
	requestDeletion(projectId: string): Project;
	isDeleting(projectId: string): boolean;
	listPendingDeletionJobs(limit: number, includeDeferred?: boolean): ProjectDeletionJob[];
	listDeletionSessionIds(projectId: string, limit: number): string[];
	recordDeletionJobAttempt(
		projectId: string,
		state: ProjectDeletionJobState,
		nextAttemptAtMs: number,
		errorCode?: string,
	): void;
	completeDeletion(projectId: string): void;
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
		const pathStatus = projectPathStatusSchema.parse(inputValue.pathStatus ?? "unknown");
		const pathIssueCode =
			inputValue.pathIssueCode === undefined
				? undefined
				: projectPathIssueCodeSchema.parse(inputValue.pathIssueCode);
		const pathCheckedAtMs =
			inputValue.pathCheckedAt === undefined
				? null
				: requireIsoTimestamp(inputValue.pathCheckedAt, "Project path checkedAt");
		assertProjectPathHealth(pathStatus, pathIssueCode);
		const existing = this.orm
			.select({ id: projectsTable.id, archivedAtMs: projectsTable.archivedAtMs })
			.from(projectsTable)
			.where(and(eq(projectsTable.runtimeBoxId, runtimeBoxId), eq(projectsTable.path, path)))
			.get();
		if (existing !== undefined) {
			throw new ProjectPathConflictError(
				runtimeBoxId,
				path,
				existing.id,
				existing.archivedAtMs !== null,
			);
		}
		const now = this.clock.now();
		const row: typeof projectsTable.$inferInsert = {
			id: this.idGenerator.create(now),
			runtimeBoxId,
			name,
			path,
			pathRevision: 1,
			pathStatus,
			pathCheckedAtMs,
			pathIssueCode: pathIssueCode ?? null,
			gitRootPath: gitRootPath ?? null,
			gitBranch: parseGitBranch(inputValue.gitBranch) ?? null,
			createdAtMs: now,
			updatedAtMs: now,
			archivedAtMs: null,
			deletionRequestedAtMs: null,
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
					isNull(projectsTable.deletionRequestedAtMs),
				),
			)
			.orderBy(desc(projectsTable.createdAtMs), desc(projectsTable.id))
			.limit(input.limit ?? 100)
			.all();
		return listProjectsOutputSchema.parse({ items: rows.map(buildProject) });
	}

	get(inputValue: GetProjectInput): GetProjectOutput {
		const input = getProjectInputSchema.parse(inputValue);
		const project = buildProject(this.#select(input.projectId));
		return getProjectOutputSchema.parse({
			project,
			sessionCounts: this.getSessionCounts(project.id),
		});
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

	updatePathHealth(input: UpdateProjectPathHealthInput): Project {
		const status = projectPathStatusSchema.parse(input.status);
		const issueCode =
			input.issueCode === undefined ? undefined : projectPathIssueCodeSchema.parse(input.issueCode);
		assertProjectPathHealth(status, issueCode);
		this.#select(input.projectId);
		const now = this.clock.now();
		this.orm
			.update(projectsTable)
			.set({
				pathStatus: status,
				pathCheckedAtMs: requireIsoTimestamp(input.checkedAt, "Project path checkedAt"),
				pathIssueCode: issueCode ?? null,
				...(status === "available"
					? {
							gitRootPath:
								input.gitRootPath === undefined ? null : projectPathSchema.parse(input.gitRootPath),
							gitBranch: parseGitBranch(input.gitBranch) ?? null,
						}
					: {}),
				updatedAtMs: now,
			})
			.where(eq(projectsTable.id, input.projectId))
			.run();
		return buildProject(this.#select(input.projectId));
	}

	relinkPath(input: RelinkProjectRecordInput): Project {
		const project = this.#select(input.projectId);
		const path = projectPathSchema.parse(input.path);
		const conflict = this.orm
			.select({ id: projectsTable.id, archivedAtMs: projectsTable.archivedAtMs })
			.from(projectsTable)
			.where(
				and(eq(projectsTable.runtimeBoxId, project.runtimeBoxId), eq(projectsTable.path, path)),
			)
			.get();
		if (conflict !== undefined && conflict.id !== project.id) {
			throw new ProjectPathConflictError(
				project.runtimeBoxId,
				path,
				conflict.id,
				conflict.archivedAtMs !== null,
			);
		}
		const now = this.clock.now();
		this.orm
			.update(projectsTable)
			.set({
				path,
				pathRevision: project.pathRevision + 1,
				pathStatus: "available",
				pathCheckedAtMs: requireIsoTimestamp(input.checkedAt, "Project path checkedAt"),
				pathIssueCode: null,
				gitRootPath:
					input.gitRootPath === undefined ? null : projectPathSchema.parse(input.gitRootPath),
				gitBranch: parseGitBranch(input.gitBranch) ?? null,
				updatedAtMs: now,
			})
			.where(eq(projectsTable.id, project.id))
			.run();
		return buildProject(this.#select(project.id));
	}

	getSessionCounts(projectId: string): ProjectSessionCounts {
		this.#select(projectId);
		const counts = this.orm
			.select({
				total: sql<number>`count(*)`,
				active: sql<number>`sum(CASE WHEN ${chatSessionsTable.archivedAtMs} IS NULL THEN 1 ELSE 0 END)`,
			})
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.projectId, projectId))
			.get();
		const total = counts?.total ?? 0;
		const active = counts?.active ?? 0;
		return projectSessionCountsSchema.parse({ active, archived: total - active, total });
	}

	getSidebar(inputValue: GetProjectSidebarInput = {}): GetProjectSidebarOutput {
		const input = getProjectSidebarInputSchema.parse(inputValue);
		const projects = this.list({
			...(input.runtimeBoxId === undefined ? {} : { runtimeBoxId: input.runtimeBoxId }),
			limit: 200,
		}).items;
		const items = projects.map((project) => {
			const recentRows = this.orm
				.select()
				.from(chatSessionsTable)
				.where(
					and(eq(chatSessionsTable.projectId, project.id), isNull(chatSessionsTable.archivedAtMs)),
				)
				.orderBy(
					desc(
						sql`coalesce(${chatSessionsTable.lastMessageAtMs}, ${chatSessionsTable.updatedAtMs})`,
					),
					desc(chatSessionsTable.id),
				)
				.limit(8)
				.all();
			return {
				project,
				activeSessionCount: this.getSessionCounts(project.id).active,
				recentSessions: recentRows.map((row) => ({
					id: row.id,
					title: row.title,
					updatedAt: new Date(row.updatedAtMs).toISOString(),
					...(row.lastMessageAtMs === null
						? {}
						: { lastMessageAt: new Date(row.lastMessageAtMs).toISOString() }),
				})),
			};
		});
		return getProjectSidebarOutputSchema.parse({ items });
	}

	requestDeletion(projectId: string): Project {
		const existing = this.#select(projectId, true);
		if (existing.deletionRequestedAtMs !== null) {
			return buildProject(existing);
		}

		const now = this.clock.now();
		this.orm.transaction((transaction) => {
			transaction
				.update(projectsTable)
				.set({ deletionRequestedAtMs: now, updatedAtMs: now })
				.where(eq(projectsTable.id, projectId))
				.run();
			transaction
				.insert(projectDeletionJobsTable)
				.values({
					projectId,
					state: "pending",
					attemptCount: 0,
					nextAttemptAtMs: now,
					createdAtMs: now,
					updatedAtMs: now,
				})
				.run();
		});
		return buildProject(this.#select(projectId, true));
	}

	isDeleting(projectId: string): boolean {
		return (
			this.orm
				.select({ id: projectsTable.id })
				.from(projectsTable)
				.where(and(eq(projectsTable.id, projectId), isNotNull(projectsTable.deletionRequestedAtMs)))
				.get() !== undefined
		);
	}

	listPendingDeletionJobs(limit: number, includeDeferred = false): ProjectDeletionJob[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new TypeError("Project deletion job limit must be between 1 and 100.");
		}
		const rows = this.orm
			.select()
			.from(projectDeletionJobsTable)
			.where(
				includeDeferred
					? undefined
					: lte(projectDeletionJobsTable.nextAttemptAtMs, this.clock.now()),
			)
			.orderBy(
				asc(projectDeletionJobsTable.nextAttemptAtMs),
				asc(projectDeletionJobsTable.createdAtMs),
				asc(projectDeletionJobsTable.projectId),
			)
			.limit(limit)
			.all();
		return rows.map((row) => ({
			projectId: row.projectId,
			state: row.state,
			attemptCount: row.attemptCount,
			nextAttemptAtMs: row.nextAttemptAtMs,
			...(row.lastAttemptAtMs === null ? {} : { lastAttemptAtMs: row.lastAttemptAtMs }),
			...(row.lastErrorCode === null ? {} : { lastErrorCode: row.lastErrorCode }),
		}));
	}

	listDeletionSessionIds(projectId: string, limit: number): string[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new TypeError("Project deletion Session batch limit must be between 1 and 100.");
		}
		this.#select(projectId, true);
		return this.orm
			.select({ id: chatSessionsTable.id })
			.from(chatSessionsTable)
			.where(eq(chatSessionsTable.projectId, projectId))
			.orderBy(asc(chatSessionsTable.createdAtMs), asc(chatSessionsTable.id))
			.limit(limit)
			.all()
			.map((row) => row.id);
	}

	recordDeletionJobAttempt(
		projectId: string,
		state: ProjectDeletionJobState,
		nextAttemptAtMs: number,
		errorCode?: string,
	): void {
		if (!Number.isSafeInteger(nextAttemptAtMs) || nextAttemptAtMs < 0) {
			throw new TypeError("Project deletion retry time must be a non-negative safe integer.");
		}
		this.#select(projectId, true);
		const now = this.clock.now();
		this.orm
			.update(projectDeletionJobsTable)
			.set({
				state,
				attemptCount: sql`${projectDeletionJobsTable.attemptCount} + 1`,
				nextAttemptAtMs,
				lastAttemptAtMs: now,
				lastErrorCode: errorCode?.slice(0, 128) ?? null,
				updatedAtMs: now,
			})
			.where(eq(projectDeletionJobsTable.projectId, projectId))
			.run();
	}

	completeDeletion(projectId: string): void {
		this.orm.transaction((transaction) => {
			const remaining =
				transaction
					.select({ count: sql<number>`count(*)` })
					.from(chatSessionsTable)
					.where(eq(chatSessionsTable.projectId, projectId))
					.get()?.count ?? 0;
			if (remaining > 0) {
				throw new Error("Cannot complete Project deletion while Sessions remain.");
			}
			transaction.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();
		});
	}

	#select(projectId: string, includeDeleting = false): ProjectRow {
		const row = this.orm
			.select()
			.from(projectsTable)
			.where(
				and(
					eq(projectsTable.id, projectId),
					includeDeleting ? undefined : isNull(projectsTable.deletionRequestedAtMs),
				),
			)
			.get();
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
		pathRevision: row.pathRevision,
		pathStatus: row.pathStatus,
		...(row.pathCheckedAtMs === null
			? {}
			: { pathCheckedAt: new Date(row.pathCheckedAtMs).toISOString() }),
		...(row.pathIssueCode === null ? {} : { pathIssueCode: row.pathIssueCode }),
		...(row.gitRootPath === null ? {} : { gitRootPath: row.gitRootPath }),
		...(row.gitBranch === null ? {} : { gitBranch: row.gitBranch }),
		createdAt: new Date(row.createdAtMs).toISOString(),
		updatedAt: new Date(row.updatedAtMs).toISOString(),
		...(row.archivedAtMs === null ? {} : { archivedAt: new Date(row.archivedAtMs).toISOString() }),
		...(row.deletionRequestedAtMs === null
			? {}
			: { deletionRequestedAt: new Date(row.deletionRequestedAtMs).toISOString() }),
	});
}

function assertProjectPathHealth(
	status: ProjectPathStatus,
	issueCode: ProjectPathIssueCode | undefined,
): void {
	if ((status === "unavailable") !== (issueCode !== undefined)) {
		throw new TypeError("Unavailable Project paths require exactly one stable issue code.");
	}
}

function requireIsoTimestamp(value: string, label: string): number {
	const result = isoDateTimeSchema.safeParse(value);
	if (!result.success) {
		throw new TypeError(`${label} must be an ISO date-time.`);
	}
	return Date.parse(result.data);
}

function parseGitBranch(value: string | undefined): string | undefined {
	return value === undefined ? undefined : projectGitBranchSchema.parse(value);
}
