import type Database from "bun:sqlite";

export const currentAppDatabaseVersion = 8;

export class AppDatabaseResetRequiredError extends Error {
	readonly currentVersion: number;
	readonly supportedVersion = currentAppDatabaseVersion;

	constructor(currentVersion: number) {
		super(
			`Database user_version ${currentVersion} requires a coordinated reset to version ${currentAppDatabaseVersion}.`,
		);
		this.name = "AppDatabaseResetRequiredError";
		this.currentVersion = currentVersion;
	}
}

function readUserVersion(client: Database): number {
	const row = client.query<{ user_version: number }, []>("PRAGMA user_version").get();

	return row?.user_version ?? 0;
}

export function getDatabaseUserVersion(client: Database): number {
	return readUserVersion(client);
}

export function applyAppMigrations(client: Database): void {
	const currentUserVersion = readUserVersion(client);

	if (currentUserVersion > currentAppDatabaseVersion) {
		throw new Error(
			`Database user_version ${currentUserVersion} is newer than supported version ${currentAppDatabaseVersion}.`,
		);
	}

	if (currentUserVersion === currentAppDatabaseVersion) {
		return;
	}

	if (currentUserVersion !== 0) {
		throw new AppDatabaseResetRequiredError(currentUserVersion);
	}
	const existingTable = client
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
		)
		.get();
	if (existingTable !== null) {
		throw new AppDatabaseResetRequiredError(currentUserVersion);
	}

	client.exec("BEGIN IMMEDIATE");

	try {
		client.exec(`
			DROP TABLE IF EXISTS checkpoint_deletion_outbox;
			DROP TABLE IF EXISTS chat_run_events;
			DROP TABLE IF EXISTS chat_runs;
			DROP TABLE IF EXISTS chat_session_create_requests;
			DROP TABLE IF EXISTS chat_sessions;
			DROP TABLE IF EXISTS retired_chat_runs;
			DROP TABLE IF EXISTS retired_chat_sessions;

			CREATE TABLE chat_sessions (
				id TEXT PRIMARY KEY NOT NULL,
				title TEXT NOT NULL,
				default_mode TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_message_at_ms INTEGER,
				archived_at_ms INTEGER
			);

			CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx
				ON chat_sessions(updated_at_ms);
			CREATE INDEX IF NOT EXISTS chat_sessions_last_message_at_idx
				ON chat_sessions(last_message_at_ms);
			CREATE INDEX IF NOT EXISTS chat_sessions_archived_updated_at_idx
				ON chat_sessions(archived_at_ms, updated_at_ms);

			CREATE TABLE chat_session_create_requests (
				create_key TEXT PRIMARY KEY NOT NULL,
				origin_role TEXT NOT NULL,
				origin_peer_id TEXT NOT NULL,
				origin_instance_id TEXT NOT NULL,
				origin_generation INTEGER NOT NULL,
				title TEXT NOT NULL,
				default_mode TEXT NOT NULL,
				session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
				created_at_ms INTEGER NOT NULL
			);
			CREATE INDEX chat_session_create_requests_created_at_idx
				ON chat_session_create_requests(created_at_ms);

			CREATE TABLE chat_runs (
				id TEXT PRIMARY KEY NOT NULL,
				client_request_id TEXT NOT NULL UNIQUE,
				session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_json TEXT NOT NULL,
				user_message_id TEXT NOT NULL UNIQUE,
				user_content TEXT NOT NULL,
				assistant_message_id TEXT NOT NULL UNIQUE,
				assistant_content TEXT,
				last_error_json TEXT,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				completed_at_ms INTEGER
			);

			CREATE INDEX IF NOT EXISTS chat_runs_session_created_at_idx
				ON chat_runs(session_id, created_at_ms);
			CREATE INDEX IF NOT EXISTS chat_runs_session_cursor_idx
				ON chat_runs(session_id, created_at_ms, id);

			CREATE TABLE chat_run_events (
				id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
				seq INTEGER NOT NULL,
				type TEXT NOT NULL,
				source_kind TEXT NOT NULL,
				source_id TEXT,
				visibility TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS chat_run_events_run_seq_unique
				ON chat_run_events(run_id, seq);
			CREATE INDEX IF NOT EXISTS chat_run_events_run_seq_idx
				ON chat_run_events(run_id, seq);
			CREATE INDEX IF NOT EXISTS chat_run_events_session_created_at_idx
				ON chat_run_events(session_id, created_at_ms);

			CREATE TABLE retired_chat_sessions (
				session_id TEXT PRIMARY KEY NOT NULL,
				retired_at_ms INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS retired_chat_sessions_retired_at_idx
				ON retired_chat_sessions(retired_at_ms);

			CREATE TABLE checkpoint_deletion_outbox (
				session_id TEXT PRIMARY KEY NOT NULL,
				created_at_ms INTEGER NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL,
				last_attempt_at_ms INTEGER,
				last_error TEXT
			);
			CREATE INDEX checkpoint_deletion_outbox_next_attempt_idx
				ON checkpoint_deletion_outbox(next_attempt_at_ms);
		`);

		client.exec(`PRAGMA user_version = ${currentAppDatabaseVersion}`);
		client.exec("COMMIT");
	} catch (error) {
		client.exec("ROLLBACK");
		throw error;
	}
}
