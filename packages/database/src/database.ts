import Database from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
	applyAppMigrations,
	currentAppDatabaseVersion,
	getDatabaseUserVersion,
} from "./migrations";
import { createRunJournalRepository, type RunJournalRepository } from "./run-journal-repository";
import { appSchema } from "./schema";
import { createSessionRepository, type SessionRepository } from "./session-repository";

export type AppDrizzleDatabase = ReturnType<typeof drizzle>;

export interface AppDatabase {
	client: Database;
	orm: AppDrizzleDatabase;
	sessions: SessionRepository;
	runs: RunJournalRepository;
	close(): void;
}

export const coordinatedDatabaseResetReason = "product-schema-cutover" as const;
export const coordinatedDatabaseResetMarkerSuffix = ".reset-in-progress" as const;
export const coordinatedDatabaseResetLockSuffix = ".reset-lock" as const;

const coordinatedDatabaseResetMarkerStagingSuffix = ".creating";
const coordinatedDatabaseResetMarkerSchemaVersion = 4;
const artifactCoordinatedDatabaseResetMarkerSchemaVersion = 3;
const legacyCoordinatedDatabaseResetMarkerSchemaVersion = 2;
const maxCoordinatedDatabaseResetMarkerBytes = 8_192;
const coordinatedDatabaseResetLockSchemaVersion = 1;
const coordinatedDatabaseResetLockWaitTimeoutMs = 5_000;
const coordinatedDatabaseResetFailureMessage =
	"Failed to complete the coordinated local database reset.";
const coordinatedDatabaseResetDeleteSteps = [
	"delete-checkpoint-database",
	"delete-checkpoint-wal",
	"delete-checkpoint-shm",
	"delete-product-wal",
	"delete-product-shm",
	"delete-product-database",
] as const;
type CoordinatedDatabaseResetDeleteStep = (typeof coordinatedDatabaseResetDeleteSteps)[number];
const coordinatedDatabaseResetSteps = [
	...coordinatedDatabaseResetDeleteSteps,
	"recreate-product-database",
	"recreate-checkpoint-database",
] as const;
type CoordinatedDatabaseResetStep = (typeof coordinatedDatabaseResetSteps)[number];
type CoordinatedDatabaseResetPhase = "prepared" | CoordinatedDatabaseResetStep | "complete";

export type CoordinatedDatabaseResetBoundary =
	| "create-marker"
	| "delete-checkpoint-database"
	| "delete-checkpoint-wal"
	| "delete-checkpoint-shm"
	| "delete-product-wal"
	| "delete-product-shm"
	| "delete-product-database"
	| "recreate-product-database"
	| "recreate-checkpoint-database"
	| "delete-marker";

export interface CoordinatedDatabaseResetOptions {
	beforeBoundary?(boundary: CoordinatedDatabaseResetBoundary): void;
	afterArtifactClaim?(boundary: CoordinatedDatabaseResetDeleteStep, claimPath: string): void;
	lockWaitTimeoutMs?: number;
}

export interface CoordinatedDatabaseResetResult {
	reset: boolean;
	reason?: typeof coordinatedDatabaseResetReason;
	previousProductVersion?: number;
}

export function prepareCoordinatedDatabaseReset(
	input: {
		productDatabase: string;
		checkpointDatabase: string;
	},
	options: CoordinatedDatabaseResetOptions = {},
): CoordinatedDatabaseResetResult {
	if (input.productDatabase.trim().length === 0 || input.checkpointDatabase.trim().length === 0) {
		throw new TypeError("Product and checkpoint database filenames are required.");
	}
	assertResetParentPathComponentsAreSafe(input.productDatabase);
	assertResetParentPathComponentsAreSafe(input.checkpointDatabase);
	const paths = createCoordinatedResetPaths(input);
	assertResetParentPathComponentsAreSafe(paths.productDatabase);
	assertResetParentPathComponentsAreSafe(paths.checkpointDatabase);
	const lock = acquireCoordinatedDatabaseResetLock(paths, options);
	try {
		return prepareCoordinatedDatabaseResetWithLock(paths, options, lock);
	} finally {
		lock.release();
	}
}

function prepareCoordinatedDatabaseResetWithLock(
	paths: CoordinatedResetPaths,
	options: CoordinatedDatabaseResetOptions,
	lock: CoordinatedDatabaseResetLock,
): CoordinatedDatabaseResetResult {
	lock.assertHeld();
	assertResetDatabasePathsAreSafe(paths);
	let marker = recoverCoordinatedResetMarker(paths);
	let previousProductVersion: number | undefined;

	if (marker === undefined) {
		const productExists = assertRegularResetFileOrMissing(paths.productDatabase);
		if (productExists) {
			previousProductVersion = inspectProductDatabaseVersion(paths.productDatabase);
			if (previousProductVersion === currentAppDatabaseVersion) {
				return { reset: false };
			}
			assertProductDatabaseVersionIsSupported(previousProductVersion);
		} else {
			const interruptedArtifacts = paths.databaseFiles
				.filter((path) => path !== paths.productDatabase)
				.map(assertRegularResetFileOrMissing);
			if (!interruptedArtifacts.some(Boolean)) {
				return { reset: false };
			}
		}
		const resetId = crypto.randomUUID();
		assertResetArtifactClaimsAreAbsent(paths, resetId);
		const artifacts = captureResetArtifactExpectations(paths);
		lock.assertHeld();
		marker = runResetBoundary(options, "create-marker", () => {
			lock.assertHeld();
			return createCoordinatedResetMarker(paths, previousProductVersion, artifacts, resetId);
		});
	} else {
		previousProductVersion = marker.previousProductVersion;
		if (marker.artifacts === undefined) {
			if (marker.phase !== "prepared") {
				throw coordinatedDatabaseResetFailure(
					new Error("A legacy coordinated reset marker cannot safely continue deletion."),
				);
			}
			const resetId = crypto.randomUUID();
			assertResetArtifactClaimsAreAbsent(paths, resetId);
			const artifacts = captureResetArtifactExpectations(paths);
			lock.assertHeld();
			marker = upgradeLegacyCoordinatedResetMarker(paths, marker, artifacts, resetId);
		}
		if (marker.resetId === undefined) {
			const resetId = crypto.randomUUID();
			assertResetArtifactClaimsAreAbsent(paths, resetId);
			lock.assertHeld();
			marker = addResetIdToCoordinatedResetMarker(paths, marker, resetId);
		}
	}
	if (marker === undefined) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker was not created."),
		);
	}

	const resetFiles: Record<CoordinatedDatabaseResetDeleteStep, string> = {
		"delete-checkpoint-database": paths.checkpointDatabase,
		"delete-checkpoint-wal": paths.checkpointWal,
		"delete-checkpoint-shm": paths.checkpointShm,
		"delete-product-wal": paths.productWal,
		"delete-product-shm": paths.productShm,
		"delete-product-database": paths.productDatabase,
	};
	assertResetArtifactsMatchMarkerPhase(paths, marker, resetFiles);
	const markerStepIndex =
		marker.phase === "prepared"
			? 0
			: marker.phase === "complete"
				? coordinatedDatabaseResetSteps.length
				: coordinatedDatabaseResetSteps.indexOf(marker.phase);
	for (let index = markerStepIndex; index < coordinatedDatabaseResetSteps.length; index += 1) {
		const boundary = coordinatedDatabaseResetSteps[index];
		if (boundary === undefined) {
			throw coordinatedDatabaseResetFailure(new Error("Invalid coordinated reset phase."));
		}
		lock.assertHeld();
		if (marker.phase !== boundary) {
			marker = advanceCoordinatedResetMarker(paths, marker, boundary);
		}
		const boundaryMarker = marker;
		lock.assertHeld();
		runResetBoundary(options, boundary, () => {
			lock.assertHeld();
			if (isCoordinatedResetDeleteStep(boundary)) {
				const expected = boundaryMarker.artifacts?.[boundary];
				if (expected === undefined) {
					throw new Error("The coordinated reset marker is missing an artifact identity.");
				}
				const claimPath = getResetArtifactClaimPath(paths, boundaryMarker, boundary);
				removeExpectedDatabaseFile(resetFiles[boundary], claimPath, expected, () =>
					options.afterArtifactClaim?.(boundary, claimPath),
				);
				return;
			}
			if (boundary === "recreate-product-database") {
				recreateProductDatabase(paths, boundaryMarker);
				return;
			}
			recreateCheckpointDatabase(paths, boundaryMarker);
		});
		lock.assertHeld();
	}
	lock.assertHeld();
	if (marker.phase !== "complete") {
		marker = advanceCoordinatedResetMarker(paths, marker, "complete");
	}
	lock.assertHeld();
	runResetBoundary(options, "delete-marker", () => {
		lock.assertHeld();
		removeCommittedResetMarker(paths, marker);
	});
	syncParentDirectory(paths.marker);

	return {
		reset: true,
		reason: coordinatedDatabaseResetReason,
		...(previousProductVersion === undefined ? {} : { previousProductVersion }),
	};
}

