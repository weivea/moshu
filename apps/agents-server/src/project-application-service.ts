import { createHash } from "node:crypto";
import {
	type CheckProjectPathInput,
	type CheckProjectPathOutput,
	type ConfirmCreateProjectInput,
	type ConfirmCreateProjectOutput,
	checkProjectPathInputSchema,
	checkProjectPathOutputSchema,
	confirmCreateProjectInputSchema,
	confirmCreateProjectOutputSchema,
	type GetProjectDeleteConfirmationInput,
	type GetProjectDeleteConfirmationOutput,
	type GetProjectInput,
	type GetProjectOutput,
	type GetProjectSidebarInput,
	type GetProjectSidebarOutput,
	getProjectDeleteConfirmationInputSchema,
	getProjectDeleteConfirmationOutputSchema,
	type ListProjectsInput,
	type ListProjectsOutput,
	type PreviewProjectPathInput,
	type PreviewProjectPathOutput,
	type PreviewProjectRelinkInput,
	type PreviewProjectRelinkOutput,
	type Project,
	type ProjectRootAgentsIssueCode,
	type ProjectRunContext,
	previewProjectPathInputSchema,
	previewProjectPathOutputSchema,
	previewProjectRelinkInputSchema,
	projectRunContextSchema,
	type ReadRuntimeBoxProjectRootAgentsInput,
	type ReadRuntimeBoxProjectRootAgentsOutput,
	type RelinkProjectInput,
	type RelinkProjectOutput,
	type RequestProjectDeletionInput,
	type RequestProjectDeletionOutput,
	relinkProjectInputSchema,
	relinkProjectOutputSchema,
	requestProjectDeletionInputSchema,
	requestProjectDeletionOutputSchema,
	type SetProjectArchivedInput,
	type SetProjectArchivedOutput,
	setProjectArchivedInputSchema,
	setProjectArchivedOutputSchema,
	type UpdateProjectInput,
	type UpdateProjectOutput,
	updateProjectInputSchema,
	updateProjectOutputSchema,
	type ValidateRuntimeBoxProjectPathInput,
	type ValidateRuntimeBoxProjectPathOutput,
} from "@moshu/contracts";
import {
	type ActionRepository,
	type ProjectRepository,
	type RunJournalRepository,
	type RuntimeBoxRepository,
	SessionRetirementCapacityError,
} from "@moshu/database";
import { RuntimeBoxUnavailableError } from "./runtime-box-registry";

export interface ProjectPathInspector {
	validateProjectPath(
		runtimeBoxId: string,
		input: ValidateRuntimeBoxProjectPathInput,
		signal?: AbortSignal,
	): Promise<ValidateRuntimeBoxProjectPathOutput>;
	readProjectRootAgents?(
		runtimeBoxId: string,
		input: ReadRuntimeBoxProjectRootAgentsInput,
		signal?: AbortSignal,
	): Promise<ReadRuntimeBoxProjectRootAgentsOutput>;
}

export interface ProjectRunPreflightResult {
	projectContext: ProjectRunContext;
	projectName: string;
	runtimePlatform: "darwin" | "win32" | "linux";
	rootAgentsBody?: string;
	rootAgentsWarning?: ProjectRootAgentsIssueCode;
}

export interface ProjectApplicationServiceOptions {
	projects: ProjectRepository;
	runs: RunJournalRepository;
	actions: ActionRepository;
	runtimeBoxes: RuntimeBoxRepository;
	pathInspector: ProjectPathInspector;
	onSessionsRetired?: (sessionIds: readonly string[]) => void;
	reportDiagnostic?: (message: string) => void;
	clock?: { now(): number };
	deletionBatchSize?: number;
	deletionRetryDelayMs?: number;
	deletionRetryScheduler?: ProjectDeletionRetryScheduler;
	deletionYield?: () => Promise<void>;
}

export interface ProjectDeletionRetryScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export class ProjectPreviewStaleError extends Error {
	constructor() {
		super("The Project path preview is stale.");
		this.name = "ProjectPreviewStaleError";
	}
}

export class ProjectPathUnavailableError extends Error {
	constructor(readonly issueCode: string) {
		super("The Project path is unavailable.");
		this.name = "ProjectPathUnavailableError";
	}
}

