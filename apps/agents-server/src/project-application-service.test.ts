import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defaultLocalRuntimeBoxId } from "@moshu/contracts";
import {
	type ActionRepository,
	openAppDatabase,
	ProjectPathConflictError,
	type ProjectRepository,
	type RunJournalRepository,
	SessionRetirementCapacityError,
} from "@moshu/database";
import {
	ProjectApplicationService,
	ProjectArchivedError,
	ProjectDeletingError,
	ProjectHasActiveRunsError,
	ProjectHasUnacknowledgedActionsError,
	ProjectNameConfirmationMismatchError,
	type ProjectPathInspector,
	ProjectPathUnavailableError,
	ProjectPreviewStaleError,
	ProjectRelinkRuntimeMismatchError,
	ProjectRuntimeUnavailableError,
} from "./project-application-service";
import { RuntimeBoxUnavailableError } from "./runtime-box-registry";

const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

describe("Project application service", () => {
	test("previews and confirms creation by re-inspecting the path", async () => {
		const database = openAppDatabase(":memory:");
		let token = tokenA;
		let inspections = 0;
		const inspector: ProjectPathInspector = {
			async validateProjectPath() {
				inspections += 1;
				return availableInspection("/workspace/project", token);
			},
		};
		const service = createService(database, inspector);
		try {
			const preview = await service.previewPath({ path: "/workspace/project" });
			token = tokenB;
			await expect(
				service.create({
					path: "/workspace/project",
					confirmationToken: preview.preview.confirmationToken,
				}),
			).rejects.toBeInstanceOf(ProjectPreviewStaleError);
			expect(inspections).toBe(2);
			expect(database.projects.list().items).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("binds create and relink confirmations to the owning Runtime Box", async () => {
		const database = openAppDatabase(":memory:");
		const otherRuntimeBoxId = "remote-identical";
		database.runtimeBoxes.upsertRegistration({
			schemaVersion: 1,
			runtimeBoxId: otherRuntimeBoxId,
			kind: "remote",
			displayName: "Remote Identical",
			runtimeBoxVersion: "0.0.1",
			platform: "linux",
			arch: "x64",
			capabilities: [],
		});
		const inspectedRuntimeBoxes: string[] = [];
		const service = createService(database, {
			async validateProjectPath(runtimeBoxId, input) {
				inspectedRuntimeBoxes.push(runtimeBoxId);
				return availableInspection(input.path, tokenA);
			},
		});
		const sharedPath = "/workspace/shared";
		try {
			const localPreview = await service.previewPath({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				path: sharedPath,
			});
			const remotePreview = await service.previewPath({
				runtimeBoxId: otherRuntimeBoxId,
				path: sharedPath,
			});
			expect(remotePreview.preview.confirmationToken).not.toBe(
				localPreview.preview.confirmationToken,
			);

			await expect(
				service.create({
					runtimeBoxId: otherRuntimeBoxId,
					path: sharedPath,
					confirmationToken: localPreview.preview.confirmationToken,
				}),
			).rejects.toBeInstanceOf(ProjectPreviewStaleError);

			const project = database.projects.create({
				runtimeBoxId: otherRuntimeBoxId,
				name: "Remote Project",
				path: "/workspace/original",
			}).project;
			const relinkPreview = await service.previewRelink({
				projectId: project.id,
				path: sharedPath,
			});
			await expect(
				service.relink({
					projectId: project.id,
					path: sharedPath,
					expectedPathRevision: project.pathRevision,
					confirmationToken: localPreview.preview.confirmationToken,
				}),
			).rejects.toBeInstanceOf(ProjectPreviewStaleError);
			await expect(
				service.relink({
					projectId: project.id,
					path: sharedPath,
					expectedPathRevision: project.pathRevision,
					confirmationToken: relinkPreview.preview.confirmationToken,
				}),
			).resolves.toMatchObject({ project: { path: sharedPath, runtimeBoxId: otherRuntimeBoxId } });
			expect(inspectedRuntimeBoxes).toEqual([
				defaultLocalRuntimeBoxId,
				otherRuntimeBoxId,
				otherRuntimeBoxId,
				otherRuntimeBoxId,
				otherRuntimeBoxId,
				otherRuntimeBoxId,
			]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("creates a Project on the requesting client's selected Runtime Box", async () => {
		const database = openAppDatabase(":memory:");
		const clientRuntimeBoxId = "remote-client-selected";
		database.runtimeBoxes.upsertRegistration({
			schemaVersion: 1,
			runtimeBoxId: clientRuntimeBoxId,
			kind: "remote",
			displayName: "Remote Client Selected",
			runtimeBoxVersion: "0.0.1",
			platform: "linux",
			arch: "x64",
			capabilities: [],
		});
		const clientId = "moshu-desktop-client";
		database.runtimeBoxes.switchActiveForClient(clientId, {
			runtimeBoxId: clientRuntimeBoxId,
			expectedRevision: database.runtimeBoxes.getActiveForClient(clientId).revision,
		});
		const inspectedRuntimeBoxes: string[] = [];
		const service = createService(database, {
			async validateProjectPath(runtimeBoxId, input) {
				inspectedRuntimeBoxes.push(runtimeBoxId);
				return availableInspection(input.path, tokenA);
			},
		});
		try {
			const preview = await service.previewPath({ path: "/workspace/client-scoped" }, clientId);
			const created = await service.create(
				{
					path: "/workspace/client-scoped",
					confirmationToken: preview.preview.confirmationToken,
				},
				clientId,
			);
			expect(created.project.runtimeBoxId).toBe(clientRuntimeBoxId);
			expect(inspectedRuntimeBoxes).toEqual([clientRuntimeBoxId, clientRuntimeBoxId]);
			// The global default is untouched; only the client's preference drove placement.
			expect(database.runtimeBoxes.getActive().runtimeBoxId).toBe(defaultLocalRuntimeBoxId);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("marks canonical path changes unavailable without silently replacing the path", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = createService(database, {
			async validateProjectPath() {
				return availableInspection("/canonical/moved", tokenA);
			},
		});
		try {
			const checked = await service.checkPath({ projectId: project.id });
			expect(checked.project).toMatchObject({
				path: "/workspace/project",
				pathStatus: "unavailable",
				pathIssueCode: "canonical_path_changed",
			});
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("allows offline metadata mutations and reports archived path conflicts distinctly", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = createService(database, {
			async validateProjectPath() {
				throw new RuntimeBoxUnavailableError();
			},
		});
		try {
			await expect(
				service.updateName({ projectId: project.id, name: "Renamed" }),
			).resolves.toMatchObject({ project: { name: "Renamed" } });
			await service.setArchived({ projectId: project.id, archived: true });
			expect(() =>
				database.projects.create({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					name: "Duplicate",
					path: "/workspace/project",
				}),
			).toThrow(
				expect.objectContaining({
					constructor: ProjectPathConflictError,
					conflictingProjectArchived: true,
				}),
			);
			const restored = await service.setArchived({ projectId: project.id, archived: false });
			expect(restored.project.archivedAt).toBeUndefined();
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("rejects archive, relink, and delete while a Project has active Runs", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const runs = {
			hasNonTerminalForProject: () => true,
		} as unknown as RunJournalRepository;
		const service = createService(
			database,
			{
				async validateProjectPath() {
					return availableInspection("/workspace/new", tokenA);
				},
			},
			runs,
		);
		try {
			await expect(
				service.setArchived({ projectId: project.id, archived: true }),
			).rejects.toBeInstanceOf(ProjectHasActiveRunsError);
			await expect(
				service.relink({
					projectId: project.id,
					path: "/workspace/new",
					expectedPathRevision: 1,
					confirmationToken: tokenA,
				}),
			).rejects.toBeInstanceOf(ProjectHasActiveRunsError);
			await expect(
				service.requestDeletion({ projectId: project.id, expectedName: "Project" }),
			).rejects.toBeInstanceOf(ProjectHasActiveRunsError);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("relinks only on the owning Runtime Box and increments the path revision", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = createService(database, {
			async validateProjectPath() {
				return availableInspection("/workspace/relinked", tokenA);
			},
		});
		try {
			await expect(
				service.relink({
					projectId: project.id,
					path: "/workspace/relinked",
					runtimeBoxId: "another-runtime-box",
					expectedPathRevision: 1,
					confirmationToken: tokenA,
				}),
			).rejects.toBeInstanceOf(ProjectRelinkRuntimeMismatchError);
			const preview = await service.previewRelink({
				projectId: project.id,
				path: "/workspace/relinked",
			});
			const relinked = await service.relink({
				projectId: project.id,
				path: "/workspace/relinked",
				runtimeBoxId: defaultLocalRuntimeBoxId,
				expectedPathRevision: 1,
				confirmationToken: preview.preview.confirmationToken,
			});
			expect(relinked.project).toMatchObject({
				path: "/workspace/relinked",
				pathRevision: 2,
				pathStatus: "available",
			});
			await expect(
				service.relink({
					projectId: project.id,
					path: "/workspace/relinked",
					expectedPathRevision: 1,
					confirmationToken: preview.preview.confirmationToken,
				}),
			).rejects.toBeInstanceOf(ProjectPreviewStaleError);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("recovers a durable deletion job and retires Project Sessions in batches", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const sessions = Array.from(
			{ length: 3 },
			(_, index) =>
				database.sessions.create({ projectId: project.id, title: `Session ${index}` }).session,
		);
		database.projects.requestDeletion(project.id);
		const retiredBatches: string[][] = [];
		const service = createService(
			database,
			{
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
			database.runs,
			(ids) => retiredBatches.push([...ids]),
			2,
		);
		try {
			expect(() => database.projects.get({ projectId: project.id })).toThrow("not found");
			expect(
				database.sessions.list({ scope: { kind: "project", projectId: project.id } }).items,
			).toEqual([]);
			await service.drainPendingDeletions();
			expect(database.projects.listPendingDeletionJobs(10, true)).toEqual([]);
			expect(retiredBatches.map((batch) => batch.length)).toEqual([2, 1]);
			for (const session of sessions) {
				expect(database.runs.isSessionRetired(session.id)).toBe(true);
			}
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("returns a durable delete request before the retirement worker begins", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const session = database.sessions.create({
			projectId: project.id,
			title: "Session",
		}).session;
		const yieldGate = Promise.withResolvers<void>();
		const retired: string[] = [];
		const runs = {
			hasNonTerminalForProject: database.runs.hasNonTerminalForProject.bind(database.runs),
			deleteSessionAndRetireRuns(sessionId: string) {
				retired.push(sessionId);
				database.runs.deleteSessionAndRetireRuns(sessionId);
			},
		} as unknown as RunJournalRepository;
		const service = new ProjectApplicationService({
			projects: database.projects,
			runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
			deletionYield: () => yieldGate.promise,
		});
		try {
			await expect(
				service.requestDeletion({ projectId: project.id, expectedName: project.name }),
			).resolves.toMatchObject({ projectId: project.id });
			expect(database.projects.isDeleting(project.id)).toBe(true);
			expect(retired).toEqual([]);

			yieldGate.resolve();
			await service.drainPendingDeletions();
			expect(retired).toEqual([session.id]);
			expect(database.projects.isDeleting(project.id)).toBe(false);
		} finally {
			yieldGate.resolve();
			await service.shutdown();
			database.close();
		}
	});

	test("validates the expected Project name before starting deletion", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = createService(database, {
			async validateProjectPath() {
				return availableInspection(project.path, tokenA);
			},
		});

		try {
			await expect(
				service.requestDeletion({ projectId: project.id, expectedName: "Wrong" }),
			).rejects.toBeInstanceOf(ProjectNameConfirmationMismatchError);
			expect(database.projects.get({ projectId: project.id }).project.id).toBe(project.id);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("rejects deletion while Runtime Box Actions remain unacknowledged", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = new ProjectApplicationService({
			projects: database.projects,
			runs: database.runs,
			actions: {
				hasUnacknowledgedForProject: () => true,
			} as unknown as ActionRepository,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
		});
		try {
			await expect(
				service.requestDeletion({ projectId: project.id, expectedName: project.name }),
			).rejects.toBeInstanceOf(ProjectHasUnacknowledgedActionsError);
			expect(database.projects.isDeleting(project.id)).toBe(false);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps capacity-blocked deletion durable and retryable", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		database.sessions.create({ projectId: project.id, title: "Session" });
		database.projects.requestDeletion(project.id);
		const runs = {
			deleteSessionAndRetireRuns() {
				throw new SessionRetirementCapacityError("cleanup_outbox");
			},
		} as unknown as RunJournalRepository;
		const service = new ProjectApplicationService({
			projects: database.projects,
			runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
			deletionRetryDelayMs: 60_000,
		});
		try {
			await service.drainPendingDeletions();
			expect(database.projects.listPendingDeletionJobs(10, true)).toEqual([
				expect.objectContaining({
					projectId: project.id,
					state: "blocked",
					lastErrorCode: "SESSION_RETIREMENT_CAPACITY",
				}),
			]);
			expect(database.projects.isDeleting(project.id)).toBe(true);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("reschedules a deferred deletion job when the service restarts", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		database.sessions.create({ projectId: project.id, title: "Session" });
		database.projects.requestDeletion(project.id);
		database.projects.recordDeletionJobAttempt(
			project.id,
			"blocked",
			Date.now() + 10,
			"SESSION_RETIREMENT_CAPACITY",
		);
		const service = createService(database, {
			async validateProjectPath() {
				return availableInspection(project.path, tokenA);
			},
		});
		try {
			await service.drainPendingDeletions();
			for (
				let attempt = 0;
				attempt < 10 && database.projects.isDeleting(project.id);
				attempt += 1
			) {
				await Bun.sleep(10);
			}
			expect(database.projects.isDeleting(project.id)).toBe(false);
			expect(database.projects.listPendingDeletionJobs(10, true)).toEqual([]);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("retries an unexpected Session retirement failure without a restart", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const session = database.sessions.create({ projectId: project.id, title: "Session" }).session;
		database.projects.requestDeletion(project.id);
		const scheduler = new TestDeletionRetryScheduler();
		const diagnostics: string[] = [];
		let failuresRemaining = 1;
		const runs = {
			deleteSessionAndRetireRuns(sessionId: string) {
				if (failuresRemaining > 0) {
					failuresRemaining -= 1;
					throw new Error("recoverable retirement failure");
				}
				database.runs.deleteSessionAndRetireRuns(sessionId);
			},
		} as unknown as RunJournalRepository;
		const service = new ProjectApplicationService({
			projects: database.projects,
			runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
			deletionRetryDelayMs: 25,
			deletionRetryScheduler: scheduler,
			clock: scheduler,
			reportDiagnostic: (message) => diagnostics.push(message),
		});
		try {
			await service.drainPendingDeletions();
			expect(database.projects.listPendingDeletionJobs(10, true)).toEqual([
				expect.objectContaining({
					projectId: project.id,
					state: "blocked",
					lastErrorCode: "PROJECT_SESSION_RETIREMENT_FAILED",
				}),
			]);
			expect(database.runs.isSessionRetired(session.id)).toBe(false);
			expect(scheduler.delays).toEqual([25]);
			expect(diagnostics).toEqual([
				`Project deletion ${project.id} Session retirement failed; retry scheduled.`,
			]);

			scheduler.advanceBy(25);
			await service.drainPendingDeletions();
			expect(database.projects.isDeleting(project.id)).toBe(false);
			expect(database.runs.isSessionRetired(session.id)).toBe(true);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("retries final deletion failure without a restart", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		database.projects.requestDeletion(project.id);
		const scheduler = new TestDeletionRetryScheduler();
		const diagnostics: string[] = [];
		let failuresRemaining = 1;
		const projects = new Proxy(database.projects, {
			get(target, property, receiver) {
				if (property === "completeDeletion") {
					return (projectId: string) => {
						if (failuresRemaining > 0) {
							failuresRemaining -= 1;
							throw new Error("recoverable completion failure");
						}
						target.completeDeletion(projectId);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as ProjectRepository;
		const service = new ProjectApplicationService({
			projects,
			runs: database.runs,
			actions: database.actions,
			runtimeBoxes: database.runtimeBoxes,
			pathInspector: {
				async validateProjectPath() {
					return availableInspection(project.path, tokenA);
				},
			},
			deletionRetryDelayMs: 50,
			deletionRetryScheduler: scheduler,
			clock: scheduler,
			reportDiagnostic: (message) => diagnostics.push(message),
		});
		try {
			await service.drainPendingDeletions();
			expect(database.projects.listPendingDeletionJobs(10, true)).toEqual([
				expect.objectContaining({
					projectId: project.id,
					state: "blocked",
					lastErrorCode: "PROJECT_DELETION_COMPLETION_FAILED",
				}),
			]);
			expect(scheduler.delays).toEqual([50]);
			expect(diagnostics).toEqual([
				`Project deletion ${project.id} finalization failed; retry scheduled.`,
			]);

			scheduler.advanceBy(50);
			await service.drainPendingDeletions();
			expect(database.projects.isDeleting(project.id)).toBe(false);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("builds an immutable Project Run preflight snapshot and keeps AGENTS.md in memory", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const body = "ROOT-AGENTS-MUST-NOT-BE-PERSISTED";
		const service = createService(database, {
			async validateProjectPath() {
				return {
					...availableInspection(project.path, tokenA),
					gitRootPath: project.path,
					gitBranch: "main",
				};
			},
			async readProjectRootAgents(_runtimeBoxId, input, signal) {
				expect(input).toEqual({ projectPath: project.path });
				expect(signal).toBeDefined();
				return { status: "loaded", body };
			},
		});
		const controller = new AbortController();
		try {
			const preflight = await service.withRunPreflight(
				project.id,
				(result) => result,
				controller.signal,
			);
			expect(preflight).toMatchObject({
				projectName: "Project",
				rootAgentsBody: body,
				projectContext: {
					projectId: project.id,
					runtimeBoxId: defaultLocalRuntimeBoxId,
					projectPath: project.path,
					projectPathRevision: 1,
					gitRootPath: project.path,
					gitBranch: "main",
					rootAgentsHash: createHash("sha256").update(body).digest("hex"),
				},
			});
			expect(JSON.stringify(database.client.query("SELECT * FROM chat_runs").all())).not.toContain(
				body,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("keeps AGENTS.md warnings non-fatal and gates unavailable Project states", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		let pathState: "available" | "unavailable" | "offline" = "available";
		const service = createService(database, {
			async validateProjectPath() {
				if (pathState === "offline") throw new RuntimeBoxUnavailableError();
				if (pathState === "unavailable") {
					return { status: "unavailable", issueCode: "not_found" };
				}
				return availableInspection(project.path, tokenA);
			},
			async readProjectRootAgents() {
				return { status: "warning", issueCode: "invalid_utf8" };
			},
		});
		try {
			const warning = await service.withRunPreflight(project.id, (result) => result);
			expect(warning.rootAgentsWarning).toBe("invalid_utf8");
			expect(warning.projectContext.rootAgentsHash).toBeUndefined();
			pathState = "unavailable";
			await expect(service.withRunPreflight(project.id, (result) => result)).rejects.toBeInstanceOf(
				ProjectPathUnavailableError,
			);
			pathState = "offline";
			await expect(service.withRunPreflight(project.id, (result) => result)).rejects.toBeInstanceOf(
				ProjectRuntimeUnavailableError,
			);
			pathState = "available";
			await service.setArchived({ projectId: project.id, archived: true });
			await expect(service.withRunPreflight(project.id, (result) => result)).rejects.toBeInstanceOf(
				ProjectArchivedError,
			);
			await service.setArchived({ projectId: project.id, archived: false });
			database.projects.requestDeletion(project.id);
			await expect(service.withRunPreflight(project.id, (result) => result)).rejects.toBeInstanceOf(
				ProjectDeletingError,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});

	test("maps Runtime Box disconnects during root AGENTS.md loading to Project unavailability", async () => {
		const database = openAppDatabase(":memory:");
		const project = database.projects.create({
			runtimeBoxId: defaultLocalRuntimeBoxId,
			name: "Project",
			path: "/workspace/project",
		}).project;
		const service = createService(database, {
			async validateProjectPath() {
				return availableInspection(project.path, tokenA);
			},
			async readProjectRootAgents() {
				throw new RuntimeBoxUnavailableError("Runtime Box disconnected while loading AGENTS.md.");
			},
		});
		try {
			await expect(service.withRunPreflight(project.id, (result) => result)).rejects.toBeInstanceOf(
				ProjectRuntimeUnavailableError,
			);
		} finally {
			await service.shutdown();
			database.close();
		}
	});
});

class TestDeletionRetryScheduler {
	readonly delays: number[] = [];
	#now = 0;
	#nextId = 1;
	#timers = new Map<number, { dueAt: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.#nextId;
		this.#nextId += 1;
		this.delays.push(delayMs);
		this.#timers.set(id, { dueAt: this.#now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.#timers.delete(handle as number);
	}

	now(): number {
		return this.#now;
	}

	advanceBy(delayMs: number): void {
		this.#now += delayMs;
		for (const [id, timer] of [...this.#timers]) {
			if (timer.dueAt <= this.#now) {
				this.#timers.delete(id);
				timer.callback();
			}
		}
	}
}

function createService(
	database: ReturnType<typeof openAppDatabase>,
	inspector: ProjectPathInspector,
	runs: RunJournalRepository = database.runs,
	onSessionsRetired?: (ids: readonly string[]) => void,
	deletionBatchSize?: number,
): ProjectApplicationService {
	return new ProjectApplicationService({
		projects: database.projects,
		runs,
		actions: {
			hasUnacknowledgedForProject: () => false,
		} as unknown as ActionRepository,
		runtimeBoxes: database.runtimeBoxes,
		pathInspector: inspector,
		...(onSessionsRetired === undefined ? {} : { onSessionsRetired }),
		...(deletionBatchSize === undefined ? {} : { deletionBatchSize }),
	});
}

function availableInspection(path: string, confirmationToken: string) {
	return {
		status: "available" as const,
		normalizedPath: path,
		displayName: "project",
		rootAgents: { status: "missing" as const },
		confirmationToken,
	};
}