export function configureAppDatabase(client: Database): void {
	client.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
	`);
}

export function openAppDatabase(filename: string): AppDatabase {
	if (filename.trim().length === 0) {
		throw new TypeError("A database filename is required.");
	}

	const client = new Database(filename, { create: true, strict: true });

	try {
		configureAppDatabase(client);
		applyAppMigrations(client);
	} catch (error) {
		client.close();
		throw error;
	}

	const orm = drizzle(client, { schema: appSchema });

	return {
		client,
		orm,
		sessions: createSessionRepository({ orm }),
		runs: createRunJournalRepository({ client, orm }),
		close: () => client.close(),
	};
}

interface CoordinatedResetMarker {
	pathFingerprint: string;
	phase: CoordinatedDatabaseResetPhase;
	resetId?: string;
	previousProductVersion?: number;
	artifacts?: CoordinatedResetArtifactExpectations;
}

type CoordinatedResetArtifactIdentity =
	| { state: "absent" }
	| {
			state: "file";
			dev: string;
			ino: string;
			size: number;
			mtimeMs: number;
			ctimeMs: number;
			birthtimeMs: number;
			contentSha256: string;
	  };

type CoordinatedResetArtifactExpectations = Record<
	CoordinatedDatabaseResetDeleteStep,
	CoordinatedResetArtifactIdentity
>;

interface CoordinatedResetMarkerInspection {
	metadata: Stats;
	marker?: CoordinatedResetMarker;
}

interface CoordinatedDatabaseResetLock {
	assertHeld(): void;
	release(): void;
}

interface CoordinatedResetPaths {
	productDatabase: string;
	productWal: string;
	productShm: string;
	checkpointDatabase: string;
	checkpointWal: string;
	checkpointShm: string;
	marker: string;
	markerStaging: string;
	lock: string;
	lockJournal: string;
	lockWal: string;
	lockShm: string;
	pathFingerprint: string;
	databaseFiles: string[];
}

function createCoordinatedResetPaths(input: {
	productDatabase: string;
	checkpointDatabase: string;
}): CoordinatedResetPaths {
	const productDatabase = canonicalizeResetFilename(input.productDatabase);
	const checkpointDatabase = canonicalizeResetFilename(input.checkpointDatabase);
	const paths = {
		productDatabase,
		productWal: `${productDatabase}-wal`,
		productShm: `${productDatabase}-shm`,
		checkpointDatabase,
		checkpointWal: `${checkpointDatabase}-wal`,
		checkpointShm: `${checkpointDatabase}-shm`,
		marker: `${productDatabase}${coordinatedDatabaseResetMarkerSuffix}`,
		markerStaging: `${productDatabase}${coordinatedDatabaseResetMarkerSuffix}${coordinatedDatabaseResetMarkerStagingSuffix}`,
		lock: `${productDatabase}${coordinatedDatabaseResetLockSuffix}`,
		lockJournal: `${productDatabase}${coordinatedDatabaseResetLockSuffix}-journal`,
		lockWal: `${productDatabase}${coordinatedDatabaseResetLockSuffix}-wal`,
		lockShm: `${productDatabase}${coordinatedDatabaseResetLockSuffix}-shm`,
		pathFingerprint: createResetPathFingerprint(productDatabase, checkpointDatabase),
	};
	const allPaths = [
		paths.productDatabase,
		paths.productWal,
		paths.productShm,
		paths.checkpointDatabase,
		paths.checkpointWal,
		paths.checkpointShm,
		paths.marker,
		paths.markerStaging,
		paths.lock,
		paths.lockJournal,
		paths.lockWal,
		paths.lockShm,
	];
	if (new Set(allPaths.map((path) => resolve(path))).size !== allPaths.length) {
		throw new TypeError("Coordinated database reset paths must be distinct.");
	}
	return {
		...paths,
		databaseFiles: [
			paths.productDatabase,
			paths.productWal,
			paths.productShm,
			paths.checkpointDatabase,
			paths.checkpointWal,
			paths.checkpointShm,
		],
	};
}

function canonicalizeResetFilename(filename: string): string {
	const absolute = resolve(filename);
	return join(realpathSync(dirname(absolute)), basename(absolute));
}

function createResetPathFingerprint(productDatabase: string, checkpointDatabase: string): string {
	return createHash("sha256")
		.update(resolve(productDatabase))
		.update("\0")
		.update(resolve(checkpointDatabase))
		.digest("hex");
}

function acquireCoordinatedDatabaseResetLock(
	paths: CoordinatedResetPaths,
	options: CoordinatedDatabaseResetOptions,
): CoordinatedDatabaseResetLock {
	const waitTimeoutMs = requirePositiveSafeInteger(
		options.lockWaitTimeoutMs ?? coordinatedDatabaseResetLockWaitTimeoutMs,
		"lockWaitTimeoutMs",
	);
	assertTrustedResetDataDirectory(dirname(paths.lock));
	const beforeOpen = ensureCoordinatedResetLockDatabase(paths);
	let client: Database | undefined;
	let transactionHeld = false;
	try {
		client = new Database(paths.lock, { create: false, strict: true });
		client.exec(`
			PRAGMA busy_timeout = ${waitTimeoutMs};
			PRAGMA journal_mode = DELETE;
			PRAGMA synchronous = FULL;
			PRAGMA locking_mode = NORMAL;
			PRAGMA trusted_schema = OFF;
			CREATE TABLE IF NOT EXISTS coordinated_reset_lock (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				schema_version INTEGER NOT NULL,
				path_fingerprint TEXT NOT NULL,
				holder_token TEXT
			) STRICT;
		`);
		const journalMode = client
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get()?.journal_mode;
		const lockingMode = client
			.query<{ locking_mode: string }, []>("PRAGMA locking_mode")
			.get()?.locking_mode;
		if (journalMode !== "delete" || lockingMode !== "normal") {
			throw new Error("The coordinated reset lock database has unsafe locking settings.");
		}
		client
			.query(
				"INSERT OR IGNORE INTO coordinated_reset_lock (id, schema_version, path_fingerprint, holder_token) VALUES (1, ?, ?, NULL)",
			)
			.run(coordinatedDatabaseResetLockSchemaVersion, paths.pathFingerprint);
		const identity = client
			.query<{ schema_version: number; path_fingerprint: string }, []>(
				"SELECT schema_version, path_fingerprint FROM coordinated_reset_lock WHERE id = 1",
			)
			.get();
		if (
			identity?.schema_version !== coordinatedDatabaseResetLockSchemaVersion ||
			identity.path_fingerprint !== paths.pathFingerprint
		) {
			throw new Error("The coordinated reset lock database has an unexpected identity.");
		}
		client.exec("BEGIN EXCLUSIVE");
		transactionHeld = true;
		const holderToken = crypto.randomUUID();
		client
			.query("UPDATE coordinated_reset_lock SET holder_token = ? WHERE id = 1")
			.run(holderToken);
		const metadata = assertCoordinatedResetLockPath(paths, beforeOpen);
		let released = false;
		return {
			assertHeld() {
				if (released || client === undefined || !transactionHeld) {
					throw coordinatedDatabaseResetFailure(
						new Error("The coordinated reset lock is no longer held."),
					);
				}
				assertCoordinatedResetLockPath(paths, metadata);
				const held = client
					.query<{ holder_token: string | null }, []>(
						"SELECT holder_token FROM coordinated_reset_lock WHERE id = 1",
					)
					.get();
				if (held?.holder_token !== holderToken) {
					throw coordinatedDatabaseResetFailure(
						new Error("The coordinated reset lock transaction changed while held."),
					);
				}
			},
			release() {
				if (released) {
					return;
				}
				released = true;
				let releaseError: unknown;
				try {
					assertCoordinatedResetLockPath(paths, metadata);
				} catch (error) {
					releaseError = error;
				}
				try {
					if (transactionHeld && client !== undefined) {
						client.exec("ROLLBACK");
						transactionHeld = false;
					}
				} catch (error) {
					releaseError ??= error;
				}
				try {
					client?.close();
					client = undefined;
				} catch (error) {
					releaseError ??= error;
				}
				if (releaseError !== undefined) {
					throw coordinatedDatabaseResetFailure(releaseError);
				}
			},
		};
	} catch (error) {
		if (transactionHeld) {
			try {
				client?.exec("ROLLBACK");
			} catch {}
		}
		try {
			client?.close();
		} catch {}
		throw coordinatedDatabaseResetFailure(error);
	}
}

function assertOwnedIsolatedRegularResetFile(metadata: Stats, description: string): void {
	assertRegularResetFileMetadata(metadata);
	if (metadata.nlink !== 1) {
		throw coordinatedDatabaseResetFailure(
			new Error(`The coordinated ${description} has an unexpected file identity.`),
		);
	}
	const getuid = process.getuid;
	if (getuid !== undefined && metadata.uid !== getuid()) {
		throw coordinatedDatabaseResetFailure(
			new Error(`The coordinated ${description} has an unexpected owner.`),
		);
	}
	if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
		throw coordinatedDatabaseResetFailure(
			new Error(`The coordinated ${description} has unsafe permissions.`),
		);
	}
}

function ensureCoordinatedResetLockDatabase(paths: CoordinatedResetPaths): Stats {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(paths.lock, "wx", 0o600);
		if (process.platform !== "win32") {
			fchmodSync(descriptor, 0o600);
		}
		const metadata = fstatSync(descriptor);
		assertOwnedIsolatedRegularResetFile(metadata, "reset lock database");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		syncParentDirectory(paths.lock);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		if (!isExistingFileError(error)) {
			throw coordinatedDatabaseResetFailure(error);
		}
	}
	const metadata = getResetFileMetadata(paths.lock);
	if (metadata === undefined) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset lock database disappeared before it was opened."),
		);
	}
	assertOwnedIsolatedRegularResetFile(metadata, "reset lock database");
	assertSafeCoordinatedResetLockSidecars(paths);
	return metadata;
}

function assertCoordinatedResetLockPath(paths: CoordinatedResetPaths, expected: Stats): Stats {
	const current = getResetFileMetadata(paths.lock);
	if (current === undefined) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset lock database disappeared while held."),
		);
	}
	assertOwnedIsolatedRegularResetFile(current, "reset lock database");
	if (!sameStableFileIdentity(current, expected)) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset lock database changed while held."),
		);
	}
	assertSafeCoordinatedResetLockSidecars(paths);
	return current;
}

function assertSafeCoordinatedResetLockSidecars(paths: CoordinatedResetPaths): void {
	for (const filename of [paths.lockJournal, paths.lockWal, paths.lockShm]) {
		const metadata = getResetFileMetadata(filename);
		if (metadata !== undefined) {
			assertOwnedIsolatedRegularResetFile(metadata, "reset lock database sidecar");
		}
	}
}

function sameStableFileIdentity(left: Stats, right: Stats): boolean {
	if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) {
		return left.dev === right.dev && left.ino === right.ino;
	}
	return left.birthtimeMs > 0 && right.birthtimeMs > 0 && left.birthtimeMs === right.birthtimeMs;
}

function assertTrustedResetDataDirectory(directory: string): void {
	const metadata = getResetFileMetadata(directory);
	if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset data directory is unsafe."),
		);
	}
	const getuid = process.getuid;
	if (getuid !== undefined && metadata.uid !== getuid()) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset data directory has an unexpected owner."),
		);
	}
	if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset data directory is writable by another account."),
		);
	}
}

function requirePositiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer.`);
	}
	return value;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function inspectProductDatabaseVersion(filename: string): number {
	const inspector = new Database(filename, { readonly: true, strict: true });
	try {
		return getDatabaseUserVersion(inspector);
	} finally {
		inspector.close();
	}
}