export class ProjectRuntimeUnavailableError extends Error {
	constructor() {
		super("The Project Runtime Box is unavailable.");
		this.name = "ProjectRuntimeUnavailableError";
	}
}

export class ProjectArchivedError extends Error {
	constructor() {
		super("The archived Project cannot be modified.");
		this.name = "ProjectArchivedError";
	}
}

export class ProjectDeletingError extends Error {
	constructor() {
		super("The Project is being deleted.");
		this.name = "ProjectDeletingError";
	}
}

export class ProjectHasActiveRunsError extends Error {
	constructor() {
		super("The Project has non-terminal Runs.");
		this.name = "ProjectHasActiveRunsError";
	}
}

export class ProjectHasUnacknowledgedActionsError extends Error {
	constructor() {
		super("The Project has unacknowledged Actions.");
		this.name = "ProjectHasUnacknowledgedActionsError";
	}
}

export class ProjectNameConfirmationMismatchError extends Error {
	constructor() {
		super("The Project name confirmation did not match.");
		this.name = "ProjectNameConfirmationMismatchError";
	}
}

export class ProjectRelinkRuntimeMismatchError extends Error {
	constructor() {
		super("A Project can only be relinked on its existing Runtime Box.");
		this.name = "ProjectRelinkRuntimeMismatchError";
	}
}

export class ProjectApplicationService {
	readonly #projects: ProjectRepository;
	readonly #runs: RunJournalRepository;
	readonly #actions: ActionRepository;
	readonly #runtimeBoxes: RuntimeBoxRepository;
	readonly #pathInspector: ProjectPathInspector;
	readonly #onSessionsRetired: ((sessionIds: readonly string[]) => void) | undefined;
	readonly #reportDiagnostic: (message: string) => void;
	readonly #clock: { now(): number };
	readonly #deletionBatchSize: number;
	readonly #deletionRetryDelayMs: number;
	readonly #deletionRetryScheduler: ProjectDeletionRetryScheduler;
	readonly #deletionYield: () => Promise<void>;
	readonly #mutationTails = new Map<string, Promise<void>>();
	#deletionDrain: Promise<void> | undefined;
	#deletionTimer: unknown;
	#shuttingDown = false;

