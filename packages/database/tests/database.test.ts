import Database from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { type AppError, retiredSessionTombstoneTtlMs } from "@moshu/contracts";

import {
	applyAppMigrations,
	type CoordinatedDatabaseResetBoundary,
	chatRunsTable,
	coordinatedDatabaseResetLockSuffix,
	coordinatedDatabaseResetMarkerSuffix,
	coordinatedDatabaseResetReason,
	createUuidV7,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
	maxCheckpointDeletionJobs,
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
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		type: "openai-compatible" as const,
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-5.4",
		apiKey: secret,
		customHeaders: { "X-Org": "acme-secret-header-value" },
		reasoningEffort: "medium",
	};
}

function makeProviderState() {
	return {
		schemaVersion: 1 as const,
		providerId: createUuidV7(),
		name: "OpenAI",
		type: "openai-compatible" as const,
		baseUrl: "https://api.openai.com/v1",
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

function createLegacyResetFixture(productPath: string, checkpointPath: string): void {
	const legacy = new Database(productPath);
	legacy.exec("CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 6;");
	legacy.close();
	writeFileSync(checkpointPath, "legacy checkpoint");
	for (const sidecar of [
		`${productPath}-wal`,
		`${productPath}-shm`,
		`${checkpointPath}-wal`,
		`${checkpointPath}-shm`,
	]) {
		writeFileSync(sidecar, "");
	}
}

function expectResetStoresRecreated(productPath: string, checkpointPath: string): void {
	expect(existsSync(productPath)).toBe(true);
	expect(existsSync(checkpointPath)).toBe(true);
	const product = new Database(productPath, { readonly: true, strict: true });
	try {
		expect(getDatabaseUserVersion(product)).toBe(currentAppDatabaseVersion);
		expect(
			product
				.query<{ count: number }, []>(
					"SELECT count(*) AS count FROM sqlite_master WHERE name = 'legacy_data'",
				)
				.get()?.count,
		).toBe(0);
	} finally {
		product.close();
	}
	const checkpoint = new Database(checkpointPath, { readonly: true, strict: true });
	try {
		expect(
			checkpoint.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master").get()
				?.count,
		).toBe(0);
	} finally {
		checkpoint.close();
	}
}

function expectPersistentResetLockDatabase(productPath: string, checkpointPath: string): void {
	const lockPath = `${productPath}${coordinatedDatabaseResetLockSuffix}`;
	const metadata = lstatSync(lockPath);
	expect(metadata.isFile()).toBe(true);
	expect(metadata.isSymbolicLink()).toBe(false);
	expect(metadata.nlink).toBe(1);
	if (process.platform !== "win32") {
		expect(metadata.mode & 0o777).toBe(0o600);
	}
	const lock = new Database(lockPath, { readonly: true, strict: true });
	try {
		expect(
			lock.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
		).toBe("delete");
		expect(
			lock
				.query<
					{ schema_version: number; path_fingerprint: string; holder_token: string | null },
					[]
				>(
					"SELECT schema_version, path_fingerprint, holder_token FROM coordinated_reset_lock WHERE id = 1",
				)
				.get(),
		).toEqual({
			schema_version: 1,
			path_fingerprint: createResetPathFingerprint(productPath, checkpointPath),
			holder_token: null,
		});
	} finally {
		lock.close();
	}
	for (const sidecar of [`${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
		expect(existsSync(sidecar)).toBe(false);
	}
}

function createResetMarkerPayload(
	productPath: string,
	checkpointPath: string,
	previousProductVersion = 6,
	phase = "prepared",
): string {
	return `${JSON.stringify({
		schemaVersion: 2,
		reason: coordinatedDatabaseResetReason,
		previousProductVersion,
		pathFingerprint: createResetPathFingerprint(productPath, checkpointPath),
		phase,
	})}\n`;
}

function createResetPathFingerprint(productPath: string, checkpointPath: string): string {
	return createHash("sha256")
		.update(canonicalResetTestPath(productPath))
		.update("\0")
		.update(canonicalResetTestPath(checkpointPath))
		.digest("hex");
}

function canonicalResetTestPath(path: string): string {
	const absolute = resolve(path);
	return join(realpathSync(dirname(absolute)), basename(absolute));
}

function startResetWorker(
	productPath: string,
	checkpointPath: string,
	readyPath?: string,
	delayMs?: number,
) {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			resolve(import.meta.dir, "reset-worker.ts"),
			productPath,
			checkpointPath,
			...(readyPath === undefined ? [] : [readyPath, String(delayMs ?? 0)]),
		],
		cwd: resolve(import.meta.dir, "../../.."),
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const completed = (async () => {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(`Reset worker exited with ${exitCode}: ${stderr}`);
		}
		return JSON.parse(stdout.trim()) as {
			reset: boolean;
			reason?: string;
			previousProductVersion?: number;
		};
	})();
	return { child, completed };
}

async function waitForFile(filename: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filename)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${filename}.`);
		}
		await Bun.sleep(10);
	}
}

describe("application database", () => {
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

	test("requires a coordinated reset instead of advertising unsupported replay coverage", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec(`
				CREATE TABLE chat_sessions (id TEXT PRIMARY KEY NOT NULL);
				INSERT INTO chat_sessions (id) VALUES ('legacy-session');
				CREATE TABLE retired_chat_runs (run_id TEXT PRIMARY KEY NOT NULL, retired_at_ms INTEGER NOT NULL);
				INSERT INTO retired_chat_runs VALUES ('00000000-0000-7000-8000-000000000001', 1);
				PRAGMA user_version = 6;
			`);
			legacy.close();

			expect(() => openAppDatabase(databasePath)).toThrow("requires a coordinated reset");
			const unchanged = new Database(databasePath, { readonly: true });
			expect(getDatabaseUserVersion(unchanged)).toBe(6);
			expect(
				unchanged
					.query<{ count: number }, []>("SELECT count(*) AS count FROM retired_chat_runs")
					.get()?.count,
			).toBe(1);
			unchanged.close();
		});
	});

	test("does not treat an existing unversioned schema as a new product store", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec("CREATE TABLE legacy_data (value TEXT);");
			legacy.close();

			expect(() => openAppDatabase(databasePath)).toThrow("requires a coordinated reset");
			const unchanged = new Database(databasePath, { readonly: true });
			expect(
				unchanged
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_data'",
					)
					.get()?.name,
			).toBe("legacy_data");
			unchanged.close();
		});
	});

	test("coordinates reset of the immediately preceding product schema", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const previousVersion = currentAppDatabaseVersion - 1;
			const previous = new Database(databasePath);
			previous.exec(
				`CREATE TABLE previous_schema (value TEXT); PRAGMA user_version = ${previousVersion};`,
			);
			previous.close();
			writeFileSync(checkpointPath, "previous checkpoint");

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: previousVersion,
			});
			expectResetStoresRecreated(databasePath, checkpointPath);
		});
	});

	test("resets product and checkpoint stores with sidecars while preserving provider config", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const providerPath = join(dirname(databasePath), "provider.json");
			const legacy = new Database(databasePath);
			legacy.exec("CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			writeFileSync(checkpointPath, "legacy checkpoint");
			writeFileSync(providerPath, "provider stays");
			for (const sidecar of [
				`${databasePath}-wal`,
				`${databasePath}-shm`,
				`${checkpointPath}-wal`,
				`${checkpointPath}-shm`,
			]) {
				writeFileSync(sidecar, "");
			}
			const boundaries: CoordinatedDatabaseResetBoundary[] = [];

			expect(
				prepareCoordinatedDatabaseReset(
					{
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					},
					{ beforeBoundary: (boundary) => boundaries.push(boundary) },
				),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expect(boundaries).toEqual([
				"create-marker",
				"delete-checkpoint-database",
				"delete-checkpoint-wal",
				"delete-checkpoint-shm",
				"delete-product-wal",
				"delete-product-shm",
				"delete-product-database",
				"recreate-product-database",
				"recreate-checkpoint-database",
				"delete-marker",
			]);
			for (const removed of [
				`${checkpointPath}-wal`,
				`${checkpointPath}-shm`,
				`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`,
			]) {
				expect(existsSync(removed)).toBe(false);
			}
			expectResetStoresRecreated(databasePath, checkpointPath);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
			expect(readFileSync(providerPath, "utf8")).toBe("provider stays");
		});
	});

	test("converges after an injected failure at every coordinated reset boundary", () => {
		const boundaries: CoordinatedDatabaseResetBoundary[] = [
			"create-marker",
			"delete-checkpoint-database",
			"delete-checkpoint-wal",
			"delete-checkpoint-shm",
			"delete-product-wal",
			"delete-product-shm",
			"delete-product-database",
			"recreate-product-database",
			"recreate-checkpoint-database",
			"delete-marker",
		];

		for (const failedBoundary of boundaries) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const providerPath = join(dirname(databasePath), "provider.json");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				const markerStagingPath = `${markerPath}.creating`;
				createLegacyResetFixture(databasePath, checkpointPath);
				writeFileSync(providerPath, "provider stays");
				let injected = false;

				expect(() =>
					prepareCoordinatedDatabaseReset(
						{
							productDatabase: databasePath,
							checkpointDatabase: checkpointPath,
						},
						{
							beforeBoundary(boundary) {
								if (!injected && boundary === failedBoundary) {
									injected = true;
									throw new Error(`injected ${boundary} failure`);
								}
							},
						},
					),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(injected).toBe(true);
				expect(readFileSync(providerPath, "utf8")).toBe("provider stays");

				if (failedBoundary === "create-marker") {
					expect(existsSync(markerPath)).toBe(false);
					expect(existsSync(databasePath)).toBe(true);
					expect(existsSync(checkpointPath)).toBe(true);
				} else {
					const marker = readFileSync(markerPath, "utf8");
					expect(Buffer.byteLength(marker)).toBeLessThan(8_192);
					expect(marker).not.toContain(databasePath);
					expect(marker).not.toContain("provider stays");
				}
				if (failedBoundary === "delete-product-database") {
					expect(existsSync(databasePath)).toBe(true);
					expect(existsSync(checkpointPath)).toBe(false);
				}
				if (failedBoundary === "delete-marker") {
					expect(existsSync(databasePath)).toBe(true);
					expect(existsSync(checkpointPath)).toBe(true);
					expect(existsSync(markerPath)).toBe(true);
				}

				expect(
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
				).toEqual({
					reset: true,
					reason: coordinatedDatabaseResetReason,
					previousProductVersion: 6,
				});
				for (const removed of [
					`${checkpointPath}-wal`,
					`${checkpointPath}-shm`,
					markerPath,
					markerStagingPath,
				]) {
					expect(existsSync(removed)).toBe(false);
				}
				expectResetStoresRecreated(databasePath, checkpointPath);
				expectPersistentResetLockDatabase(databasePath, checkpointPath);
				expect(readFileSync(providerPath, "utf8")).toBe("provider stays");
			});
		}
	});

	test("continues a committed reset when user_version existed only in the deleted WAL", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const legacy = new Database(databasePath);
			legacy.exec(`
				PRAGMA journal_mode = WAL;
				PRAGMA wal_autocheckpoint = 0;
				CREATE TABLE legacy_data (value TEXT);
				PRAGMA user_version = 6;
			`);
			writeFileSync(checkpointPath, "legacy checkpoint");
			writeFileSync(`${checkpointPath}-wal`, "");
			writeFileSync(`${checkpointPath}-shm`, "");
			expect(readFileSync(databasePath).readUInt32BE(60)).toBe(0);
			expect(existsSync(`${databasePath}-wal`)).toBe(true);

			try {
				expect(() =>
					prepareCoordinatedDatabaseReset(
						{
							productDatabase: databasePath,
							checkpointDatabase: checkpointPath,
						},
						{
							beforeBoundary(boundary) {
								if (boundary === "delete-product-shm") {
									throw new Error("crash after deleting the product WAL");
								}
							},
						},
					),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(existsSync(`${databasePath}-wal`)).toBe(false);
			} finally {
				legacy.close();
			}

			expect(readFileSync(databasePath).readUInt32BE(60)).toBe(0);
			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			for (const removed of [
				`${checkpointPath}-wal`,
				`${checkpointPath}-shm`,
				`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`,
			]) {
				expect(existsSync(removed)).toBe(false);
			}
			expectResetStoresRecreated(databasePath, checkpointPath);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
		});
	});

	test("serializes concurrent reset openers across processes", async () => {
		const directoryPath = mkdtempSync(join(tmpdir(), "moshu-reset-processes-"));
		const databasePath = join(directoryPath, "app.db");
		const checkpointPath = join(directoryPath, "checkpoints.db");
		const readyPath = join(directoryPath, "first-worker-ready");
		createLegacyResetFixture(databasePath, checkpointPath);
		const first = startResetWorker(databasePath, checkpointPath, readyPath, 300);
		let second: ReturnType<typeof startResetWorker> | undefined;
		try {
			await waitForFile(readyPath);
			second = startResetWorker(databasePath, checkpointPath);
			const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
			expect(firstResult).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expect(secondResult).toEqual({ reset: false });
			expectResetStoresRecreated(databasePath, checkpointPath);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
		} finally {
			if (first.child.exitCode === null) {
				first.child.kill();
			}
			if (second?.child.exitCode === null) {
				second.child.kill();
			}
			rmSync(directoryPath, { force: true, recursive: true });
		}
	}, 10_000);

	test("reuses a stale lock database without deleting or replacing it", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const lockPath = `${databasePath}${coordinatedDatabaseResetLockSuffix}`;
			createLegacyResetFixture(databasePath, checkpointPath);

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			const firstIdentity = lstatSync(lockPath);
			expectResetStoresRecreated(databasePath, checkpointPath);
			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({ reset: false });
			const secondIdentity = lstatSync(lockPath);
			expect(secondIdentity.dev).toBe(firstIdentity.dev);
			expect(secondIdentity.ino).toBe(firstIdentity.ino);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
		});
	});

	test("bounds lock waiting while a suspended holder retains ownership without expiry", async () => {
		const directoryPath = mkdtempSync(join(tmpdir(), "moshu-reset-suspended-"));
		const databasePath = join(directoryPath, "app.db");
		const checkpointPath = join(directoryPath, "checkpoints.db");
		const readyPath = join(directoryPath, "holder-ready");
		createLegacyResetFixture(databasePath, checkpointPath);
		const holder = startResetWorker(databasePath, checkpointPath, readyPath, 400);
		try {
			await waitForFile(readyPath);
			const startedAt = Date.now();
			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{ lockWaitTimeoutMs: 30 },
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(Date.now() - startedAt).toBeLessThan(1_000);
			expect(existsSync(databasePath)).toBe(true);
			expect(existsSync(checkpointPath)).toBe(true);
			await expect(holder.completed).resolves.toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
		} finally {
			if (holder.child.exitCode === null) {
				holder.child.kill();
			}
			rmSync(directoryPath, { force: true, recursive: true });
		}
	}, 10_000);

	test("releases the holder-bound SQLite lock on process death and converges", async () => {
		const directoryPath = mkdtempSync(join(tmpdir(), "moshu-reset-crash-holder-"));
		const databasePath = join(directoryPath, "app.db");
		const checkpointPath = join(directoryPath, "checkpoints.db");
		const readyPath = join(directoryPath, "holder-ready");
		createLegacyResetFixture(databasePath, checkpointPath);
		const holder = startResetWorker(databasePath, checkpointPath, readyPath, 10_000);
		let successor: ReturnType<typeof startResetWorker> | undefined;
		try {
			await waitForFile(readyPath);
			successor = startResetWorker(databasePath, checkpointPath);
			await Bun.sleep(50);
			holder.child.kill();
			await holder.completed.catch(() => undefined);
			await expect(successor.completed).resolves.toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expectResetStoresRecreated(databasePath, checkpointPath);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);
		} finally {
			if (holder.child.exitCode === null) {
				holder.child.kill();
			}
			if (successor?.child.exitCode === null) {
				successor.child.kill();
			}
			rmSync(directoryPath, { force: true, recursive: true });
		}
	}, 10_000);

	test("quarantines and preserves a replacement that mismatches the marker identity", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			createLegacyResetFixture(databasePath, checkpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-product-database") {
								throw new Error("crash immediately before recorded unlink");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");

			unlinkSync(databasePath);
			writeFileSync(databasePath, "new database owner");
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(existsSync(databasePath)).toBe(false);
			const claims = readdirSync(dirname(databasePath))
				.filter((entry) => entry.startsWith(".moshu-reset-claim-"))
				.map((entry) => join(dirname(databasePath), entry));
			expect(claims).toHaveLength(1);
			expect(readFileSync(claims[0] ?? "", "utf8")).toBe("new database owner");
		});
	});

	test("never deletes a successor created after the expected inode is atomically claimed", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			createLegacyResetFixture(databasePath, checkpointPath);
			let injected = false;

			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						afterArtifactClaim(boundary) {
							if (!injected && boundary === "delete-product-database") {
								injected = true;
								writeFileSync(databasePath, "successor must survive");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(injected).toBe(true);
			expect(readFileSync(databasePath, "utf8")).toBe("successor must survive");
			const claims = readdirSync(dirname(databasePath)).filter((entry) =>
				entry.startsWith(".moshu-reset-claim-"),
			);
			expect(claims).toHaveLength(1);

			unlinkSync(databasePath);
			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expectResetStoresRecreated(databasePath, checkpointPath);
			expect(
				readdirSync(dirname(databasePath)).filter((entry) =>
					entry.startsWith(".moshu-reset-claim-"),
				),
			).toEqual([]);
		});
	});

	test("converges after holder death between an atomic claim and unlink", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			createLegacyResetFixture(databasePath, checkpointPath);
			let injected = false;

			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						afterArtifactClaim(boundary) {
							if (!injected && boundary === "delete-checkpoint-database") {
								injected = true;
								throw new Error("crash after atomic claim");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(injected).toBe(true);
			expect(existsSync(checkpointPath)).toBe(false);
			expect(
				readdirSync(dirname(databasePath)).filter((entry) =>
					entry.startsWith(".moshu-reset-claim-"),
				),
			).toHaveLength(1);

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expectResetStoresRecreated(databasePath, checkpointPath);
			expect(
				readdirSync(dirname(databasePath)).filter((entry) =>
					entry.startsWith(".moshu-reset-claim-"),
				),
			).toEqual([]);
		});
	});

	test("fails closed when an expected reset artifact becomes a symlink", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const sentinelPath = join(dirname(databasePath), "replacement-sentinel");
			createLegacyResetFixture(databasePath, checkpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-product-database") {
								throw new Error("pause before product deletion");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");

			unlinkSync(databasePath);
			writeFileSync(sentinelPath, "never delete");
			symlinkSync(sentinelPath, databasePath);
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(readFileSync(sentinelPath, "utf8")).toBe("never delete");
		});
	});

	test("fails closed when a marker-recorded absence becomes a file", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const checkpointWalPath = `${checkpointPath}-wal`;
			createLegacyResetFixture(databasePath, checkpointPath);
			unlinkSync(checkpointWalPath);

			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-checkpoint-wal") {
								writeFileSync(checkpointWalPath, "new checkpoint writer");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(readFileSync(checkpointWalPath, "utf8")).toBe("new checkpoint writer");
			expect(existsSync(databasePath)).toBe(true);
		});
	});

	test("uses the persisted fingerprint when platform file ids are unavailable", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
			createLegacyResetFixture(databasePath, checkpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset(
					{ productDatabase: databasePath, checkpointDatabase: checkpointPath },
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-product-database") {
								throw new Error("capture marker identity");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
				artifacts: Record<string, { dev: string; ino: string }>;
			};
			const productIdentity = marker.artifacts["delete-product-database"];
			if (productIdentity === undefined) {
				throw new Error("Expected a product database identity.");
			}
			productIdentity.dev = "0";
			productIdentity.ino = "0";
			writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
			expectResetStoresRecreated(databasePath, checkpointPath);
		});
	});

	test("fails closed for a symbolic reset lock without touching its target", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const lockPath = `${databasePath}${coordinatedDatabaseResetLockSuffix}`;
			const sentinelPath = join(dirname(databasePath), "lock-sentinel");
			createLegacyResetFixture(databasePath, checkpointPath);
			writeFileSync(sentinelPath, "never alter");
			symlinkSync(sentinelPath, lockPath);

			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(readFileSync(sentinelPath, "utf8")).toBe("never alter");
			expect(existsSync(databasePath)).toBe(true);
			expect(existsSync(checkpointPath)).toBe(true);
		});
	});

	test("fails closed for unsafe reset lock permissions and hard-link identity", () => {
		if (process.platform === "win32") {
			return;
		}
		for (const unsafe of ["permissions", "hard-link"] as const) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const lockPath = `${databasePath}${coordinatedDatabaseResetLockSuffix}`;
				createLegacyResetFixture(databasePath, checkpointPath);
				writeFileSync(lockPath, "never alter", { mode: 0o600 });
				if (unsafe === "permissions") {
					chmodSync(lockPath, 0o644);
				} else {
					linkSync(lockPath, join(dirname(databasePath), "lock-alias"));
				}

				expect(() =>
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(readFileSync(lockPath, "utf8")).toBe("never alter");
				expect(existsSync(databasePath)).toBe(true);
				expect(existsSync(checkpointPath)).toBe(true);
			});
		}
	});

	test("rejects path-bound or phase-tampered committed reset markers before deletion", () => {
		withTempDatabase((sourceDatabasePath) => {
			const sourceCheckpointPath = join(dirname(sourceDatabasePath), "source-checkpoints.db");
			createLegacyResetFixture(sourceDatabasePath, sourceCheckpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset(
					{
						productDatabase: sourceDatabasePath,
						checkpointDatabase: sourceCheckpointPath,
					},
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-checkpoint-database") {
								throw new Error("capture committed marker");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			const sourceMarker = readFileSync(
				`${sourceDatabasePath}${coordinatedDatabaseResetMarkerSuffix}`,
				"utf8",
			);

			withTempDatabase((targetDatabasePath) => {
				const targetCheckpointPath = join(dirname(targetDatabasePath), "target-checkpoints.db");
				createLegacyResetFixture(targetDatabasePath, targetCheckpointPath);
				writeFileSync(`${targetDatabasePath}${coordinatedDatabaseResetMarkerSuffix}`, sourceMarker);
				expect(() =>
					prepareCoordinatedDatabaseReset({
						productDatabase: targetDatabasePath,
						checkpointDatabase: targetCheckpointPath,
					}),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(existsSync(targetDatabasePath)).toBe(true);
				expect(existsSync(targetCheckpointPath)).toBe(true);
			});

			withTempDatabase((targetDatabasePath) => {
				const targetCheckpointPath = join(dirname(targetDatabasePath), "target-checkpoints.db");
				createLegacyResetFixture(targetDatabasePath, targetCheckpointPath);
				writeFileSync(
					`${targetDatabasePath}${coordinatedDatabaseResetMarkerSuffix}`,
					createResetMarkerPayload(targetDatabasePath, targetCheckpointPath, 6, "complete"),
				);
				expect(() =>
					prepareCoordinatedDatabaseReset({
						productDatabase: targetDatabasePath,
						checkpointDatabase: targetCheckpointPath,
					}),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(existsSync(targetDatabasePath)).toBe(true);
				expect(existsSync(targetCheckpointPath)).toBe(true);
			});
		});
	});

	test("converges from every interrupted marker staging commit state", () => {
		const scenarios: Array<{
			name: string;
			arrange(markerPath: string, stagingPath: string, payload: string): void;
		}> = [
			{
				name: "after staging open",
				arrange: (_markerPath, stagingPath) => writeFileSync(stagingPath, ""),
			},
			{
				name: "during staging write",
				arrange: (_markerPath, stagingPath, payload) =>
					writeFileSync(stagingPath, payload.slice(0, Math.floor(payload.length / 2))),
			},
			{
				name: "after staging write before file fsync",
				arrange: (_markerPath, stagingPath, payload) => writeFileSync(stagingPath, payload),
			},
			{
				name: "after file fsync before atomic commit",
				arrange: (_markerPath, stagingPath, payload) => writeFileSync(stagingPath, payload),
			},
			{
				name: "after atomic commit before parent fsync",
				arrange(markerPath, stagingPath, payload) {
					writeFileSync(stagingPath, payload);
					linkSync(stagingPath, markerPath);
				},
			},
			{
				name: "after parent fsync before staging cleanup",
				arrange(markerPath, stagingPath, payload) {
					writeFileSync(stagingPath, payload);
					linkSync(stagingPath, markerPath);
				},
			},
			{
				name: "after staging cleanup before final parent fsync",
				arrange: (markerPath, _stagingPath, payload) => writeFileSync(markerPath, payload),
			},
		];

		for (const scenario of scenarios) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				const stagingPath = `${markerPath}.creating`;
				createLegacyResetFixture(databasePath, checkpointPath);
				scenario.arrange(
					markerPath,
					stagingPath,
					createResetMarkerPayload(databasePath, checkpointPath),
				);

				expect(
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
					scenario.name,
				).toEqual({
					reset: true,
					reason: coordinatedDatabaseResetReason,
					previousProductVersion: 6,
				});
				expect(existsSync(markerPath), scenario.name).toBe(false);
				expect(existsSync(stagingPath), scenario.name).toBe(false);
				expectResetStoresRecreated(databasePath, checkpointPath);

				expect(
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
					`${scenario.name} next launch`,
				).toEqual({ reset: false });
			});
		}
	});

	test("preserves committed recovery while cleaning an invalid stale staging marker", () => {
		for (const [name, stalePayload] of [
			["malformed", '{"schemaVersion":1'],
			["oversized", "x".repeat(257)],
		] as const) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				const stagingPath = `${markerPath}.creating`;
				createLegacyResetFixture(databasePath, checkpointPath);
				writeFileSync(markerPath, createResetMarkerPayload(databasePath, checkpointPath));
				writeFileSync(stagingPath, stalePayload);

				expect(
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
					name,
				).toEqual({
					reset: true,
					reason: coordinatedDatabaseResetReason,
					previousProductVersion: 6,
				});
				expect(existsSync(markerPath), name).toBe(false);
				expect(existsSync(stagingPath), name).toBe(false);
			});
		}
	});

	test("replaces an oversized interrupted staging marker before starting a reset", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
			const stagingPath = `${markerPath}.creating`;
			createLegacyResetFixture(databasePath, checkpointPath);
			writeFileSync(stagingPath, "x".repeat(8_193));

			expect(() =>
				prepareCoordinatedDatabaseReset(
					{
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					},
					{
						beforeBoundary(boundary) {
							if (boundary === "delete-checkpoint-database") {
								throw new Error("inspect recreated marker");
							}
						},
					},
				),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(
				expect.objectContaining({
					schemaVersion: 4,
					reason: coordinatedDatabaseResetReason,
					previousProductVersion: 6,
					phase: "delete-checkpoint-database",
					resetId: expect.any(String),
					artifacts: expect.objectContaining({
						"delete-product-database": expect.objectContaining({ state: "file" }),
						"delete-checkpoint-database": expect.objectContaining({ state: "file" }),
					}),
				}),
			);
			expect(existsSync(stagingPath)).toBe(false);

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
				previousProductVersion: 6,
			});
		});
	});

	test("continues to reject malformed and oversized committed markers", () => {
		for (const [name, payload] of [
			["malformed", '{"schemaVersion":1'],
			["oversized", "x".repeat(8_193)],
		] as const) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				createLegacyResetFixture(databasePath, checkpointPath);
				writeFileSync(markerPath, payload);

				expect(
					() =>
						prepareCoordinatedDatabaseReset({
							productDatabase: databasePath,
							checkpointDatabase: checkpointPath,
						}),
					name,
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(readFileSync(markerPath, "utf8"), name).toBe(payload);
				expect(existsSync(databasePath), name).toBe(true);
				expect(existsSync(checkpointPath), name).toBe(true);
			});
		}
	});

	test("fails closed for committed marker symlinks, hard links, and wrong ownership", () => {
		const anomalies =
			process.getuid === undefined
				? (["symlink", "hard-link"] as const)
				: (["symlink", "hard-link", "wrong-owner"] as const);
		for (const anomaly of anomalies) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				const sentinelPath = join(dirname(databasePath), `${anomaly}-committed-sentinel`);
				createLegacyResetFixture(databasePath, checkpointPath);
				const markerPayload = createResetMarkerPayload(databasePath, checkpointPath);
				writeFileSync(sentinelPath, markerPayload);
				if (anomaly === "symlink") {
					symlinkSync(sentinelPath, markerPath);
				} else if (anomaly === "hard-link") {
					linkSync(sentinelPath, markerPath);
				} else {
					writeFileSync(markerPath, markerPayload);
				}

				const originalGetuid = process.getuid;
				if (anomaly === "wrong-owner" && originalGetuid !== undefined) {
					process.getuid = () => originalGetuid() + 1;
				}
				try {
					expect(() =>
						prepareCoordinatedDatabaseReset({
							productDatabase: databasePath,
							checkpointDatabase: checkpointPath,
						}),
					).toThrow("Failed to complete the coordinated local database reset.");
				} finally {
					if (originalGetuid !== undefined) {
						process.getuid = originalGetuid;
					}
				}
				expect(readFileSync(sentinelPath, "utf8")).toBe(markerPayload);
				expect(existsSync(databasePath)).toBe(true);
				expect(existsSync(checkpointPath)).toBe(true);
			});
		}
	});

	test("fails closed for staging symlinks, hard links, and wrong ownership", () => {
		const anomalies =
			process.getuid === undefined
				? (["symlink", "hard-link"] as const)
				: (["symlink", "hard-link", "wrong-owner"] as const);
		for (const anomaly of anomalies) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const markerPath = `${databasePath}${coordinatedDatabaseResetMarkerSuffix}`;
				const stagingPath = `${markerPath}.creating`;
				const sentinelPath = join(dirname(databasePath), `${anomaly}-sentinel`);
				createLegacyResetFixture(databasePath, checkpointPath);
				writeFileSync(sentinelPath, "do not alter");
				if (anomaly === "symlink") {
					symlinkSync(sentinelPath, stagingPath);
				} else if (anomaly === "hard-link") {
					linkSync(sentinelPath, stagingPath);
				} else {
					writeFileSync(stagingPath, "");
				}

				const originalGetuid = process.getuid;
				if (anomaly === "wrong-owner" && originalGetuid !== undefined) {
					process.getuid = () => originalGetuid() + 1;
				}
				try {
					expect(() =>
						prepareCoordinatedDatabaseReset({
							productDatabase: databasePath,
							checkpointDatabase: checkpointPath,
						}),
					).toThrow("Failed to complete the coordinated local database reset.");
				} finally {
					if (originalGetuid !== undefined) {
						process.getuid = originalGetuid;
					}
				}
				expect(readFileSync(sentinelPath, "utf8")).toBe("do not alter");
				expect(existsSync(databasePath)).toBe(true);
				expect(existsSync(checkpointPath)).toBe(true);
				expect(existsSync(markerPath)).toBe(false);
			});
		}
	});

	test("removes a stale checkpoint store when a legacy interrupted reset lacks product main", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const staleCheckpoint = new Database(checkpointPath);
			staleCheckpoint.exec(
				"CREATE TABLE stale_checkpoint (value TEXT); INSERT INTO stale_checkpoint VALUES ('stale');",
			);
			staleCheckpoint.close();
			for (const sidecar of [
				`${databasePath}-wal`,
				`${databasePath}-shm`,
				`${checkpointPath}-wal`,
				`${checkpointPath}-shm`,
			]) {
				writeFileSync(sidecar, "");
			}

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({
				reset: true,
				reason: coordinatedDatabaseResetReason,
			});
			for (const removed of [
				`${checkpointPath}-wal`,
				`${checkpointPath}-shm`,
				`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`,
			]) {
				expect(existsSync(removed)).toBe(false);
			}
			expectResetStoresRecreated(databasePath, checkpointPath);
			expectPersistentResetLockDatabase(databasePath, checkpointPath);

			const freshCheckpoint = new Database(checkpointPath, { readonly: true, strict: true });
			expect(
				freshCheckpoint
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM sqlite_master WHERE name = 'stale_checkpoint'",
					)
					.get()?.count,
			).toBe(0);
			freshCheckpoint.close();
		});
	});

	test("fails closed for aliased or symbolic coordinated reset paths", () => {
		withTempDatabase((databasePath) => {
			const legacy = new Database(databasePath);
			legacy.exec("CREATE TABLE legacy_data (value TEXT); PRAGMA user_version = 6;");
			legacy.close();
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: databasePath,
				}),
			).toThrow("must be distinct");
			expect(existsSync(databasePath)).toBe(true);

			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const sentinelPath = join(dirname(databasePath), "checkpoint-sentinel");
			writeFileSync(sentinelPath, "do not unlink");
			symlinkSync(sentinelPath, checkpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(readFileSync(sentinelPath, "utf8")).toBe("do not unlink");
			expect(existsSync(databasePath)).toBe(true);
			expect(existsSync(`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`)).toBe(false);

			rmSync(checkpointPath);
			linkSync(databasePath, checkpointPath);
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(existsSync(databasePath)).toBe(true);
			expect(existsSync(checkpointPath)).toBe(true);
			expect(existsSync(`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`)).toBe(false);

			rmSync(checkpointPath);
			writeFileSync(
				`${databasePath}${coordinatedDatabaseResetMarkerSuffix}`,
				`${JSON.stringify({
					schemaVersion: 1,
					reason: coordinatedDatabaseResetReason,
					previousProductVersion: 5,
				})}\n`,
			);
			expect(() =>
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toThrow("Failed to complete the coordinated local database reset.");
			expect(existsSync(databasePath)).toBe(true);
		});
	});

	test("does not reset coordinated stores at the current product schema", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const database = openAppDatabase(databasePath);
			database.close();
			writeFileSync(checkpointPath, "current checkpoint marker");

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({ reset: false });
			expect(readFileSync(checkpointPath, "utf8")).toBe("current checkpoint marker");
		});
	});

	test("validates current-schema checkpoint paths before returning without a reset", () => {
		for (const anomaly of ["checkpoint-symlink", "checkpoint-alias", "sidecar-symlink"] as const) {
			withTempDatabase((databasePath) => {
				const checkpointPath = join(dirname(databasePath), "checkpoints.db");
				const sentinelPath = join(dirname(databasePath), `${anomaly}-sentinel`);
				const database = openAppDatabase(databasePath);
				database.close();

				if (anomaly === "checkpoint-symlink") {
					writeFileSync(sentinelPath, "do not open as a checkpoint");
					symlinkSync(sentinelPath, checkpointPath);
				} else if (anomaly === "checkpoint-alias") {
					linkSync(databasePath, checkpointPath);
				} else {
					writeFileSync(sentinelPath, "do not unlink");
					symlinkSync(sentinelPath, `${checkpointPath}-wal`);
				}

				expect(() =>
					prepareCoordinatedDatabaseReset({
						productDatabase: databasePath,
						checkpointDatabase: checkpointPath,
					}),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(existsSync(databasePath)).toBe(true);
				if (anomaly !== "checkpoint-alias") {
					expect(readFileSync(sentinelPath, "utf8")).toStartWith("do not");
				}
			});
		}
	});

	test("accepts an absent checkpoint path for a current product schema", () => {
		withTempDatabase((databasePath) => {
			const checkpointPath = join(dirname(databasePath), "checkpoints.db");
			const database = openAppDatabase(databasePath);
			database.close();

			expect(
				prepareCoordinatedDatabaseReset({
					productDatabase: databasePath,
					checkpointDatabase: checkpointPath,
				}),
			).toEqual({ reset: false });
			expect(existsSync(checkpointPath)).toBe(false);
		});
	});

	test("rejects symlinked parent components before a current-schema fast path", () => {
		for (const selectedPath of ["product", "checkpoint"] as const) {
			withTempDatabase((databasePath) => {
				const root = dirname(databasePath);
				const realDirectory = join(root, `${selectedPath}-store`);
				const linkedDirectory = join(root, `${selectedPath}-store-link`);
				mkdirSync(realDirectory);
				symlinkSync(realDirectory, linkedDirectory);
				const realProductPath =
					selectedPath === "product" ? join(realDirectory, "app.db") : databasePath;
				const productPath =
					selectedPath === "product" ? join(linkedDirectory, "app.db") : databasePath;
				const checkpointPath =
					selectedPath === "checkpoint"
						? join(linkedDirectory, "checkpoints.db")
						: join(root, "checkpoints.db");
				const database = openAppDatabase(realProductPath);
				database.close();

				expect(() =>
					prepareCoordinatedDatabaseReset({
						productDatabase: productPath,
						checkpointDatabase: checkpointPath,
					}),
				).toThrow("Failed to complete the coordinated local database reset.");
				expect(existsSync(realProductPath)).toBe(true);
			});
		}
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
						id, title, default_mode, created_at_ms, updated_at_ms,
						last_message_at_ms, archived_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						'capacity fixture',
						'ask',
						value,
						value,
						NULL,
						NULL
					FROM fixture`,
				)
				.run({ count: maxSessionCreateIdempotencyRecords });
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO chat_session_create_requests (
						create_key, origin_role, origin_peer_id, origin_instance_id,
						origin_generation, title, default_mode, session_id, created_at_ms
					)
					SELECT
						printf('capacity-key-%d', value),
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
				.run({ count: maxSessionCreateIdempotencyRecords });

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
				expect(created.run.provider.type).toBe("openai-compatible");
				expect(created.run.provider.reasoningEffort).toBe("medium");
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

	test("reads run journals written with legacy protocol-shaped Provider types", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Legacy Provider types" }).session;
			const created = database.runs.create({
				clientRequestId: crypto.randomUUID(),
				sessionId: session.id,
				mode: "ask",
				provider: makeProviderInput(),
				userMessageId: createUuidV7(),
				userContent: "Legacy Provider prompt",
				assistantMessageId: createUuidV7(),
			});

			for (const [legacyType, expectedType] of [
				["openai-chat-completions", "openai-compatible"],
				["openai-responses", "openai-compatible"],
				["anthropic-messages", "anthropic-compatible"],
			] as const) {
				database.client
					.query("UPDATE chat_runs SET provider_json = $providerJson WHERE id = $runId")
					.run({
						runId: created.run.id,
						providerJson: JSON.stringify({ ...created.run.provider, type: legacyType }),
					});
				expect(database.runs.get(created.run.id).provider.type).toBe(expectedType);
			}
		} finally {
			database.close();
		}
	});

	test("stores and clears the Session model selection", () => {
		const database = openAppDatabase(":memory:");
		try {
			const providerId = createUuidV7();
			const created = database.sessions.create({ title: "Model selection" }).session;
			expect(created.model).toBeUndefined();

			const withEffort = database.sessions.setModel({
				sessionId: created.id,
				model: { providerId, modelId: "gpt-5.5", reasoning: { effort: "high" } },
			}).session;
			expect(withEffort.model).toEqual({
				providerId,
				modelId: "gpt-5.5",
				reasoning: { effort: "high" },
			});

			const withBudget = database.sessions.setModel({
				sessionId: created.id,
				model: {
					providerId,
					modelId: "claude-opus-4.6",
					reasoning: { budgetTokens: 8_192 },
				},
			}).session;
			expect(withBudget.model?.reasoning).toEqual({ budgetTokens: 8_192 });

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
						id, client_request_id, session_id, mode, status, provider_json,
						user_message_id, user_content, assistant_message_id, assistant_content,
						last_error_json, created_at_ms, updated_at_ms, completed_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
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
				.run({ sessionId: session.id });

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

	test("writes checkpoint deletion jobs atomically and acknowledges them idempotently", () => {
		const database = openAppDatabase(":memory:");
		try {
			const session = database.sessions.create({ title: "Crash durable cleanup" }).session;
			database.runs.deleteSessionAndRetireRuns(session.id);

			expect(database.sessions.list().items).toEqual([]);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([
				expect.objectContaining({ sessionId: session.id, attemptCount: 0 }),
			]);
			database.runs.ackCheckpointDeletion(session.id);
			database.runs.ackCheckpointDeletion(session.id);
			expect(database.runs.listPendingCheckpointDeletions(10, true)).toEqual([]);
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
				expect(reopened.runs.listPendingCheckpointDeletions(10, true)).toHaveLength(1);
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

	test("backpressures Session deletion when the durable checkpoint outbox is full", () => {
		const database = openAppDatabase(":memory:");
		try {
			database.client
				.query(
					`WITH RECURSIVE fixture(value) AS (
						SELECT 1
						UNION ALL
						SELECT value + 1 FROM fixture WHERE value < $count
					)
					INSERT INTO checkpoint_deletion_outbox (
						session_id, created_at_ms, attempt_count, next_attempt_at_ms
					)
					SELECT
						printf('00000000-0000-7000-8000-%012x', value),
						0,
						0,
						0
					FROM fixture`,
				)
				.run({ count: maxCheckpointDeletionJobs });
			const session = database.sessions.create({ title: "Outbox capacity" }).session;

			expect(() => database.runs.deleteSessionAndRetireRuns(session.id)).toThrow(
				"Checkpoint deletion recovery capacity is full",
			);
			expect(database.sessions.get({ sessionId: session.id }).id).toBe(session.id);
			database.runs.ackCheckpointDeletion("00000000-0000-7000-8000-000000000001");
			expect(database.runs.deleteSessionAndRetireRuns(session.id).sessionId).toBe(session.id);
			expect(
				database.client
					.query<{ count: number }, []>("SELECT count(*) AS count FROM checkpoint_deletion_outbox")
					.get()?.count,
			).toBe(maxCheckpointDeletionJobs);
		} finally {
			database.close();
		}
	});
});