function assertProductDatabaseVersionIsSupported(version: number): void {
	if (version > currentAppDatabaseVersion) {
		throw new Error(
			`Database user_version ${version} is newer than supported version ${currentAppDatabaseVersion}.`,
		);
	}
}

function assertResetDatabasePathsAreSafe(paths: CoordinatedResetPaths): void {
	assertResetParentPathComponentsAreSafe(paths.productDatabase);
	assertResetParentPathComponentsAreSafe(paths.checkpointDatabase);
	const fileIdentities = new Set<string>();
	for (const filename of paths.databaseFiles) {
		const metadata = getResetFileMetadata(filename);
		if (metadata === undefined) {
			continue;
		}
		assertRegularResetFileMetadata(metadata);
		if (metadata.ino !== 0) {
			const identity = `${metadata.dev}:${metadata.ino}`;
			if (fileIdentities.has(identity)) {
				throw coordinatedDatabaseResetFailure(
					new Error("Coordinated database reset paths refer to the same file."),
				);
			}
			fileIdentities.add(identity);
		}
	}
}

function assertResetParentPathComponentsAreSafe(filename: string): void {
	const parent = resolve(dirname(filename));
	const root = parse(parent).root;
	let current = root;
	for (const component of relative(root, parent).split(/[/\\]/u).filter(Boolean)) {
		current = join(current, component);
		const metadata = getResetFileMetadata(current);
		if (metadata === undefined) {
			throw coordinatedDatabaseResetFailure(
				new Error("A coordinated database reset parent path does not exist."),
			);
		}
		if (metadata.isSymbolicLink() && isAllowedDarwinSystemPathAlias(current)) {
			continue;
		}
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw coordinatedDatabaseResetFailure(
				new Error("A coordinated database reset parent path is unsafe."),
			);
		}
	}
}

