import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type AppError,
	defaultLocalRuntimeBoxId,
	retiredSessionTombstoneTtlMs,
} from "@moshu/contracts";

import {
	applyAppMigrations,
	chatRunsTable,
	coordinatedDatabaseResetReason,
	createUuidV7,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
	maxAgentSessionCleanupJobs,
	maxRetiredSessionTombstones,
	maxSessionCreateIdempotencyRecords,
	openAppDatabase,
	prepareCoordinatedDatabaseReset,
	SqliteRunJournalRepository,
} from "../src";

function withTempDatabase(run: (databasePath: string) => void): void {
	const directoryPath = mkdtempSync(join(tmpdir(), "moshu-app-db-"));
	const databasePath = join(directoryPath, "app.db");
	try {
		run(databasePath);
	} finally {
		rmSync(directoryPath, { force: true, recursive: true });
	}
}

function makeProviderInput(secret = "sk-test-secret") {
	void secret;
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		thinkingLevel: "medium" as const,
	};
}

function makeProviderState() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		source: "custom" as const,
		api: "openai-responses",
		model: "gpt-5.4",
		status: "ready" as const,
	};
}

function makeSessionCreateRequest(createKey = crypto.randomUUID(), title = "New chat") {
	return {
		schemaVersion: 1 as const,
		createKey,
		title,
		defaultMode: "ask" as const,
	};
}

function makeClientOrigin(instanceId = "desktop-instance-1") {
	return {
		role: "client" as const,
		peerId: "moshu-desktop-client",
		instanceId,
		generation: 1,
	};
}

function makeAppError(code: string): AppError {
	return {
		code,
		category: "provider",
		messageKey: `errors.${code.toLowerCase()}`,
		retryable: false,
		safeMessage: `${code} happened.`,
	};
}

function createRun(database: ReturnType<typeof openAppDatabase>, sessionId: string) {
	return database.runs.create({
		clientRequestId: crypto.randomUUID(),
		sessionId,
		mode: "ask",
		provider: makeProviderInput(),
		userMessageId: createUuidV7(),
		userContent: "Test prompt",
		assistantMessageId: createUuidV7(),
	});
}

function getAssistantMessageId(run: ReturnType<typeof createRun>["run"]): string {
	if (run.assistantMessageId === undefined) {
		throw new Error("Expected the run journal to assign an assistant message ID.");
	}
	return run.assistantMessageId;
}

