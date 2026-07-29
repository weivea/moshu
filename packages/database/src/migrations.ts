import type Database from "bun:sqlite";

export const currentAppDatabaseVersion = 18;

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
			DROP TABLE IF EXISTS agent_session_cleanup_outbox;
			DROP TABLE IF EXISTS agent_runtime_profiles;
			DROP TABLE IF EXISTS runtime_box_inventory_cache;
			DROP TABLE IF EXISTS runtime_box_inventory_state;
			DROP TABLE IF EXISTS execution_grants;
			DROP TABLE IF EXISTS action_intents;
			DROP TABLE IF EXISTS chat_run_events;
			DROP TABLE IF EXISTS chat_runs;
			DROP TABLE IF EXISTS chat_session_create_requests;
			DROP TABLE IF EXISTS chat_sessions;
			DROP TABLE IF EXISTS retired_chat_runs;
			DROP TABLE IF EXISTS retired_chat_sessions;
			DROP TABLE IF EXISTS runtime_box_generation_fences;
			DROP TABLE IF EXISTS runtime_box_device_keys;
			DROP TABLE IF EXISTS runtime_box_pairing_sessions;
			DROP TABLE IF EXISTS projects;
			DROP TABLE IF EXISTS app_settings;
			DROP TABLE IF EXISTS remote_access_settings;
			DROP TABLE IF EXISTS runtime_boxes;

			CREATE TABLE runtime_boxes (
				id TEXT PRIMARY KEY NOT NULL,
				kind TEXT NOT NULL,
				display_name TEXT NOT NULL,
				runtime_box_version TEXT NOT NULL,
				platform TEXT NOT NULL,
				arch TEXT NOT NULL,
				capabilities_json TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_seen_at_ms INTEGER,
				archived_at_ms INTEGER,
				compatibility TEXT,
				compatibility_generation INTEGER,
				compatibility_protocol_version INTEGER
			);
			CREATE INDEX runtime_boxes_kind_archived_idx
				ON runtime_boxes(kind, archived_at_ms);
			CREATE INDEX runtime_boxes_last_seen_idx
				ON runtime_boxes(last_seen_at_ms);

			CREATE TABLE runtime_box_inventory_state (
				runtime_box_id TEXT PRIMARY KEY NOT NULL
					REFERENCES runtime_boxes(id) ON DELETE CASCADE,
				inventory_epoch TEXT,
				inventory_revision INTEGER,
				runtime_box_generation INTEGER,
				capabilities_json TEXT NOT NULL,
				stale INTEGER NOT NULL,
				synced_at_ms INTEGER,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE TABLE runtime_box_inventory_cache (
				runtime_box_id TEXT NOT NULL
					REFERENCES runtime_boxes(id) ON DELETE CASCADE,
				resource_kind TEXT NOT NULL,
				stable_resource_id TEXT NOT NULL,
				version TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				descriptor_json TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY (runtime_box_id, resource_kind, stable_resource_id)
			);
			CREATE INDEX runtime_box_inventory_cache_box_kind_idx
				ON runtime_box_inventory_cache(runtime_box_id, resource_kind);

			CREATE TABLE agent_runtime_profiles (
				agent_id TEXT NOT NULL,
				runtime_box_id TEXT NOT NULL
					REFERENCES runtime_boxes(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				resources_json TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY (agent_id, runtime_box_id)
			);

			CREATE TABLE app_settings (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				active_runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
				active_runtime_revision INTEGER NOT NULL,
				action_journal_epoch TEXT NOT NULL
			);

			CREATE TABLE remote_access_settings (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				enabled INTEGER NOT NULL,
				tunnel_id TEXT,
				public_url TEXT,
				runtime_ingress_port INTEGER,
				traffic_month TEXT NOT NULL,
				traffic_received_bytes INTEGER NOT NULL,
				traffic_sent_bytes INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE TABLE runtime_box_generation_fences (
				runtime_box_id TEXT PRIMARY KEY NOT NULL
					REFERENCES runtime_boxes(id) ON DELETE CASCADE,
				accepted_generation INTEGER NOT NULL,
				accepted_instance_id TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE TABLE runtime_box_device_keys (
				key_id TEXT NOT NULL,
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id) ON DELETE CASCADE,
				public_key TEXT NOT NULL,
				public_key_fingerprint TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				revoked_at_ms INTEGER,
				PRIMARY KEY (runtime_box_id, key_id)
			);
			CREATE INDEX runtime_box_device_keys_box_revoked_idx
				ON runtime_box_device_keys(runtime_box_id, revoked_at_ms);

			CREATE TABLE runtime_box_pairing_sessions (
				id TEXT PRIMARY KEY NOT NULL,
				code_hash TEXT NOT NULL UNIQUE,
				claim_token_hash TEXT,
				state TEXT NOT NULL,
				device_key_id TEXT,
				public_key TEXT,
				public_key_fingerprint TEXT,
				display_name TEXT,
				platform TEXT,
				arch TEXT,
				runtime_box_id TEXT REFERENCES runtime_boxes(id),
				created_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				claimed_at_ms INTEGER,
				decided_at_ms INTEGER
			);
			CREATE INDEX runtime_box_pairing_sessions_state_expiry_idx
				ON runtime_box_pairing_sessions(state, expires_at_ms);

			CREATE TABLE projects (
				id TEXT PRIMARY KEY NOT NULL,
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
				name TEXT NOT NULL,
				path TEXT NOT NULL,
				git_root_path TEXT,
				git_branch TEXT,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				archived_at_ms INTEGER,
				UNIQUE (runtime_box_id, path)
			);
			CREATE INDEX projects_runtime_archived_updated_idx
				ON projects(runtime_box_id, archived_at_ms, updated_at_ms);

			CREATE TABLE chat_sessions (
				id TEXT PRIMARY KEY NOT NULL,
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
				title TEXT NOT NULL,
				default_mode TEXT NOT NULL,
				provider_id TEXT,
				model_id TEXT,
				thinking_level TEXT,
				pi_session_id TEXT NOT NULL,
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
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
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
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
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

			CREATE TABLE action_intents (
				id TEXT PRIMARY KEY NOT NULL,
				invocation_id TEXT NOT NULL UNIQUE,
				runtime_box_id TEXT NOT NULL REFERENCES runtime_boxes(id),
				run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
				tool_call_id TEXT NOT NULL,
				tool TEXT NOT NULL,
				parameter_digest TEXT NOT NULL,
				risk_class TEXT NOT NULL,
				side_effect_class TEXT NOT NULL,
				idempotency_class TEXT NOT NULL,
				policy_rule TEXT NOT NULL,
				origin_instance_id TEXT NOT NULL,
				origin_generation INTEGER NOT NULL,
				target_instance_id TEXT NOT NULL,
				target_generation INTEGER NOT NULL,
				execution_scope TEXT NOT NULL,
				state TEXT NOT NULL,
				result_json TEXT,
				result_hash TEXT,
				safe_error TEXT,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				completed_at_ms INTEGER,
				server_acked_at_ms INTEGER,
				box_receipt_confirmed_at_ms INTEGER
			);
			CREATE INDEX action_intents_runtime_state_idx
				ON action_intents(runtime_box_id, state);
			CREATE INDEX action_intents_run_idx
				ON action_intents(run_id);

			CREATE TABLE execution_grants (
				id TEXT PRIMARY KEY NOT NULL,
				action_id TEXT NOT NULL UNIQUE REFERENCES action_intents(id) ON DELETE CASCADE,
				token_hash TEXT NOT NULL,
				parameter_digest TEXT NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				consumed_at_ms INTEGER
			);
			CREATE INDEX execution_grants_expiry_idx ON execution_grants(expires_at_ms);

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

			CREATE TABLE agent_session_cleanup_outbox (
				session_id TEXT PRIMARY KEY NOT NULL,
				created_at_ms INTEGER NOT NULL,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL,
				last_attempt_at_ms INTEGER,
				last_error TEXT
			);
			CREATE INDEX agent_session_cleanup_outbox_next_attempt_idx
				ON agent_session_cleanup_outbox(next_attempt_at_ms);
		`);

		client.exec(`PRAGMA user_version = ${currentAppDatabaseVersion}`);
		client.exec("COMMIT");
	} catch (error) {
		client.exec("ROLLBACK");
		throw error;
	}
}