function isAllowedDarwinSystemPathAlias(filename: string): boolean {
	if (process.platform !== "darwin" || filename !== "/var") {
		return false;
	}
	try {
		return resolve(realpathSync(filename)) === "/private/var";
	} catch {
		return false;
	}
}

function assertRegularResetFileOrMissing(filename: string): boolean {
	const metadata = getResetFileMetadata(filename);
	if (metadata === undefined) {
		return false;
	}
	assertRegularResetFileMetadata(metadata);
	return true;
}

function assertRegularResetFileMetadata(metadata: Stats): void {
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw coordinatedDatabaseResetFailure(
			new Error("A coordinated database reset path is not a regular file."),
		);
	}
}

function captureResetArtifactExpectations(
	paths: CoordinatedResetPaths,
): CoordinatedResetArtifactExpectations {
	return {
		"delete-checkpoint-database": captureResetArtifactIdentity(paths.checkpointDatabase),
		"delete-checkpoint-wal": captureResetArtifactIdentity(paths.checkpointWal),
		"delete-checkpoint-shm": captureResetArtifactIdentity(paths.checkpointShm),
		"delete-product-wal": captureResetArtifactIdentity(paths.productWal),
		"delete-product-shm": captureResetArtifactIdentity(paths.productShm),
		"delete-product-database": captureResetArtifactIdentity(paths.productDatabase),
	};
}

function assertResetArtifactClaimsAreAbsent(paths: CoordinatedResetPaths, resetId: string): void {
	for (const step of coordinatedDatabaseResetDeleteSteps) {
		const claimPath = getResetArtifactClaimPath(paths, { resetId }, step);
		if (getResetFileMetadata(claimPath) !== undefined) {
			throw coordinatedDatabaseResetFailure(
				new Error("A coordinated reset quarantine path already exists."),
			);
		}
	}
}

function getResetArtifactClaimPath(
	paths: CoordinatedResetPaths,
	marker: Pick<CoordinatedResetMarker, "resetId">,
	step: CoordinatedDatabaseResetDeleteStep,
): string {
	if (marker.resetId === undefined) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker is missing its reset identity."),
		);
	}
	const filename = getResetArtifactPath(paths, step);
	const stepIndex = coordinatedDatabaseResetDeleteSteps.indexOf(step);
	return join(dirname(filename), `.moshu-reset-claim-${marker.resetId}-${stepIndex}`);
}

function getResetArtifactPath(
	paths: CoordinatedResetPaths,
	step: CoordinatedDatabaseResetDeleteStep,
): string {
	switch (step) {
		case "delete-checkpoint-database":
			return paths.checkpointDatabase;
		case "delete-checkpoint-wal":
			return paths.checkpointWal;
		case "delete-checkpoint-shm":
			return paths.checkpointShm;
		case "delete-product-wal":
			return paths.productWal;
		case "delete-product-shm":
			return paths.productShm;
		case "delete-product-database":
			return paths.productDatabase;
	}
}

function captureResetArtifactIdentity(filename: string): CoordinatedResetArtifactIdentity {
	const metadata = getResetFileMetadata(filename);
	if (metadata === undefined) {
		return { state: "absent" };
	}
	assertRegularResetFileMetadata(metadata);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filename, "r");
		const opened = fstatSync(descriptor);
		assertRegularResetFileMetadata(opened);
		assertSameResetFileMetadata(metadata, opened);
		const contentHash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		while (position < opened.size) {
			const bytesRead = readSync(
				descriptor,
				buffer,
				0,
				Math.min(buffer.byteLength, opened.size - position),
				position,
			);
			if (bytesRead <= 0) {
				throw new Error("Failed to fingerprint a coordinated reset artifact.");
			}
			contentHash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		const afterRead = fstatSync(descriptor);
		assertSameResetFileMetadata(opened, afterRead);
		const current = getResetFileMetadata(filename);
		if (current === undefined) {
			throw new Error("A coordinated reset artifact disappeared while it was fingerprinted.");
		}
		assertSameResetFileMetadata(afterRead, current);
		return {
			state: "file",
			dev: String(opened.dev),
			ino: String(opened.ino),
			size: opened.size,
			mtimeMs: opened.mtimeMs,
			ctimeMs: opened.ctimeMs,
			birthtimeMs: opened.birthtimeMs,
			contentSha256: contentHash.digest("hex"),
		};
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
	}
}

function assertSameResetFileMetadata(left: Stats, right: Stats): void {
	if (
		left.dev !== right.dev ||
		left.ino !== right.ino ||
		left.size !== right.size ||
		left.mtimeMs !== right.mtimeMs ||
		left.ctimeMs !== right.ctimeMs ||
		left.birthtimeMs !== right.birthtimeMs
	) {
		throw new Error("A coordinated reset artifact changed while it was inspected.");
	}
}

function resetArtifactIdentitiesMatch(
	left: CoordinatedResetArtifactIdentity,
	right: CoordinatedResetArtifactIdentity,
): boolean {
	if (left.state !== right.state) {
		return false;
	}
	if (left.state === "absent" || right.state === "absent") {
		return true;
	}
	if (left.dev !== "0" && left.ino !== "0" && right.dev !== "0" && right.ino !== "0") {
		return (
			left.dev === right.dev &&
			left.ino === right.ino &&
			(left.birthtimeMs <= 0 || right.birthtimeMs <= 0 || left.birthtimeMs === right.birthtimeMs)
		);
	}
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.birthtimeMs === right.birthtimeMs &&
		left.contentSha256 === right.contentSha256
	);
}