describe("application database", () => {
	test("persists active Runtime Box selection and binds Sessions and Runs to their Box", () => {
		const database = openAppDatabase(":memory:");
		try {
			const initial = database.runtimeBoxes.getActive();
			expect(initial).toEqual({ runtimeBoxId: defaultLocalRuntimeBoxId, revision: 1 });
			const localSession = database.sessions.create({ title: "Local" }).session;
			expect(localSession.runtimeBoxId).toBe(defaultLocalRuntimeBoxId);

			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: "remote-linux",
				kind: "remote",
				displayName: "Remote Linux",
				runtimeBoxVersion: "0.0.1",
				platform: "linux",
				arch: "x64",
				capabilities: ["tool.read"],
			});
			const switched = database.runtimeBoxes.switchActive({
				runtimeBoxId: "remote-linux",
				expectedRevision: initial.revision,
			});
			expect(switched).toEqual({ runtimeBoxId: "remote-linux", revision: 2 });
			expect(() =>
				database.runtimeBoxes.switchActive({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					expectedRevision: 1,
				}),
			).toThrow("revision conflict");

			const remoteSession = database.sessions.create({ title: "Remote" }).session;
			expect(remoteSession.runtimeBoxId).toBe("remote-linux");
			expect(database.sessions.list().items.map((session) => session.id)).toEqual([
				remoteSession.id,
			]);
			expect(
				database.sessions
					.list({ runtimeBoxId: defaultLocalRuntimeBoxId })
					.items.map((session) => session.id),
			).toEqual([localSession.id]);

			expect(createRun(database, localSession.id).run.runtimeBoxId).toBe(defaultLocalRuntimeBoxId);
			expect(createRun(database, remoteSession.id).run.runtimeBoxId).toBe("remote-linux");
		} finally {
			database.close();
		}
	});

	test("persists Runtime Box generation high-water marks", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: "remote-generation-box",
				kind: "remote",
				displayName: "Remote Generation Box",
				runtimeBoxVersion: "0.0.1",
				platform: "linux",
				arch: "x64",
				capabilities: [],
			});

			expect(
				database.runtimeBoxes.acceptGeneration("remote-generation-box", "local-instance-2", 2),
			).toEqual({ accepted: true });
			expect(
				database.runtimeBoxes.acceptGeneration("remote-generation-box", "local-instance-1", 1),
			).toEqual({
				accepted: false,
				code: "STALE_GENERATION",
				currentGeneration: 2,
			});
			database.close();

			const reopened = openAppDatabase(databasePath);
			try {
				expect(
					reopened.runtimeBoxes.acceptGeneration(
						"remote-generation-box",
						"different-instance-2",
						2,
					),
				).toEqual({
					accepted: false,
					code: "GENERATION_CONFLICT",
					currentGeneration: 2,
				});
				expect(
					reopened.runtimeBoxes.acceptGeneration("remote-generation-box", "local-instance-3", 3),
				).toEqual({ accepted: true });
			} finally {
				reopened.close();
			}
		});
	});

	test("persists authenticated upgrade state and clears it on compatible registration", () => {
		withTempDatabase((databasePath) => {
			const descriptor = {
				schemaVersion: 1 as const,
				runtimeBoxId: "remote-upgrade-box",
				kind: "remote" as const,
				displayName: "Remote Upgrade Box",
				runtimeBoxVersion: "0.0.1",
				platform: "linux" as const,
				arch: "x64",
				capabilities: [],
			};
			const database = openAppDatabase(databasePath);
			database.runtimeBoxes.upsertRegistration(descriptor);
			expect(
				database.runtimeBoxes.markUpgradeRequired(descriptor.runtimeBoxId, "old-instance", 2, 2),
			).toEqual({ accepted: true });
			expect(
				database.runtimeBoxes.markUpgradeRequired(descriptor.runtimeBoxId, "stale-instance", 1, 3),
			).toMatchObject({ accepted: false, code: "STALE_GENERATION" });
			database.close();

			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.runtimeBoxes.listCompatibility()).toEqual([
					{
						runtimeBoxId: descriptor.runtimeBoxId,
						state: "upgrade_required",
						generation: 2,
						protocolVersion: 2,
					},
				]);
				reopened.runtimeBoxes.upsertRegistration({
					...descriptor,
					runtimeBoxVersion: "2.0.0",
				});
				expect(reopened.runtimeBoxes.listCompatibility()).toEqual([]);
			} finally {
				reopened.close();
			}
		});
	});

	test("stores only redacted inventory projections and stable Runtime Profile refs", () => {
		const database = openAppDatabase(":memory:");
		try {
			const runtimeBoxId = defaultLocalRuntimeBoxId;
			const epoch = crypto.randomUUID();
			const version = crypto.randomUUID();
			const contentHash = "a".repeat(64);
			database.runtimeBoxInventory.replaceSnapshot({
				runtimeBoxId,
				runtimeBoxGeneration: 3,
				inventoryEpoch: epoch,
				inventoryRevision: 1,
				generatedAt: new Date().toISOString(),
				capabilities: ["inventory.v1"],
				resources: [
					{
						resourceKind: "skill",
						stableResourceId: "release-helper",
						version,
						contentHash,
						health: "ready",
					},
				],
			});
			expect(database.runtimeBoxInventory.list(runtimeBoxId)).toEqual({
				runtimeBoxId,
				inventoryEpoch: epoch,
				inventoryRevision: 1,
				stale: false,
				resources: [
					{
						resourceKind: "skill",
						stableResourceId: "release-helper",
						version,
						contentHash,
						health: "ready",
					},
				],
			});
			const initialProfile = database.runtimeProfiles.getOrCreate("moshu.default", runtimeBoxId);
			const ref = {
				runtimeBoxId,
				resourceKind: "skill" as const,
				stableResourceId: "release-helper",
				version,
				contentHash,
			};
			const updatedProfile = database.runtimeProfiles.update({
				agentId: "moshu.default",
				runtimeBoxId,
				expectedRevision: initialProfile.revision,
				resources: [ref],
			});
			expect(updatedProfile.resources).toEqual([ref]);
			expect(() =>
				database.runtimeProfiles.update({
					agentId: "moshu.default",
					runtimeBoxId,
					expectedRevision: initialProfile.revision,
					resources: [],
				}),
			).toThrow("revision conflict");

			database.runtimeBoxInventory.markStale(runtimeBoxId);
			expect(database.runtimeBoxInventory.list(runtimeBoxId)).toMatchObject({
				stale: true,
				resources: [{ stableResourceId: "release-helper" }],
			});
			database.runtimeBoxInventory.applyChanges({
				runtimeBoxId,
				inventoryEpoch: epoch,
				fromRevisionExclusive: 1,
				throughRevision: 2,
				changes: [
					{
						revision: 2,
						category: "skill",
						operation: "delete",
						stableResourceId: "release-helper",
						tombstone: {
							resourceKind: "skill",
							stableResourceId: "release-helper",
							deletedVersion: version,
						},
					},
				],
			});
			expect(database.runtimeBoxInventory.list(runtimeBoxId)).toMatchObject({
				inventoryRevision: 2,
				stale: false,
				resources: [],
			});
		} finally {
			database.close();
		}
	});

	test("lists active device keys independently of Runtime Box connectivity", () => {
		const database = openAppDatabase(":memory:");
		try {
			const pairingId = crypto.randomUUID();
			database.runtimeBoxPairings.create({
				id: pairingId,
				codeHash: "pairing-code-hash",
				expiresAtMs: Date.now() + 60_000,
			});
			database.runtimeBoxPairings.claim({
				codeHash: "pairing-code-hash",
				claimTokenHash: "claim-token-hash",
				deviceKeyId: "offline-device-key",
				publicKey: "public-key",
				publicKeyFingerprint: "fingerprint-123456",
				displayName: "Offline Remote Box",
				platform: "linux",
				arch: "x64",
			});
			const runtimeBox = database.runtimeBoxPairings.approve(pairingId, "fingerprint-123456");
			expect(
				database.runtimeBoxPairings
					.listActiveDeviceKeys(runtimeBox.runtimeBoxId)
					.map((key) => key.keyId),
			).toEqual(["offline-device-key"]);
			database.runtimeBoxPairings.revokeDeviceKey(runtimeBox.runtimeBoxId, "offline-device-key");
			expect(database.runtimeBoxPairings.listActiveDeviceKeys(runtimeBox.runtimeBoxId)).toEqual([]);
		} finally {
			database.close();
		}
	});

	test("persists Projects per Runtime Box and enforces normalized path uniqueness", () => {
		const database = openAppDatabase(":memory:");
		try {
			const local = database.projects.create({
				runtimeBoxId: defaultLocalRuntimeBoxId,
				name: "Local project",
				path: "/workspace/local",
				gitRootPath: "/workspace/local",
				gitBranch: "main",
			}).project;
			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: "remote-project-box",
				kind: "remote",
				displayName: "Remote Project Box",
				runtimeBoxVersion: "0.0.1",
				platform: "linux",
				arch: "x64",
				capabilities: ["projects.validate-path"],
			});

			const active = database.runtimeBoxes.getActive();
			database.runtimeBoxes.switchActive({
				runtimeBoxId: "remote-project-box",
				expectedRevision: active.revision,
			});
			const remote = database.projects.create({
				runtimeBoxId: "remote-project-box",
				name: "Remote project",
				path: "/srv/project",
			}).project;
			expect(database.projects.list().items.map((project) => project.id)).toEqual([remote.id]);
			expect(
				database.projects
					.list({ runtimeBoxId: defaultLocalRuntimeBoxId })
					.items.map((project) => project.id),
			).toEqual([local.id]);
			expect(() =>
				database.projects.create({
					runtimeBoxId: "remote-project-box",
					name: "Duplicate",
					path: "/srv/project",
				}),
			).toThrow("already registered");
			expect(database.projects.update({ projectId: remote.id, name: "Renamed" }).project.name).toBe(
				"Renamed",
			);
			expect(
				database.projects.setArchived({ projectId: remote.id, archived: true }).project.archivedAt,
			).toBeDefined();
			expect(database.projects.list().items).toEqual([]);
			expect(database.projects.list({ archived: true }).items).toHaveLength(1);
			expect(database.projects.delete({ projectId: remote.id })).toEqual({
				deletedProjectId: remote.id,
			});
			expect(() => database.projects.get({ projectId: remote.id })).toThrow("not found");
		} finally {
			database.close();
		}
	});

	test("consumes execution grants once and reconciles durable Action evidence", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Action Session" }).session;
			const run = createRun(database, session.id).run;
			const actionId = crypto.randomUUID();
			const grantId = crypto.randomUUID();
			const invocationId = crypto.randomUUID();
			const digest = "a".repeat(64);
			const tokenHash = "b".repeat(64);
			database.actions.createGrant({
				actionId,
				grantId,
				grantTokenHash: tokenHash,
				invocationId,
				runtimeBoxId: defaultLocalRuntimeBoxId,
				runId: run.id,
				toolCallId: "tool-call",
				tool: "read",
				parameterDigest: digest,
				riskClass: "low",
				sideEffectClass: "none",
				idempotencyClass: "read",
				policyRule: "builtin-read-only",
				originInstanceId: "agents-instance",
				originGeneration: 2,
				targetInstanceId: "runtime-instance",
				targetGeneration: 3,
				executionScope: "request-cwd",
				expiresAtMs: Date.now() + 60_000,
			});
			database.actions.consumeGrant(actionId, grantId, tokenHash);
			expect(() => database.actions.consumeGrant(actionId, grantId, tokenHash)).toThrow(
				"already used",
			);
			const result = {
				schemaVersion: 1 as const,
				invocationId,
				tool: "read" as const,
				content: [{ type: "text" as const, text: "contents" }],
			};
			const evidence = {
				invocationId,
				actionId,
				grantId,
				parameterDigest: digest,
				originInstanceId: "agents-instance",
				originGeneration: 2,
				targetRuntimeBoxId: defaultLocalRuntimeBoxId,
				targetInstanceId: "runtime-instance",
				targetGeneration: 3,
				state: "succeeded" as const,
				result,
				completedAt: new Date().toISOString(),
			};
			database.actions.complete(defaultLocalRuntimeBoxId, evidence);
			database.actions.complete(defaultLocalRuntimeBoxId, evidence);
			expect(database.actions.hasUnacknowledgedForSession(session.id)).toBe(true);
			database.actions.markServerAcked([invocationId]);
			expect(database.actions.hasUnacknowledgedForSession(session.id)).toBe(true);
			database.actions.markReceiptConfirmed(defaultLocalRuntimeBoxId, [invocationId]);
			expect(database.actions.hasUnacknowledgedForSession(session.id)).toBe(false);
			expect(database.actions.get(invocationId)).toMatchObject({
				actionId,
				grantId,
				state: "succeeded",
				result,
				grantConsumedAtMs: expect.any(Number),
				serverAckedAtMs: expect.any(Number),
				boxReceiptConfirmedAtMs: expect.any(Number),
			});
			expect(() =>
				database.actions.complete(defaultLocalRuntimeBoxId, {
					...evidence,
					state: "failed",
					result: undefined,
					safeError: "conflict",
				}),
			).toThrow("conflicts");
			expect(() =>
				database.actions.complete(defaultLocalRuntimeBoxId, {
					...evidence,
					result: { ...result, invocationId: crypto.randomUUID() },
				}),
			).toThrow("did not match");
		} finally {
			database.close();
		}
	});

	test("recovers undispatched and ambiguous Actions on Agent Server startup", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Recovery" }).session;
			const run = createRun(database, session.id).run;
			const createAction = (consumed: boolean) => {
				const actionId = crypto.randomUUID();
				const grantId = crypto.randomUUID();
				const invocationId = crypto.randomUUID();
				const tokenHash = Buffer.alloc(32, consumed ? 1 : 2).toString("hex");
				database.actions.createGrant({
					actionId,
					grantId,
					grantTokenHash: tokenHash,
					invocationId,
					runtimeBoxId: defaultLocalRuntimeBoxId,
					runId: run.id,
					toolCallId: crypto.randomUUID(),
					tool: "bash",
					parameterDigest: "c".repeat(64),
					riskClass: "high",
					sideEffectClass: "local",
					idempotencyClass: "non_idempotent",
					policyRule: "test",
					originInstanceId: "agents",
					originGeneration: 1,
					targetInstanceId: "runtime",
					targetGeneration: 1,
					executionScope: "request-cwd",
					expiresAtMs: Date.now() + 60_000,
				});
				if (consumed) {
					database.actions.consumeGrant(actionId, grantId, tokenHash);
				}
				return invocationId;
			};
			const undispatched = createAction(false);
			const ambiguous = createAction(true);
			expect(database.actions.recoverOnStartup()).toEqual({
				cancelled: 1,
				outcomeUnknown: 1,
			});
			expect(database.actions.get(undispatched).state).toBe("cancelled");
			expect(database.actions.get(ambiguous).state).toBe("outcome_unknown");
		} finally {
			database.close();
		}
	});

	test("does not overwrite the last registered Local Runtime Box descriptor on reopen", () => {
		withTempDatabase((databasePath) => {
			const platform = process.platform;
			if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
				throw new Error(`Unsupported test platform: ${platform}`);
			}
			const database = openAppDatabase(databasePath);
			database.runtimeBoxes.upsertRegistration({
				schemaVersion: 1,
				runtimeBoxId: defaultLocalRuntimeBoxId,
				kind: "local",
				displayName: "My Local Box",
				runtimeBoxVersion: "1.2.3",
				platform,
				arch: process.arch,
				capabilities: ["tool.read"],
			});
			database.close();

			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.runtimeBoxes.get(defaultLocalRuntimeBoxId)).toMatchObject({
					displayName: "My Local Box",
					runtimeBoxVersion: "1.2.3",
					capabilities: ["tool.read"],
				});
			} finally {
				reopened.close();
			}
		});
	});

	test("applies the current schema without a duplicate message table", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const tableNames = database.client
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%' ORDER BY name",
					)
					.all()
					.map((row) => row.name);
				expect(tableNames).toEqual([
					"chat_run_events",
					"chat_runs",
					"chat_session_create_requests",
					"chat_sessions",
				]);
				expect(getDatabaseUserVersion(database.client)).toBe(currentAppDatabaseVersion);
				applyAppMigrations(database.client);
				expect(getDatabaseUserVersion(database.client)).toBe(currentAppDatabaseVersion);
			} finally {
				database.close();
			}
		});
	});

	test("resets an obsolete product database and its SQLite sidecars", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec("CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			writeFileSync(`${databasePath}-wal`, "");
			writeFileSync(`${databasePath}-shm`, "");

			const result = prepareCoordinatedDatabaseReset({ productDatabase: databasePath });
			expect(result).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expect(existsSync(databasePath)).toBe(false);
			expect(existsSync(`${databasePath}-wal`)).toBe(false);
			expect(existsSync(`${databasePath}-shm`)).toBe(false);

			const reopened = openAppDatabase(databasePath);
			try {
				expect(getDatabaseUserVersion(reopened.client)).toBe(currentAppDatabaseVersion);
			} finally {
				reopened.close();
			}
		});
	});

	test("does not reset a current product database", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			database.sessions.create({ title: "keep me" });
			database.close();

			expect(prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toEqual({
				reset: false,
			});
			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.sessions.list().items).toHaveLength(1);
			} finally {
				reopened.close();
			}
		});
	});

	test("accepts an absent product database and rejects symbolic database paths", () => {
		withTempDatabase((databasePath) => {
			expect(prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toEqual({
				reset: false,
			});
			const targetPath = `${databasePath}.target`;
			writeFileSync(targetPath, "target");
			symlinkSync(targetPath, databasePath);
			expect(() => prepareCoordinatedDatabaseReset({ productDatabase: databasePath })).toThrow(
				"regular file",
			);
			expect(readFileSync(targetPath, "utf8")).toBe("target");
		});
	});

	test("enables SQLite safety settings and run foreign keys", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				expect(
					database.client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
						?.foreign_keys,
				).toBe(1);
				expect(
					database.client.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout,
				).toBe(5000);
				expect(
					database.client.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
						?.journal_mode,
				).toBe("wal");
				expect(() =>
					database.orm
						.insert(chatRunsTable)
						.values({
							id: createUuidV7(),
							runtimeBoxId: defaultLocalRuntimeBoxId,
							clientRequestId: crypto.randomUUID(),
							sessionId: createUuidV7(),
							mode: "ask",
							status: "queued",
							providerJson: JSON.stringify(makeProviderState()),
							userMessageId: createUuidV7(),
							userContent: "Foreign key prompt",
							assistantMessageId: createUuidV7(),
							assistantContent: null,
							lastErrorJson: null,
							createdAtMs: Date.now(),
							updatedAtMs: Date.now(),
							completedAtMs: null,
						})
						.run(),
				).toThrow();
			} finally {
				database.close();
			}
		});
	});

	test("manages searchable and archivable session metadata", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const first = database.sessions.create({ title: "Alpha notes" }).session;
				const second = database.sessions.create({ title: "Beta notes" }).session;
				expect(first.defaultMode).toBe("agent");
				expect(
					database.sessions.update({ sessionId: first.id, title: "Alpha architecture" }).session
						.title,
				).toBe("Alpha architecture");
				expect(database.sessions.list({ query: "alpha" }).items.map((item) => item.id)).toEqual([
					first.id,
				]);
				expect(database.sessions.list({ query: "%" }).items).toEqual([]);
				expect(
					database.sessions.setArchived({ sessionId: first.id, archived: true }).session.archivedAt,
				).toBeDefined();
				expect(database.sessions.list().items.map((item) => item.id)).toEqual([second.id]);
				expect(database.sessions.list({ archived: true }).items[0]?.id).toBe(first.id);
				database.sessions.delete({ sessionId: second.id });
				expect(() => database.sessions.get({ sessionId: second.id })).toThrow();
			} finally {
				database.close();
			}
		});
	});

	test("durably returns one Session for the same client and create key across restart", () => {
		withTempDatabase((databasePath) => {
			const request = makeSessionCreateRequest();
			const origin = makeClientOrigin();
			const firstDatabase = openAppDatabase(databasePath);
			const first = firstDatabase.sessions.createIdempotently({ request, origin });
			const concurrentRetry = firstDatabase.sessions.createIdempotently({ request, origin });
			expect(concurrentRetry).toEqual(first);
			expect(firstDatabase.sessions.list().items).toHaveLength(1);
			firstDatabase.close();

			const restartedDatabase = openAppDatabase(databasePath);
			try {
				expect(restartedDatabase.sessions.createIdempotently({ request, origin })).toEqual(first);
				expect(restartedDatabase.sessions.list().items).toHaveLength(1);
			} finally {
				restartedDatabase.close();
			}
		});
	});

	test("rejects create-key origin and parameter conflicts", () => {
		const database = openAppDatabase(":memory:");
		try {
			const request = makeSessionCreateRequest();
			database.sessions.createIdempotently({ request, origin: makeClientOrigin() });

			expect(() =>
				database.sessions.createIdempotently({
					request,
					origin: makeClientOrigin("other-desktop-instance"),
				}),
			).toThrow("different origin or parameters");
			expect(() =>
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(request.createKey, "Different title"),
					origin: makeClientOrigin(),
				}),
			).toThrow("different origin or parameters");
			expect(database.sessions.list().items).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	test("bounds durable create-key capacity and frees it when its Session is deleted", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO chat_sessions (
						id, runtime_box_id, pi_session_id, title, default_mode, created_at_ms, updated_at_ms,
						last_message_at_ms, archived_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						$runtimeBoxId,
						printf('00000000-0000-7000-8000-%012x', value),
						'capacity fixture',
						'ask',
						value,
						value,
						NULL,
						NULL
					FROM fixture`,
				)
				.run({
					count: maxSessionCreateIdempotencyRecords,
					runtimeBoxId: defaultLocalRuntimeBoxId,
				});
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO chat_session_create_requests (
						create_key, runtime_box_id, origin_role, origin_peer_id, origin_instance_id,
						origin_generation, title, default_mode, session_id, created_at_ms
					)
					SELECT
						printf('capacity-key-%d', value),
						$runtimeBoxId,
						'client',
						'capacity-client',
						'capacity-instance',
						1,
						'capacity fixture',
						'ask',
						printf('00000000-0000-7000-8000-%012x', value),
						value
					FROM fixture`,
				)
				.run({
					count: maxSessionCreateIdempotencyRecords,
					runtimeBoxId: defaultLocalRuntimeBoxId,
				});

			expect(() =>
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(),
					origin: makeClientOrigin(),
				}),
			).toThrow("capacity is full");

			database.sessions.delete({
				sessionId: "00000000-0000-7000-8000-000000000001",
			});
			expect(
				database.sessions.createIdempotently({
					request: makeSessionCreateRequest(),
					origin: makeClientOrigin(),
				}).session.id,
			).toBeDefined();
		} finally {
			database.close();
		}
	});

	test("journals run status and UI delivery events without message rows", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Run journal" }).session;
				const created = createRun(database, session.id);
				const assistantMessageId = getAssistantMessageId(created.run);
				const running = database.runs.updateStatus({ runId: created.run.id, status: "running" });
				const started = database.runs
					.listEvents({ runId: created.run.id })
					.find((event) => event.type === "message.started");
				const delta = database.runs.appendEvent({
					runId: created.run.id,
					type: "message.delta",
					source: { kind: "assistant" },
					payload: { messageId: assistantMessageId, delta: "Hello" },
				});
				const completed = database.runs.commitTerminal({
					runId: created.run.id,
					message: {
						messageId: assistantMessageId,
						status: "complete",
						content: "Hello",
					},
				});

				const events = database.runs.listEvents({ runId: created.run.id });
				expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
				expect(events.map((event) => event.type)).toEqual([
					"run.status",
					"message.started",
					"run.status",
					"message.delta",
					"message.completed",
					"run.status",
				]);
				expect(running.run.status).toBe("running");
				expect(started?.seq).toBe(2);
				expect(delta.seq).toBe(4);
				expect(completed.run.status).toBe("completed");
				expect(database.runs.listBySession(session.id)).toHaveLength(1);
				expect(database.runs.cancel({ runId: created.run.id }).run.status).toBe("completed");
				const pageItem = database.runs.listPageBySession({
					sessionId: session.id,
					limit: 1,
				}).items[0];
				expect(pageItem?.events).toEqual([]);
				expect(pageItem?.assistantContent).toBe("Hello");
				expect(pageItem?.lastEventSeq).toBe(6);
			} finally {
				database.close();
			}
		});
	});

	test("pages run journals with a stable cursor and no duplicate event queries", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Cursor history" }).session;
				for (let index = 0; index < 5; index += 1) {
					database.runs.create({
						clientRequestId: crypto.randomUUID(),
						sessionId: session.id,
						mode: "ask",
						provider: makeProviderInput(),
						userMessageId: createUuidV7(),
						userContent: `prompt-${index}`,
						assistantMessageId: createUuidV7(),
					});
				}
				const ids: string[] = [];
				const prompts: string[] = [];
				let after:
					| {
							createdAtMs: number;
							id: string;
					  }
					| undefined;
				do {
					const page = database.runs.listPageBySession({
						sessionId: session.id,
						...(after === undefined ? {} : { after }),
						limit: 2,
					});
					ids.push(...page.items.map((item) => item.run.id));
					prompts.push(...page.items.map((item) => item.userContent));
					expect(page.items.every((item) => item.events.length === 2)).toBe(true);
					after = page.nextCursor;
				} while (after !== undefined);

				expect(new Set(ids).size).toBe(5);
				expect(ids).toEqual(
					database.runs
						.listBySession(session.id)
						.reverse()
						.map((run) => run.id),
				);
				expect(prompts).toEqual(["prompt-0", "prompt-1", "prompt-2", "prompt-3", "prompt-4"]);
				const plan = database.client
					.query<{ detail: string }, [string, number, string]>(
						`EXPLAIN QUERY PLAN
						 SELECT id
						 FROM chat_runs
						 WHERE session_id = ?
						   AND (created_at_ms, id) > (?, ?)
						 ORDER BY created_at_ms, id
						 LIMIT 2`,
					)
					.all(session.id, 0, "00000000-0000-7000-8000-000000000000")
					.map((row) => row.detail)
					.join("\n");
				expect(plan).toContain("chat_runs_session_cursor_idx");
				expect(plan).toContain("(created_at_ms,id)>(?,?)");
			} finally {
				database.close();
			}
		});
	});

	test("pages a 100k-row event fixture with an indexed bounded query and forward progress", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Large event journal" }).session;
				const created = createRun(database, session.id);
				const assistantMessageId = getAssistantMessageId(created.run);
				database.runs.updateStatus({ runId: created.run.id, status: "running" });
				const eventCount = 100_000;
				const firstSeq = 4;
				const lastSeq = firstSeq + eventCount - 1;
				database.client
					.query(
						`WITH RECURSIVE fixture(seq) AS (
							SELECT $firstSeq
							UNION ALL
							SELECT seq + 1 FROM fixture WHERE seq < $lastSeq
						)
						INSERT INTO chat_run_events (
							id, run_id, session_id, seq, type, source_kind, source_id, visibility,
							payload_json, created_at_ms
						)
						SELECT
							printf('00000000-0000-7000-8000-%012x', seq),
							$runId,
							$sessionId,
							seq,
							'message.delta',
							'assistant',
							NULL,
							'user',
							$payloadJson,
							$createdAtMs
						FROM fixture`,
					)
					.run({
						firstSeq,
						lastSeq,
						runId: created.run.id,
						sessionId: session.id,
						payloadJson: JSON.stringify({ messageId: assistantMessageId, delta: "x" }),
						createdAtMs: Date.now(),
					});

				const firstPage = database.runs.listEventPage({
					runId: created.run.id,
					afterSeq: 3,
					limit: 6,
				});
				expect(firstPage.events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8, 9]);
				expect(firstPage.hasMore).toBe(true);

				let afterSeq = 3;
				let materialized = 0;
				const startedAt = performance.now();
				while (true) {
					const page = database.runs.listEventPage({
						runId: created.run.id,
						afterSeq,
						limit: 997,
					});
					expect(page.events.length).toBeLessThanOrEqual(997);
					expect(page.events[0]?.seq).toBe(afterSeq + 1);
					materialized += page.events.length;
					const nextSeq = page.events.at(-1)?.seq;
					expect(nextSeq).toBeGreaterThan(afterSeq);
					afterSeq = nextSeq ?? afterSeq;
					if (!page.hasMore) {
						break;
					}
				}
				expect(materialized).toBe(eventCount);
				expect(afterSeq).toBe(lastSeq);
				expect(performance.now() - startedAt).toBeLessThan(10_000);

				const plan = database.client
					.query<{ detail: string }, [string, number]>(
						`EXPLAIN QUERY PLAN
						 SELECT *
						 FROM chat_run_events
						 WHERE run_id = ? AND seq > ?
						 ORDER BY seq
						 LIMIT 7`,
					)
					.all(created.run.id, 3)
					.map((row) => row.detail)
					.join("\n");
				expect(plan).toContain("chat_run_events_run_seq");
				expect(plan).toContain("(run_id=? AND seq>?)");
			} finally {
				database.close();
			}
		});
	});

	test("persists failures and cancellation as run journal state", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Terminal runs" }).session;
				const failed = createRun(database, session.id);
				const failedAssistantMessageId = getAssistantMessageId(failed.run);
				database.runs.updateStatus({ runId: failed.run.id, status: "running" });
				const failure = database.runs.fail({
					runId: failed.run.id,
					error: makeAppError("PROVIDER_DOWN"),
					messageEvent: {
						messageId: failedAssistantMessageId,
						content: "Partial",
					},
				});
				expect(failure.run.status).toBe("failed");
				expect(failure.events.map((event) => event.type)).toEqual([
					"message.completed",
					"run.error",
					"run.status",
				]);
				const failedPageItem = database.runs
					.listPageBySession({ sessionId: session.id, limit: 1 })
					.items.find((item) => item.run.id === failed.run.id);
				expect(failedPageItem?.assistantContent).toBe("Partial");
				expect(failedPageItem?.events).toEqual([]);

				const cancelled = createRun(database, session.id);
				database.runs.updateStatus({ runId: cancelled.run.id, status: "running" });
				expect(database.runs.cancel({ runId: cancelled.run.id }).run.status).toBe("cancelling");
				expect(
					database.runs.commitTerminal({
						runId: cancelled.run.id,
						message: {
							messageId: getAssistantMessageId(cancelled.run),
							status: "cancelled",
							content: "",
						},
					}).run.status,
				).toBe("cancelled");
			} finally {
				database.close();
			}
		});
	});

	test("atomically aligns and idempotently commits every terminal message status", () => {
		withTempDatabase((databasePath) => {
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Terminal commit recovery" }).session;
				for (const scenario of [
					{ messageStatus: "complete" as const, runStatus: "completed" as const },
					{ messageStatus: "cancelled" as const, runStatus: "cancelled" as const },
					{ messageStatus: "failed" as const, runStatus: "failed" as const },
				]) {
					const created = createRun(database, session.id);
					const messageId = getAssistantMessageId(created.run);
					database.runs.updateStatus({ runId: created.run.id, status: "running" });
					const error =
						scenario.messageStatus === "failed" ? makeAppError("CRASH_WINDOW") : undefined;
					database.runs.appendEvent({
						runId: created.run.id,
						type: "message.completed",
						source: { kind: "assistant" },
						payload:
							scenario.messageStatus === "failed"
								? {
										messageId,
										status: "failed",
										content: "partial",
										error: error ?? makeAppError("CRASH_WINDOW"),
									}
								: {
										messageId,
										status: scenario.messageStatus,
										content: scenario.messageStatus === "complete" ? "answer" : "partial",
									},
					});

					const committed = database.runs.commitTerminal({
						runId: created.run.id,
						message: { messageId, status: "cancelled", content: "fallback" },
					});
					expect(committed.run.status).toBe(scenario.runStatus);
					expect(
						database.runs
							.listEvents({ runId: created.run.id })
							.filter((event) => event.type === "message.completed"),
					).toHaveLength(1);
					const eventCount = database.runs.listEvents({ runId: created.run.id }).length;
					const repeated = database.runs.commitTerminal({
						runId: created.run.id,
						message: { messageId, status: "cancelled", content: "fallback" },
					});
					expect(repeated.committed).toBe(false);
					expect(repeated.events).toEqual([]);
					expect(database.runs.listEvents({ runId: created.run.id })).toHaveLength(eventCount);
				}
			} finally {
				database.close();
			}
		});
	});

	test("never persists provider API keys", () => {
		withTempDatabase((databasePath) => {
			const secret = "sk-live-never-store-this";
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Provider secrecy" }).session;
				const created = database.runs.create({
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "ask",
					provider: makeProviderInput(secret),
					userMessageId: createUuidV7(),
					userContent: "Secret safety prompt",
					assistantMessageId: createUuidV7(),
				});
				expect("apiKey" in created.run.provider).toBe(false);
			} finally {
				database.close();
			}

			for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				if (existsSync(path)) {
					expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
				}
			}
		});
	});

	test("never persists provider custom header values", () => {
		withTempDatabase((databasePath) => {
			const headerSecret = "acme-secret-header-value";
			const database = openAppDatabase(databasePath);
			try {
				const session = database.sessions.create({ title: "Header secrecy" }).session;
				const created = database.runs.create({
					clientRequestId: crypto.randomUUID(),
					sessionId: session.id,
					mode: "ask",
					provider: makeProviderInput(),
					userMessageId: createUuidV7(),
					userContent: "Header safety prompt",
					assistantMessageId: createUuidV7(),
				});
				expect("customHeaders" in created.run.provider).toBe(false);
				expect(created.run.provider.source).toBe("custom");
				expect(created.run.provider.api).toBe("openai-responses");
				expect(created.run.provider.thinkingLevel).toBe("medium");
				expect(JSON.stringify(created.run)).not.toContain(headerSecret);
			} finally {
				database.close();
			}

			for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
				if (existsSync(path)) {
					expect(readFileSync(path).includes(Buffer.from(headerSecret))).toBe(false);
				}
			}
		});
	});

	test("stores and clears the Session model selection", () => {
		const database = openAppDatabase(":memory:");
		try {
			const providerId = createUuidV7();
			const created = database.sessions.create({ title: "Model selection" }).session;
			expect(created.model).toBeUndefined();

			const withThinking = database.sessions.setModel({
				sessionId: created.id,
				model: { providerId, modelId: "gpt-5.5", thinkingLevel: "high" },
			}).session;
			expect(withThinking.model).toEqual({
				providerId,
				modelId: "gpt-5.5",
				thinkingLevel: "high",
			});

			const withMinimalThinking = database.sessions.setModel({
				sessionId: created.id,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					thinkingLevel: "minimal",
				},
			}).session;
			expect(withMinimalThinking.model?.thinkingLevel).toBe("minimal");

			const cleared = database.sessions.setModel({ sessionId: created.id, model: null }).session;
			expect(cleared.model).toBeUndefined();
			expect(database.sessions.get({ sessionId: created.id }).model).toBeUndefined();
		} finally {
			database.close();
		}
	});

	test("keeps the model selection supplied at Session creation", () => {
		const database = openAppDatabase(":memory:");
		try {
			const providerId = createUuidV7();
			const created = database.sessions.create({
				title: "Inherited default",
				model: { providerId, modelId: "gpt-5.4" },
			}).session;

			expect(database.sessions.get({ sessionId: created.id }).model).toEqual({
				providerId,
				modelId: "gpt-5.4",
			});
		} finally {
			database.close();
		}
	});

	test("deletes one Session with 10,001 Runs using one retirement tombstone", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Large history" }).session;
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < 10001
					)
					INSERT INTO chat_runs (
						id, runtime_box_id, client_request_id, session_id, mode, status, provider_json,
						user_message_id, user_content, assistant_message_id, assistant_content,
						last_error_json, created_at_ms, updated_at_ms, completed_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						$runtimeBoxId,
						printf('request-%d', value),
						$sessionId,
						'ask',
						'completed',
						'{}',
						printf('10000000-0000-7000-8000-%012x', value),
						'prompt',
						printf('20000000-0000-7000-8000-%012x', value),
						'answer',
						NULL,
						value,
						value,
						value
					FROM fixture`,
				)
				.run({
					runtimeBoxId: defaultLocalRuntimeBoxId,
					sessionId: session.id,
				});

			expect(database.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
				sessionId: session.id,
			});
			expect(
				database.client
					.query<{ count: number }, []>("SELECT count(*) AS count FROM retired_chat_sessions")
					.get()?.count,
			).toBe(1);
			expect(database.runs.isSessionRetired(session.id)).toBe(true);
		} finally {
			database.close();
		}
	});

	test("backpressures unexpired retired Sessions and prunes only at the TTL boundary", () => {
		const database = openAppDatabase(":memory:");
		let nowMs = retiredSessionTombstoneTtlMs;
		const runs = new SqliteRunJournalRepository(
			database.client,
			database.orm,
			{ create: createUuidV7 },
			{ now: () => nowMs },
		);
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO retired_chat_sessions (session_id, retired_at_ms)
					SELECT printf('00000000-0000-7000-8000-%012x', value), $retiredAtMs FROM fixture`,
				)
				.run({ count: maxRetiredSessionTombstones, retiredAtMs: nowMs });
			const session = database.sessions.create({ title: "Capacity boundary" }).session;

			expect(() => runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"recovery capacity is full",
			);
			expect(database.sessions.get({ sessionId: session.id }).id).toBe(session.id);
			expect(
				database.client
					.query<{ count: number }, []>("SELECT count(*) AS count FROM retired_chat_sessions")
					.get()?.count,
			).toBe(maxRetiredSessionTombstones);

			nowMs += retiredSessionTombstoneTtlMs - 1;
			expect(() => runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"recovery capacity is full",
			);
			nowMs += 1;
			expect(runs.deleteSessionAndRetireRuns(session.id)).toEqual({ sessionId: session.id });
			expect(runs.isSessionRetired("00000000-0000-7000-8000-000000000001")).toBe(false);
			expect(runs.isSessionRetired(session.id)).toBe(true);
		} finally {
			database.close();
		}
	});

	test("writes agent-session cleanup jobs atomically and acknowledges them idempotently", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Crash durable cleanup" }).session;
			database.runs.deleteSessionAndRetireRuns(session.id);

			expect(database.sessions.list().items).toEqual([]);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([
				expect.objectContaining({ sessionId: session.id, attemptCount: 0 }),
			]);
			database.runs.ackAgentSessionCleanup(session.id);
			database.runs.ackAgentSessionCleanup(session.id);
			expect(database.runs.listPendingAgentSessionCleanups(10, true)).toEqual([]);
		} finally {
			database.close();
		}
	});

	test("keeps Session deletion idempotent across a database restart without duplicating recovery rows", () => {
		withTempDatabase((databasePath) => {
			const first = openAppDatabase(databasePath);
			const session = first.sessions.create({ title: "Restarted delete retry" }).session;
			expect(first.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
				sessionId: session.id,
			});
			first.close();

			const reopened = openAppDatabase(databasePath);
			try {
				expect(reopened.runs.deleteSessionAndRetireRuns(session.id)).toEqual({
					sessionId: session.id,
				});
				expect(reopened.runs.listPendingAgentSessionCleanups(10, true)).toHaveLength(1);
				expect(
					reopened.client
						.query<{ count: number }, [string]>(
							"SELECT count(*) AS count FROM retired_chat_sessions WHERE session_id = ?",
						)
						.get(session.id)?.count,
				).toBe(1);
				expect(() => reopened.runs.deleteSessionAndRetireRuns(createUuidV7())).toThrow("not found");
			} finally {
				reopened.close();
			}
		});
	});

	test("backpressures Session deletion when the durable agent-session outbox is full", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO agent_session_cleanup_outbox (
						session_id, created_at_ms, attempt_count, next_attempt_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						0,
						0,
						0
					FROM fixture`,
				)
				.run({ count: maxAgentSessionCleanupJobs });
			const session = database.sessions.create({ title: "Outbox capacity" }).session;

			expect(() => database.runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"Agent session cleanup recovery capacity is full",
			);
			expect(database.sessions.get({ sessionId: session.id }).id).toBe(session.id);
			database.runs.ackAgentSessionCleanup("00000000-0000-7000-8000-000000000001");
			expect(database.runs.deleteSessionAndRetireRuns(session.id).sessionId).toBe(session.id);
			expect(
				database.client
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM agent_session_cleanup_outbox",
					)
					.get()?.count,
			).toBe(maxAgentSessionCleanupJobs);
		} finally {
			database.close();
		}
	});
});