	constructor(options: ProjectApplicationServiceOptions) {
		this.#projects = options.projects;
		this.#runs = options.runs;
		this.#actions = options.actions;
		this.#runtimeBoxes = options.runtimeBoxes;
		this.#pathInspector = options.pathInspector;
		this.#onSessionsRetired = options.onSessionsRetired;
		this.#reportDiagnostic = options.reportDiagnostic ?? (() => undefined);
		this.#clock = options.clock ?? { now: Date.now };
		this.#deletionBatchSize = options.deletionBatchSize ?? 32;
		this.#deletionRetryDelayMs = options.deletionRetryDelayMs ?? 1_000;
		this.#deletionRetryScheduler = options.deletionRetryScheduler ?? {
			setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.#deletionYield =
			options.deletionYield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
		if (
			!Number.isSafeInteger(this.#deletionBatchSize) ||
			this.#deletionBatchSize < 1 ||
			this.#deletionBatchSize > 100
		) {
			throw new TypeError("Project deletion batch size must be between 1 and 100.");
		}
		if (
			!Number.isSafeInteger(this.#deletionRetryDelayMs) ||
			this.#deletionRetryDelayMs < 1 ||
			this.#deletionRetryDelayMs > 86_400_000
		) {
			throw new TypeError("Project deletion retry delay must be between 1 ms and 24 hours.");
		}
	}

	// A Project inherits the creating client's currently selected Runtime Box when the caller does not
	// pin one explicitly. Selection is a per-client preference keyed by the authenticated peer id;
	// callers never supply a raw client id. Falls back to the global default for internal callers.
	#resolveActiveRuntimeBoxId(clientId: string | undefined): string {
		return clientId === undefined
			? this.#runtimeBoxes.getActive().runtimeBoxId
			: this.#runtimeBoxes.getActiveForClient(clientId).runtimeBoxId;
	}

	previewPath(
		inputValue: PreviewProjectPathInput,
		clientId?: string,
		signal?: AbortSignal,
	): Promise<PreviewProjectPathOutput> {
		const input = previewProjectPathInputSchema.parse(inputValue);
		const runtimeBoxId = input.runtimeBoxId ?? this.#resolveActiveRuntimeBoxId(clientId);
		return this.#inspectPreview(runtimeBoxId, input.path, signal);
	}

	async create(
		inputValue: ConfirmCreateProjectInput,
		clientId?: string,
		signal?: AbortSignal,
	): Promise<ConfirmCreateProjectOutput> {
		const input = confirmCreateProjectInputSchema.parse(inputValue);
		const runtimeBoxId = input.runtimeBoxId ?? this.#resolveActiveRuntimeBoxId(clientId);
		const inspection = await this.#inspectAvailable(runtimeBoxId, input.path, signal);
		if (
			createProjectConfirmationToken(runtimeBoxId, input.path, inspection) !==
			input.confirmationToken
		) {
			throw new ProjectPreviewStaleError();
		}
		return confirmCreateProjectOutputSchema.parse(
			this.#projects.create({
				runtimeBoxId,
				name: input.name ?? inspection.displayName,
				path: inspection.normalizedPath,
				pathStatus: "available",
				pathCheckedAt: this.#nowIso(),
				...(inspection.gitRootPath === undefined ? {} : { gitRootPath: inspection.gitRootPath }),
				...(inspection.gitBranch === undefined ? {} : { gitBranch: inspection.gitBranch }),
			}),
		);
	}

	list(input: ListProjectsInput = {}): ListProjectsOutput {
		return this.#projects.list(input);
	}

	get(input: GetProjectInput): GetProjectOutput {
		return this.#projects.get(input);
	}

	getSidebar(input: GetProjectSidebarInput = {}): GetProjectSidebarOutput {
		return this.#projects.getSidebar(input);
	}

	async checkPath(
		inputValue: CheckProjectPathInput,
		signal?: AbortSignal,
	): Promise<CheckProjectPathOutput> {
		const input = checkProjectPathInputSchema.parse(inputValue);
		return this.#serialize(input.projectId, async () => {
			return checkProjectPathOutputSchema.parse({
				project: await this.#checkActiveProjectPath(input.projectId, signal),
			});
		});
	}

	withSessionCreation<T>(
		projectId: string,
		createSession: () => T,
		signal?: AbortSignal,
	): Promise<T> {
		return this.#serialize(projectId, async () => {
			const project = await this.#checkActiveProjectPath(projectId, signal);
			if (project.pathStatus === "unavailable") {
				throw new ProjectPathUnavailableError(project.pathIssueCode ?? "unknown");
			}
			return createSession();
		});
	}

	withRunPreflight<T>(
		projectId: string,
		createRun: (preflight: ProjectRunPreflightResult) => T,
		signal?: AbortSignal,
	): Promise<T> {
		return this.#serialize(projectId, async () => {
			if (this.#projects.isDeleting(projectId)) {
				throw new ProjectDeletingError();
			}
			const project = await this.#checkActiveProjectPath(projectId, signal);
			if (project.pathStatus === "unavailable") {
				throw new ProjectPathUnavailableError(project.pathIssueCode ?? "unknown");
			}
			const rootAgents = await this.#readRootAgents(project, signal);
			const rootAgentsHash =
				rootAgents.status === "loaded"
					? createHash("sha256").update(rootAgents.body, "utf8").digest("hex")
					: undefined;
			const runtimeBox = this.#runtimeBoxes.get(project.runtimeBoxId);
			const projectContext = projectRunContextSchema.parse({
				projectId: project.id,
				runtimeBoxId: project.runtimeBoxId,
				projectPath: project.path,
				projectPathRevision: project.pathRevision,
				...(project.gitRootPath === undefined ? {} : { gitRootPath: project.gitRootPath }),
				...(project.gitBranch === undefined ? {} : { gitBranch: project.gitBranch }),
				...(rootAgentsHash === undefined ? {} : { rootAgentsHash }),
			});
			return createRun({
				projectContext,
				projectName: project.name,
				runtimePlatform: runtimeBox.platform,
				...(rootAgents.status === "loaded" ? { rootAgentsBody: rootAgents.body } : {}),
				...(rootAgents.status === "warning" ? { rootAgentsWarning: rootAgents.issueCode } : {}),
			});
		});
	}

	updateName(inputValue: UpdateProjectInput): Promise<UpdateProjectOutput> {
		const input = updateProjectInputSchema.parse(inputValue);
		return this.#serialize(input.projectId, async () => {
			const project = this.#projects.get({ projectId: input.projectId }).project;
			this.#assertActive(project);
			return updateProjectOutputSchema.parse(this.#projects.update(input));
		});
	}

	async previewRelink(
		inputValue: PreviewProjectRelinkInput,
		signal?: AbortSignal,
	): Promise<PreviewProjectRelinkOutput> {
		const input = previewProjectRelinkInputSchema.parse(inputValue);
		const project = this.#projects.get({ projectId: input.projectId }).project;
		this.#assertActive(project);
		return this.#inspectPreview(project.runtimeBoxId, input.path, signal);
	}

	relink(inputValue: RelinkProjectInput, signal?: AbortSignal): Promise<RelinkProjectOutput> {
		const input = relinkProjectInputSchema.parse(inputValue);
		return this.#serialize(input.projectId, async () => {
			const project = this.#projects.get({ projectId: input.projectId }).project;
			this.#assertActive(project);
			if (input.runtimeBoxId !== undefined && input.runtimeBoxId !== project.runtimeBoxId) {
				throw new ProjectRelinkRuntimeMismatchError();
			}
			if (project.pathRevision !== input.expectedPathRevision) {
				throw new ProjectPreviewStaleError();
			}
			this.#assertNoActiveRuns(project.id);
			const inspection = await this.#inspectAvailable(project.runtimeBoxId, input.path, signal);
			if (
				createProjectConfirmationToken(project.runtimeBoxId, input.path, inspection) !==
				input.confirmationToken
			) {
				throw new ProjectPreviewStaleError();
			}
			return relinkProjectOutputSchema.parse({
				project: this.#projects.relinkPath({
					projectId: project.id,
					path: inspection.normalizedPath,
					checkedAt: this.#nowIso(),
					...(inspection.gitRootPath === undefined ? {} : { gitRootPath: inspection.gitRootPath }),
					...(inspection.gitBranch === undefined ? {} : { gitBranch: inspection.gitBranch }),
				}),
			});
		});
	}

	setArchived(inputValue: SetProjectArchivedInput): Promise<SetProjectArchivedOutput> {
		const input = setProjectArchivedInputSchema.parse(inputValue);
		return this.#serialize(input.projectId, async () => {
			this.#projects.get({ projectId: input.projectId });
			this.#assertNoActiveRuns(input.projectId);
			return setProjectArchivedOutputSchema.parse(this.#projects.setArchived(input));
		});
	}

	getDeleteConfirmation(
		inputValue: GetProjectDeleteConfirmationInput,
	): GetProjectDeleteConfirmationOutput {
		const input = getProjectDeleteConfirmationInputSchema.parse(inputValue);
		const result = this.#projects.get(input);
		return getProjectDeleteConfirmationOutputSchema.parse({
			confirmation: {
				projectId: result.project.id,
				projectName: result.project.name,
				sessionCounts: result.sessionCounts,
			},
		});
	}

	requestDeletion(inputValue: RequestProjectDeletionInput): Promise<RequestProjectDeletionOutput> {
		const input = requestProjectDeletionInputSchema.parse(inputValue);
		return this.#serialize(input.projectId, async () => {
			const project = this.#projects.get({ projectId: input.projectId }).project;
			if (project.name !== input.expectedName) {
				throw new ProjectNameConfirmationMismatchError();
			}
			this.#assertNoActiveRuns(project.id);
			if (this.#actions.hasUnacknowledgedForProject(project.id)) {
				throw new ProjectHasUnacknowledgedActionsError();
			}
			const deleting = this.#projects.requestDeletion(project.id);
			this.#ensureDeletionWorker();
			return requestProjectDeletionOutputSchema.parse({
				projectId: deleting.id,
				deletionRequestedAt: deleting.deletionRequestedAt,
			});
		});
	}

	drainPendingDeletions(): Promise<void> {
		if (this.#deletionDrain !== undefined) {
			return this.#deletionDrain;
		}
		const execution = this.#drainPendingDeletions();
		this.#deletionDrain = execution;
		const finish = (): void => {
			if (this.#deletionDrain === execution) {
				this.#deletionDrain = undefined;
			}
		};
		void execution.then(finish, finish);
		return execution;
	}

	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		if (this.#deletionTimer !== undefined) {
			this.#deletionRetryScheduler.clearTimeout(this.#deletionTimer);
			this.#deletionTimer = undefined;
		}
		await this.#deletionDrain;
	}

	async #inspectPreview(
		runtimeBoxId: string,
		path: string,
		signal?: AbortSignal,
	): Promise<PreviewProjectPathOutput> {
		const runtimeBox = this.#runtimeBoxes.get(runtimeBoxId);
		const inspection = await this.#inspectAvailable(runtimeBoxId, path, signal);
		return previewProjectPathOutputSchema.parse({
			preview: {
				schemaVersion: 1,
				runtimeBoxId,
				runtimeBoxDisplayName: runtimeBox.displayName,
				runtimeBoxPlatform: runtimeBox.platform,
				inputPath: path,
				normalizedPath: inspection.normalizedPath,
				displayName: inspection.displayName,
				...(inspection.gitRootPath === undefined ? {} : { gitRootPath: inspection.gitRootPath }),
				...(inspection.gitBranch === undefined ? {} : { gitBranch: inspection.gitBranch }),
				rootAgents: inspection.rootAgents,
				confirmationToken: createProjectConfirmationToken(runtimeBoxId, path, inspection),
			},
		});
	}

	async #inspectAvailable(
		runtimeBoxId: string,
		path: string,
		signal?: AbortSignal,
	): Promise<Extract<ValidateRuntimeBoxProjectPathOutput, { status: "available" }>> {
		this.#runtimeBoxes.get(runtimeBoxId);
		const inspection = await this.#inspect(runtimeBoxId, path, signal);
		if (inspection.status === "unavailable") {
			throw new ProjectPathUnavailableError(inspection.issueCode);
		}
		return inspection;
	}

	async #inspect(
		runtimeBoxId: string,
		path: string,
		signal?: AbortSignal,
	): Promise<ValidateRuntimeBoxProjectPathOutput> {
		let inspection: ValidateRuntimeBoxProjectPathOutput;
		try {
			inspection = await this.#pathInspector.validateProjectPath(runtimeBoxId, { path }, signal);
		} catch (error) {
			if (error instanceof RuntimeBoxUnavailableError) {
				throw new ProjectRuntimeUnavailableError();
			}
			throw error;
		}
		return inspection;
	}

	async #readRootAgents(
		project: Project,
		signal?: AbortSignal,
	): Promise<ReadRuntimeBoxProjectRootAgentsOutput> {
		if (this.#pathInspector.readProjectRootAgents === undefined) {
			return { status: "warning", issueCode: "unknown" };
		}
		try {
			return await this.#pathInspector.readProjectRootAgents(
				project.runtimeBoxId,
				{ projectPath: project.path },
				signal,
			);
		} catch (error) {
			if (error instanceof RuntimeBoxUnavailableError) {
				throw new ProjectRuntimeUnavailableError();
			}
			throw error;
		}
	}

	async #checkActiveProjectPath(projectId: string, signal?: AbortSignal): Promise<Project> {
		const project = this.#projects.get({ projectId }).project;
		this.#assertActive(project);
		const inspection = await this.#inspect(project.runtimeBoxId, project.path, signal);
		const checkedAt = this.#nowIso();
		if (inspection.status === "unavailable") {
			return this.#projects.updatePathHealth({
				projectId: project.id,
				status: "unavailable",
				checkedAt,
				issueCode: inspection.issueCode,
			});
		}
		if (inspection.normalizedPath !== project.path) {
			return this.#projects.updatePathHealth({
				projectId: project.id,
				status: "unavailable",
				checkedAt,
				issueCode: "canonical_path_changed",
			});
		}
		return this.#projects.updatePathHealth({
			projectId: project.id,
			status: "available",
			checkedAt,
			...(inspection.gitRootPath === undefined ? {} : { gitRootPath: inspection.gitRootPath }),
			...(inspection.gitBranch === undefined ? {} : { gitBranch: inspection.gitBranch }),
		});
	}

	async #drainPendingDeletions(): Promise<void> {
		while (!this.#shuttingDown) {
			await this.#deletionYield();
			if (this.#shuttingDown) {
				return;
			}
			const job = this.#projects.listPendingDeletionJobs(1)[0];
			if (job === undefined) {
				const deferred = this.#projects.listPendingDeletionJobs(1, true)[0];
				if (deferred !== undefined) {
					this.#scheduleDeletionRetry(Math.max(0, deferred.nextAttemptAtMs - this.#clock.now()));
				}
				return;
			}
			const now = this.#clock.now();
			this.#projects.recordDeletionJobAttempt(job.projectId, "processing", now);
			const sessionIds = this.#projects.listDeletionSessionIds(
				job.projectId,
				this.#deletionBatchSize,
			);
			if (sessionIds.length === 0) {
				try {
					this.#projects.completeDeletion(job.projectId);
				} catch {
					this.#recordDeletionRetry(
						job.projectId,
						now,
						"PROJECT_DELETION_COMPLETION_FAILED",
						`Project deletion ${job.projectId} finalization failed; retry scheduled.`,
					);
					return;
				}
				continue;
			}
			const retired: string[] = [];
			try {
				for (const sessionId of sessionIds) {
					this.#runs.deleteSessionAndRetireRuns(sessionId);
					retired.push(sessionId);
				}
			} catch (error) {
				if (!(error instanceof SessionRetirementCapacityError)) {
					this.#recordDeletionRetry(
						job.projectId,
						now,
						"PROJECT_SESSION_RETIREMENT_FAILED",
						`Project deletion ${job.projectId} Session retirement failed; retry scheduled.`,
					);
					return;
				}
				this.#recordDeletionRetry(
					job.projectId,
					now,
					"SESSION_RETIREMENT_CAPACITY",
					`Project deletion ${job.projectId} is waiting for Session retirement capacity.`,
				);
				return;
			} finally {
				if (retired.length > 0) {
					this.#onSessionsRetired?.(retired);
				}
			}
		}
	}

	#ensureDeletionWorker(): void {
		void this.drainPendingDeletions().catch((error: unknown) => {
			const message = error instanceof Error ? error.message.slice(0, 256) : "Unknown failure.";
			this.#reportDiagnostic(`Project deletion worker failed: ${message}`);
		});
	}

	#recordDeletionRetry(
		projectId: string,
		now: number,
		errorCode: string,
		diagnostic: string,
	): void {
		this.#projects.recordDeletionJobAttempt(
			projectId,
			"blocked",
			now + this.#deletionRetryDelayMs,
			errorCode,
		);
		this.#reportDiagnostic(diagnostic);
		this.#scheduleDeletionRetry(this.#deletionRetryDelayMs);
	}

	#scheduleDeletionRetry(delayMs: number): void {
		if (this.#shuttingDown || this.#deletionTimer !== undefined) {
			return;
		}
		this.#deletionTimer = this.#deletionRetryScheduler.setTimeout(() => {
			this.#deletionTimer = undefined;
			this.#ensureDeletionWorker();
		}, delayMs);
	}

	#assertActive(project: Project): void {
		if (project.archivedAt !== undefined) {
			throw new ProjectArchivedError();
		}
	}

	#assertNoActiveRuns(projectId: string): void {
		if (this.#runs.hasNonTerminalForProject(projectId)) {
			throw new ProjectHasActiveRunsError();
		}
	}

	#serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#mutationTails.get(projectId) ?? Promise.resolve();
		const execution = previous.then(operation, operation);
		const tail = execution.then(
			() => undefined,
			() => undefined,
		);
		this.#mutationTails.set(projectId, tail);
		void tail.finally(() => {
			if (this.#mutationTails.get(projectId) === tail) {
				this.#mutationTails.delete(projectId);
			}
		});
		return execution;
	}

	#nowIso(): string {
		return new Date(this.#clock.now()).toISOString();
	}
}

function createProjectConfirmationToken(
	runtimeBoxId: string,
	inputPath: string,
	inspection: Extract<ValidateRuntimeBoxProjectPathOutput, { status: "available" }>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				runtimeBoxId,
				inputPath,
				inspection.confirmationToken,
				inspection.normalizedPath,
				inspection.displayName,
				inspection.gitRootPath ?? null,
				inspection.gitBranch ?? null,
				inspection.rootAgents,
			]),
		)
		.digest("hex");
}