function removeExpectedDatabaseFile(
	filename: string,
	claimPath: string,
	expected: CoordinatedResetArtifactIdentity,
	afterClaim: () => void,
): void {
	try {
		const currentMetadata = getResetFileMetadata(filename);
		const claimedMetadata = getResetFileMetadata(claimPath);
		if (expected.state === "absent") {
			if (currentMetadata === undefined && claimedMetadata === undefined) {
				return;
			}
			throw new Error("An absent coordinated reset artifact was recreated before deletion.");
		}
		if (claimedMetadata !== undefined) {
			if (currentMetadata !== undefined) {
				throw new Error(
					"A coordinated reset artifact was recreated while its prior inode was quarantined.",
				);
			}
			removeClaimedResetArtifact(claimPath, expected);
			return;
		}
		if (currentMetadata === undefined) {
			return;
		}
		assertRegularResetFileMetadata(currentMetadata);
		renameSync(filename, claimPath);
		syncParentDirectory(claimPath);
		afterClaim();
		if (getResetFileMetadata(filename) !== undefined) {
			throw new Error(
				"A coordinated reset artifact successor appeared after the prior inode was quarantined.",
			);
		}
		removeClaimedResetArtifact(claimPath, expected);
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	}
}

function removeClaimedResetArtifact(
	claimPath: string,
	expected: Extract<CoordinatedResetArtifactIdentity, { state: "file" }>,
): void {
	const claimed = captureResetArtifactIdentity(claimPath);
	if (!claimedResetArtifactIdentityMatches(claimed, expected)) {
		throw new Error(
			"A coordinated reset artifact did not match its expected identity after quarantine.",
		);
	}
	unlinkSync(claimPath);
	syncParentDirectory(claimPath);
}

function claimedResetArtifactIdentityMatches(
	claimed: CoordinatedResetArtifactIdentity,
	expected: Extract<CoordinatedResetArtifactIdentity, { state: "file" }>,
): boolean {
	if (claimed.state !== "file") {
		return false;
	}
	if (claimed.dev !== "0" && claimed.ino !== "0" && expected.dev !== "0" && expected.ino !== "0") {
		return resetArtifactIdentitiesMatch(claimed, expected);
	}
	return (
		claimed.size === expected.size &&
		claimed.mtimeMs === expected.mtimeMs &&
		(expected.birthtimeMs <= 0 ||
			claimed.birthtimeMs <= 0 ||
			claimed.birthtimeMs === expected.birthtimeMs) &&
		claimed.contentSha256 === expected.contentSha256
	);
}

function recreateProductDatabase(
	paths: CoordinatedResetPaths,
	marker: CoordinatedResetMarker,
): void {
	const expected = marker.artifacts?.["delete-product-database"];
	if (expected === undefined) {
		throw new Error("The coordinated reset marker is missing the product identity.");
	}
	assertPathIsAbsentOrRecreated(paths.productDatabase, expected);
	const database = openAppDatabase(paths.productDatabase);
	try {
		if (getDatabaseUserVersion(database.client) !== currentAppDatabaseVersion) {
			throw new Error("The recreated product database has an unexpected schema.");
		}
		const tableNames = database.client
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		if (
			tableNames.join(",") !==
			"chat_run_events,chat_runs,chat_session_create_requests,chat_sessions,checkpoint_deletion_outbox,retired_chat_sessions"
		) {
			throw new Error("The recreated product database has unexpected tables.");
		}
		const rowCount = database.client
			.query<{ count: number }, []>(`
				SELECT
					(SELECT count(*) FROM chat_run_events) +
					(SELECT count(*) FROM chat_runs) +
					(SELECT count(*) FROM chat_session_create_requests) +
					(SELECT count(*) FROM chat_sessions) +
					(SELECT count(*) FROM checkpoint_deletion_outbox) +
					(SELECT count(*) FROM retired_chat_sessions) AS count
			`)
			.get()?.count;
		if (rowCount !== 0) {
			throw new Error("The recreated product database is not empty.");
		}
	} finally {
		database.close();
	}
	syncRegularFile(paths.productDatabase);
	syncParentDirectory(paths.productDatabase);
}

function recreateCheckpointDatabase(
	paths: CoordinatedResetPaths,
	marker: CoordinatedResetMarker,
): void {
	const expected = marker.artifacts?.["delete-checkpoint-database"];
	if (expected === undefined) {
		throw new Error("The coordinated reset marker is missing the checkpoint identity.");
	}
	assertPathIsAbsentOrRecreated(paths.checkpointDatabase, expected);
	const checkpoint = new Database(paths.checkpointDatabase, { create: true, strict: true });
	try {
		const tableCount = checkpoint
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
			)
			.get()?.count;
		if (tableCount !== 0) {
			throw new Error("The recreated checkpoint database is not empty.");
		}
	} finally {
		checkpoint.close();
	}
	syncRegularFile(paths.checkpointDatabase);
	syncParentDirectory(paths.checkpointDatabase);
}

function assertPathIsAbsentOrRecreated(
	filename: string,
	deletedIdentity: CoordinatedResetArtifactIdentity,
): void {
	const current = getResetFileMetadata(filename);
	if (current === undefined) {
		return;
	}
	assertRegularResetFileMetadata(current);
	if (
		deletedIdentity.state === "file" &&
		resetArtifactIdentitiesMatch(captureResetArtifactIdentity(filename), deletedIdentity)
	) {
		throw coordinatedDatabaseResetFailure(
			new Error("A deleted coordinated reset artifact retained its original identity."),
		);
	}
}

