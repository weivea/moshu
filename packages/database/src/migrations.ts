import type Database from "bun:sqlite";

const CURRENT_USER_VERSION = 1;

function readUserVersion(client: Database): number {
	const row = client.query<{ user_version: number }, []>("PRAGMA user_version").get();

	return row?.user_version ?? 0;
}

export function getDatabaseUserVersion(client: Database): number {
	return readUserVersion(client);
}

export function applyAppMigrations(client: Database): void {
	const currentUserVersion = readUserVersion(client);

	if (currentUserVersion > CURRENT_USER_VERSION) {
		throw new Error(
			`Database user_version ${currentUserVersion} is newer than supported version ${CURRENT_USER_VERSION}.`,
		);
	}

	if (currentUserVersion === CURRENT_USER_VERSION) {
		return;
	}

	client.exec("BEGIN IMMEDIATE");

	try {
		client.exec(`
			CREATE TABLE IF NOT EXISTS chat_sessions (
				id TEXT PRIMARY KEY NOT NULL,
				title TEXT NOT NULL,
				default_mode TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_message_at_ms INTEGER
			);

			CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx
				ON chat_sessions(updated_at_ms);
			CREATE INDEX IF NOT EXISTS chat_sessions_last_message_at_idx
				ON chat_sessions(last_message_at_ms);

			CREATE TABLE IF NOT EXISTS chat_runs (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
				mode TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_json TEXT NOT NULL,
				user_message_id TEXT UNIQUE,
				assistant_message_id TEXT UNIQUE,
				last_error_json TEXT,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				completed_at_ms INTEGER
			);

			CREATE INDEX IF NOT EXISTS chat_runs_session_created_at_idx
				ON chat_runs(session_id, created_at_ms);

			CREATE TABLE IF NOT EXISTS chat_messages (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
				run_id TEXT REFERENCES chat_runs(id) ON DELETE CASCADE,
				role TEXT NOT NULL,
				status TEXT NOT NULL,
				content_json TEXT NOT NULL,
				error_json TEXT,
				sequence INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_session_sequence_unique
				ON chat_messages(session_id, sequence);
			CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_run_role_unique
				ON chat_messages(run_id, role);
			CREATE INDEX IF NOT EXISTS chat_messages_session_sequence_idx
				ON chat_messages(session_id, sequence);
			CREATE INDEX IF NOT EXISTS chat_messages_run_idx
				ON chat_messages(run_id);

			CREATE TABLE IF NOT EXISTS chat_run_events (
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
		`);

		client.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
		client.exec("COMMIT");
	} catch (error) {
		client.exec("ROLLBACK");
		throw error;
	}
}