function syncRegularFile(filename: string): void {
	const descriptor = openSync(filename, "r");
	try {
		const metadata = fstatSync(descriptor);
		assertRegularResetFileMetadata(metadata);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function recoverCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
): CoordinatedResetMarker | undefined {
	const committed = inspectCoordinatedResetMarker(paths.marker);
	if (committed !== undefined && committed.marker === undefined) {
		throw coordinatedDatabaseResetFailure(new Error("Invalid coordinated reset marker."));
	}
	let marker = committed?.marker;
	if (marker !== undefined) {
		assertResetMarkerMatchesPaths(marker, paths);
	}
	const staging = inspectCoordinatedResetMarker(paths.markerStaging, {
		allowInvalidPayload: true,
	});
	if (staging?.marker !== undefined) {
		assertResetMarkerMatchesPaths(staging.marker, paths);
	}
	const committedMetadata = committed?.metadata;
	if (committedMetadata !== undefined) {
		assertSafeCommittedMarkerLink(committedMetadata, staging?.metadata);
	}
	if (staging === undefined) {
		return marker;
	}
	try {
		assertSafeStagingMarkerLink(staging.metadata, committedMetadata);
		if (staging.marker === undefined) {
			removeInterruptedResetMarkerStaging(paths.markerStaging, staging.metadata);
			syncParentDirectory(paths.markerStaging);
			return marker;
		}
		if (marker === undefined) {
			linkSync(paths.markerStaging, paths.marker);
			syncParentDirectory(paths.marker);
			marker = staging.marker;
		} else if (
			!coordinatedResetMarkerContentsEqual(marker, staging.marker) ||
			(marker.phase !== staging.marker.phase &&
				getNextResetMarkerPhase(marker.phase) !== staging.marker.phase)
		) {
			throw new Error("Coordinated database reset marker files disagree.");
		}

		function coordinatedResetMarkerContentsEqual(
			left: CoordinatedResetMarker,
			right: CoordinatedResetMarker,
		): boolean {
			return coordinatedResetMarkersEqual(
				{ ...left, phase: "prepared" },
				{ ...right, phase: "prepared" },
			);
		}
		removeResetMarkerStaging(paths.markerStaging, staging.metadata);
		syncParentDirectory(paths.marker);
		return marker;
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	}
}

function createCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
	previousProductVersion: number | undefined,
	artifacts: CoordinatedResetArtifactExpectations,
	resetId: string,
): CoordinatedResetMarker {
	const marker: CoordinatedResetMarker = {
		pathFingerprint: paths.pathFingerprint,
		phase: "prepared",
		resetId,
		artifacts,
		...(previousProductVersion === undefined ? {} : { previousProductVersion }),
	};
	const payload = serializeCoordinatedResetMarker(marker);
	if (payload.byteLength > maxCoordinatedDatabaseResetMarkerBytes) {
		throw coordinatedDatabaseResetFailure(new Error("Coordinated reset marker is too large."));
	}
	let descriptor: number | undefined;
	let stagingMetadata: Stats | undefined;
	try {
		descriptor = openSync(paths.markerStaging, "wx", 0o600);
		stagingMetadata = fstatSync(descriptor);
		assertOwnedRegularResetMarker(stagingMetadata);
		let offset = 0;
		while (offset < payload.byteLength) {
			const written = writeSync(descriptor, payload, offset, payload.byteLength - offset, offset);
			if (written <= 0) {
				throw new Error("Failed to write the coordinated reset marker.");
			}
			offset += written;
		}
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		linkSync(paths.markerStaging, paths.marker);
		syncParentDirectory(paths.marker);
		removeResetMarkerStaging(paths.markerStaging, stagingMetadata ?? failResetMarkerMetadata());
		syncParentDirectory(paths.marker);
		return marker;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		if (getResetFileMetadata(paths.marker) === undefined) {
			try {
				if (stagingMetadata !== undefined) {
					removeInterruptedResetMarkerStaging(paths.markerStaging, stagingMetadata);
					syncParentDirectory(paths.markerStaging);
				}
			} catch {}
		}
		throw coordinatedDatabaseResetFailure(error);
	}
}

function upgradeLegacyCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
	current: CoordinatedResetMarker,
	artifacts: CoordinatedResetArtifactExpectations,
	resetId: string,
): CoordinatedResetMarker {
	const upgraded: CoordinatedResetMarker = { ...current, artifacts, resetId };
	return replaceCoordinatedResetMarker(paths, current, upgraded);
}

function addResetIdToCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
	current: CoordinatedResetMarker,
	resetId: string,
): CoordinatedResetMarker {
	const upgraded: CoordinatedResetMarker = { ...current, resetId };
	return replaceCoordinatedResetMarker(paths, current, upgraded);
}

function advanceCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
	current: CoordinatedResetMarker,
	phase: CoordinatedDatabaseResetPhase,
): CoordinatedResetMarker {
	if (getNextResetMarkerPhase(current.phase) !== phase) {
		throw coordinatedDatabaseResetFailure(new Error("Invalid coordinated reset phase transition."));
	}
	const next: CoordinatedResetMarker = { ...current, phase };
	return replaceCoordinatedResetMarker(paths, current, next);
}

function replaceCoordinatedResetMarker(
	paths: CoordinatedResetPaths,
	current: CoordinatedResetMarker,
	next: CoordinatedResetMarker,
): CoordinatedResetMarker {
	const payload = serializeCoordinatedResetMarker(next);
	if (payload.byteLength > maxCoordinatedDatabaseResetMarkerBytes) {
		throw coordinatedDatabaseResetFailure(new Error("Coordinated reset marker is too large."));
	}
	const committed = inspectCoordinatedResetMarker(paths.marker);
	if (committed?.marker === undefined || !coordinatedResetMarkersEqual(committed.marker, current)) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker changed during recovery."),
		);
	}
	assertSafeCommittedMarkerLink(committed.metadata, undefined);
	let descriptor: number | undefined;
	let stagingMetadata: Stats | undefined;
	try {
		descriptor = openSync(paths.markerStaging, "wx", 0o600);
		stagingMetadata = fstatSync(descriptor);
		assertOwnedRegularResetMarker(stagingMetadata);
		let offset = 0;
		while (offset < payload.byteLength) {
			const written = writeSync(descriptor, payload, offset, payload.byteLength - offset, offset);
			if (written <= 0) {
				throw new Error("Failed to write the coordinated reset marker.");
			}
			offset += written;
		}
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		const latestCommitted = getResetFileMetadata(paths.marker);
		if (
			latestCommitted === undefined ||
			latestCommitted.dev !== committed.metadata.dev ||
			latestCommitted.ino !== committed.metadata.ino
		) {
			throw new Error("The coordinated reset marker changed before its phase transition.");
		}
		assertOwnedRegularResetMarker(latestCommitted);
		renameSync(paths.markerStaging, paths.marker);
		syncParentDirectory(paths.marker);
		return next;
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
		try {
			if (stagingMetadata !== undefined) {
				removeInterruptedResetMarkerStaging(paths.markerStaging, stagingMetadata);
				syncParentDirectory(paths.markerStaging);
			}
		} catch {}
		throw coordinatedDatabaseResetFailure(error);
	}
}

function serializeCoordinatedResetMarker(marker: CoordinatedResetMarker): Buffer {
	return Buffer.from(
		`${JSON.stringify({
			schemaVersion: coordinatedDatabaseResetMarkerSchemaVersion,
			reason: coordinatedDatabaseResetReason,
			previousProductVersion: marker.previousProductVersion ?? null,
			pathFingerprint: marker.pathFingerprint,
			phase: marker.phase,
			resetId: marker.resetId,
			artifacts: marker.artifacts,
		})}\n`,
	);
}

function coordinatedResetMarkersEqual(
	left: CoordinatedResetMarker,
	right: CoordinatedResetMarker,
): boolean {
	return serializeCoordinatedResetMarker(left).equals(serializeCoordinatedResetMarker(right));
}

function getNextResetMarkerPhase(
	phase: CoordinatedDatabaseResetPhase,
): CoordinatedDatabaseResetPhase | undefined {
	if (phase === "complete") {
		return undefined;
	}
	if (phase === "prepared") {
		return coordinatedDatabaseResetSteps[0];
	}
	const index = coordinatedDatabaseResetSteps.indexOf(phase);
	return coordinatedDatabaseResetSteps[index + 1] ?? "complete";
}

function isCoordinatedResetDeleteStep(
	value: CoordinatedDatabaseResetStep,
): value is CoordinatedDatabaseResetDeleteStep {
	return (coordinatedDatabaseResetDeleteSteps as readonly string[]).includes(value);
}

function assertResetMarkerMatchesPaths(
	marker: CoordinatedResetMarker,
	paths: CoordinatedResetPaths,
): void {
	if (marker.pathFingerprint !== paths.pathFingerprint) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker does not match the configured database paths."),
		);
	}
}

function assertResetArtifactsMatchMarkerPhase(
	paths: CoordinatedResetPaths,
	marker: CoordinatedResetMarker,
	resetFiles: Record<CoordinatedDatabaseResetDeleteStep, string>,
): void {
	const actionIndex =
		marker.phase === "prepared"
			? 0
			: marker.phase === "complete"
				? coordinatedDatabaseResetSteps.length
				: coordinatedDatabaseResetSteps.indexOf(marker.phase);
	const productRecreationIndex = coordinatedDatabaseResetSteps.indexOf("recreate-product-database");
	const checkpointRecreationIndex = coordinatedDatabaseResetSteps.indexOf(
		"recreate-checkpoint-database",
	);
	for (let index = 0; index < coordinatedDatabaseResetDeleteSteps.length; index += 1) {
		const step = coordinatedDatabaseResetDeleteSteps[index];
		if (step === undefined) {
			continue;
		}
		const claimPath = getResetArtifactClaimPath(paths, marker, step);
		const claim = getResetFileMetadata(claimPath);
		if (claim !== undefined) {
			assertRegularResetFileMetadata(claim);
			const expected = marker.artifacts?.[step];
			if (
				index !== actionIndex ||
				marker.phase !== step ||
				expected?.state !== "file" ||
				getResetFileMetadata(resetFiles[step]) !== undefined
			) {
				throw coordinatedDatabaseResetFailure(
					new Error("A coordinated reset quarantine does not match the marker phase."),
				);
			}
		}
		if (index >= actionIndex) {
			continue;
		}
		const current = getResetFileMetadata(resetFiles[step]);
		if (current === undefined) {
			continue;
		}
		const recreationAllowed =
			((step === "delete-product-database" ||
				step === "delete-product-wal" ||
				step === "delete-product-shm") &&
				actionIndex >= productRecreationIndex) ||
			((step === "delete-checkpoint-database" ||
				step === "delete-checkpoint-wal" ||
				step === "delete-checkpoint-shm") &&
				actionIndex >= checkpointRecreationIndex);
		const expected = marker.artifacts?.[step];
		if (recreationAllowed && expected !== undefined) {
			assertRegularResetFileMetadata(current);
			if (!resetArtifactIdentitiesMatch(captureResetArtifactIdentity(resetFiles[step]), expected)) {
				continue;
			}
		}
		if (current !== undefined) {
			throw coordinatedDatabaseResetFailure(
				new Error("The coordinated reset marker phase does not match reset artifacts."),
			);
		}
	}
}

function inspectCoordinatedResetMarker(
	filename: string,
	options: { allowInvalidPayload?: boolean } = {},
): CoordinatedResetMarkerInspection | undefined {
	const metadata = getResetFileMetadata(filename);
	if (metadata === undefined) {
		return undefined;
	}
	assertOwnedRegularResetMarker(metadata);
	let descriptor: number | undefined;
	let raw: string;
	try {
		descriptor = openSync(filename, "r");
		const openedMetadata = fstatSync(descriptor);
		assertOwnedRegularResetMarker(openedMetadata);
		if (openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) {
			throw new Error("The coordinated reset marker changed while it was opened.");
		}
		if (openedMetadata.size > maxCoordinatedDatabaseResetMarkerBytes) {
			if (options.allowInvalidPayload) {
				return { metadata };
			}
			throw new Error("Invalid coordinated reset marker.");
		}
		raw = readFileSync(descriptor, "utf8");
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {}
		}
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const schemaVersion =
			typeof parsed === "object" && parsed !== null
				? Reflect.get(parsed, "schemaVersion")
				: undefined;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(schemaVersion !== coordinatedDatabaseResetMarkerSchemaVersion &&
				schemaVersion !== artifactCoordinatedDatabaseResetMarkerSchemaVersion &&
				schemaVersion !== legacyCoordinatedDatabaseResetMarkerSchemaVersion) ||
			Reflect.get(parsed, "reason") !== coordinatedDatabaseResetReason
		) {
			throw new Error("Invalid coordinated reset marker.");
		}
		const keys = Object.keys(parsed).sort();
		const expectedKeys =
			schemaVersion === coordinatedDatabaseResetMarkerSchemaVersion
				? [
						"artifacts",
						"pathFingerprint",
						"phase",
						"previousProductVersion",
						"reason",
						"resetId",
						"schemaVersion",
					]
				: schemaVersion === artifactCoordinatedDatabaseResetMarkerSchemaVersion
					? [
							"artifacts",
							"pathFingerprint",
							"phase",
							"previousProductVersion",
							"reason",
							"schemaVersion",
						]
					: ["pathFingerprint", "phase", "previousProductVersion", "reason", "schemaVersion"];
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key, index) => key !== expectedKeys[index])
		) {
			throw new Error("Invalid coordinated reset marker.");
		}
		const previousProductVersion = Reflect.get(parsed, "previousProductVersion");
		if (
			previousProductVersion !== null &&
			(!Number.isSafeInteger(previousProductVersion) ||
				(previousProductVersion as number) < 0 ||
				(previousProductVersion as number) >= currentAppDatabaseVersion)
		) {
			throw new Error("Invalid coordinated reset marker.");
		}
		const pathFingerprint = Reflect.get(parsed, "pathFingerprint");
		const phase = Reflect.get(parsed, "phase");
		const resetId =
			schemaVersion === coordinatedDatabaseResetMarkerSchemaVersion
				? Reflect.get(parsed, "resetId")
				: undefined;
		if (
			typeof pathFingerprint !== "string" ||
			!/^[0-9a-f]{64}$/u.test(pathFingerprint) ||
			!isCoordinatedResetMarkerPhase(phase) ||
			(resetId !== undefined && (typeof resetId !== "string" || !isUuid(resetId)))
		) {
			throw new Error("Invalid coordinated reset marker.");
		}
		const artifacts =
			schemaVersion === coordinatedDatabaseResetMarkerSchemaVersion ||
			schemaVersion === artifactCoordinatedDatabaseResetMarkerSchemaVersion
				? parseResetArtifactExpectations(Reflect.get(parsed, "artifacts"))
				: undefined;
		return {
			metadata,
			marker:
				previousProductVersion === null
					? {
							pathFingerprint,
							phase,
							...(resetId === undefined ? {} : { resetId }),
							...(artifacts === undefined ? {} : { artifacts }),
						}
					: {
							pathFingerprint,
							phase,
							previousProductVersion: previousProductVersion as number,
							...(resetId === undefined ? {} : { resetId }),
							...(artifacts === undefined ? {} : { artifacts }),
						},
		};
	} catch {
		return { metadata };
	}

	function parseResetArtifactExpectations(value: unknown): CoordinatedResetArtifactExpectations {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("Invalid coordinated reset artifact identities.");
		}
		const keys = Object.keys(value).sort();
		const expectedKeys = [...coordinatedDatabaseResetDeleteSteps].sort();
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key, index) => key !== expectedKeys[index])
		) {
			throw new Error("Invalid coordinated reset artifact identities.");
		}
		const parsed = {} as CoordinatedResetArtifactExpectations;
		for (const step of coordinatedDatabaseResetDeleteSteps) {
			const identity = Reflect.get(value, step);
			if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
				throw new Error("Invalid coordinated reset artifact identity.");
			}
			if (Reflect.get(identity, "state") === "absent") {
				if (Object.keys(identity).length !== 1) {
					throw new Error("Invalid coordinated reset absent artifact identity.");
				}
				parsed[step] = { state: "absent" };
				continue;
			}
			const identityKeys = Object.keys(identity).sort();
			const expectedIdentityKeys = [
				"birthtimeMs",
				"contentSha256",
				"ctimeMs",
				"dev",
				"ino",
				"mtimeMs",
				"size",
				"state",
			];
			const dev = Reflect.get(identity, "dev");
			const ino = Reflect.get(identity, "ino");
			const size = Reflect.get(identity, "size");
			const mtimeMs = Reflect.get(identity, "mtimeMs");
			const ctimeMs = Reflect.get(identity, "ctimeMs");
			const birthtimeMs = Reflect.get(identity, "birthtimeMs");
			const contentSha256 = Reflect.get(identity, "contentSha256");
			if (
				identityKeys.length !== expectedIdentityKeys.length ||
				identityKeys.some((key, index) => key !== expectedIdentityKeys[index]) ||
				Reflect.get(identity, "state") !== "file" ||
				typeof dev !== "string" ||
				!/^\d+$/u.test(dev) ||
				typeof ino !== "string" ||
				!/^\d+$/u.test(ino) ||
				typeof size !== "number" ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				typeof mtimeMs !== "number" ||
				!Number.isFinite(mtimeMs) ||
				typeof ctimeMs !== "number" ||
				!Number.isFinite(ctimeMs) ||
				typeof birthtimeMs !== "number" ||
				!Number.isFinite(birthtimeMs) ||
				typeof contentSha256 !== "string" ||
				!/^[0-9a-f]{64}$/u.test(contentSha256)
			) {
				throw new Error("Invalid coordinated reset file artifact identity.");
			}
			parsed[step] = {
				state: "file",
				dev,
				ino,
				size,
				mtimeMs,
				ctimeMs,
				birthtimeMs,
				contentSha256,
			};
		}
		return parsed;
	}
}

function isCoordinatedResetMarkerPhase(value: unknown): value is CoordinatedDatabaseResetPhase {
	return (
		value === "prepared" ||
		value === "complete" ||
		(typeof value === "string" &&
			(coordinatedDatabaseResetSteps as readonly string[]).includes(value))
	);
}

function assertOwnedRegularResetMarker(metadata: Stats): void {
	assertRegularResetFileMetadata(metadata);
	const getuid = process.getuid;
	if (getuid !== undefined && metadata.uid !== getuid()) {
		throw coordinatedDatabaseResetFailure(
			new Error("A coordinated database reset marker has an unexpected owner."),
		);
	}
}

function assertSafeCommittedMarkerLink(
	committedMetadata: Stats,
	stagingMetadata: Stats | undefined,
): void {
	if (committedMetadata.nlink === 1) {
		return;
	}
	if (
		stagingMetadata !== undefined &&
		committedMetadata.dev === stagingMetadata.dev &&
		committedMetadata.ino === stagingMetadata.ino &&
		committedMetadata.nlink === 2
	) {
		return;
	}
	throw coordinatedDatabaseResetFailure(
		new Error("The coordinated database reset marker has an unexpected file identity."),
	);
}

function assertSafeStagingMarkerLink(
	stagingMetadata: Stats,
	committedMetadata: Stats | undefined,
): void {
	if (stagingMetadata.nlink === 1) {
		return;
	}
	if (
		committedMetadata !== undefined &&
		stagingMetadata.dev === committedMetadata.dev &&
		stagingMetadata.ino === committedMetadata.ino &&
		stagingMetadata.nlink === 2
	) {
		return;
	}
	throw coordinatedDatabaseResetFailure(
		new Error("The coordinated database reset staging marker has an unexpected file identity."),
	);
}

function removeInterruptedResetMarkerStaging(filename: string, expected: Stats): void {
	if (expected.nlink !== 1) {
		throw coordinatedDatabaseResetFailure(
			new Error("The interrupted coordinated reset marker is not an isolated staging file."),
		);
	}
	removeResetMarkerStaging(filename, expected);
}

function removeResetMarkerStaging(filename: string, expected: Stats): void {
	const current = getResetFileMetadata(filename);
	if (current === undefined) {
		return;
	}
	assertOwnedRegularResetMarker(current);
	if (current.dev !== expected.dev || current.ino !== expected.ino) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset staging marker changed during recovery."),
		);
	}
	unlinkSync(filename);
}

function removeCommittedResetMarker(
	paths: CoordinatedResetPaths,
	expected: CoordinatedResetMarker,
): void {
	const committed = inspectCoordinatedResetMarker(paths.marker);
	if (
		committed?.marker === undefined ||
		!coordinatedResetMarkersEqual(committed.marker, expected)
	) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker changed before completion."),
		);
	}
	assertSafeCommittedMarkerLink(committed.metadata, undefined);
	const immediatelyBeforeUnlink = getResetFileMetadata(paths.marker);
	if (
		immediatelyBeforeUnlink === undefined ||
		immediatelyBeforeUnlink.dev !== committed.metadata.dev ||
		immediatelyBeforeUnlink.ino !== committed.metadata.ino
	) {
		throw coordinatedDatabaseResetFailure(
			new Error("The coordinated reset marker changed immediately before removal."),
		);
	}
	unlinkSync(paths.marker);
}

function failResetMarkerMetadata(): never {
	throw new Error("Coordinated reset marker metadata was not captured.");
}

function runResetBoundary<T>(
	options: CoordinatedDatabaseResetOptions,
	boundary: CoordinatedDatabaseResetBoundary,
	operation: () => T,
): T {
	try {
		options.beforeBoundary?.(boundary);
		return operation();
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	}
}

function syncParentDirectory(filename: string): void {
	try {
		syncDirectory(dirname(filename));
	} catch (error) {
		throw coordinatedDatabaseResetFailure(error);
	}
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") {
		return;
	}
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function getResetFileMetadata(filename: string): Stats | undefined {
	try {
		return lstatSync(filename);
	} catch (error) {
		if (isMissingFileError(error)) {
			return undefined;
		}
		throw coordinatedDatabaseResetFailure(error);
	}
}

function coordinatedDatabaseResetFailure(error: unknown): Error {
	if (error instanceof Error && error.message === coordinatedDatabaseResetFailureMessage) {
		return error;
	}
	return new Error(coordinatedDatabaseResetFailureMessage, { cause: error });
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		Reflect.get(error, "code") === "ENOENT"
	);
}

function isExistingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		Reflect.get(error, "code") === "EEXIST"
	);
}
