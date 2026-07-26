import {
	agentModeValues,
	chatRunEventSourceKindValues,
	chatRunEventVisibilityValues,
	chatRunStatusValues,
} from "@moshu/contracts";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const chatSessionsTable = sqliteTable(
	"chat_sessions",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		defaultMode: text("default_mode", { enum: agentModeValues }).notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		lastMessageAtMs: integer("last_message_at_ms"),
		archivedAtMs: integer("archived_at_ms"),
	},
	(table) => [
		index("chat_sessions_updated_at_idx").on(table.updatedAtMs),
		index("chat_sessions_last_message_at_idx").on(table.lastMessageAtMs),
		index("chat_sessions_archived_updated_at_idx").on(table.archivedAtMs, table.updatedAtMs),
	],
);

export const chatSessionCreateRequestsTable = sqliteTable(
	"chat_session_create_requests",
	{
		createKey: text("create_key").primaryKey(),
		originRole: text("origin_role").notNull(),
		originPeerId: text("origin_peer_id").notNull(),
		originInstanceId: text("origin_instance_id").notNull(),
		originGeneration: integer("origin_generation").notNull(),
		title: text("title").notNull(),
		defaultMode: text("default_mode", { enum: agentModeValues }).notNull(),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		createdAtMs: integer("created_at_ms").notNull(),
	},
	(table) => [
		uniqueIndex("chat_session_create_requests_session_unique").on(table.sessionId),
		index("chat_session_create_requests_created_at_idx").on(table.createdAtMs),
	],
);

export const chatRunsTable = sqliteTable(
	"chat_runs",
	{
		id: text("id").primaryKey(),
		clientRequestId: text("client_request_id").notNull(),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		mode: text("mode", { enum: agentModeValues }).notNull(),
		status: text("status", { enum: chatRunStatusValues }).notNull(),
		providerJson: text("provider_json").notNull(),
		userMessageId: text("user_message_id").notNull(),
		userContent: text("user_content").notNull(),
		assistantMessageId: text("assistant_message_id").notNull(),
		assistantContent: text("assistant_content"),
		lastErrorJson: text("last_error_json"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		completedAtMs: integer("completed_at_ms"),
	},
	(table) => [
		index("chat_runs_session_created_at_idx").on(table.sessionId, table.createdAtMs),
		index("chat_runs_session_cursor_idx").on(table.sessionId, table.createdAtMs, table.id),
		uniqueIndex("chat_runs_user_message_unique").on(table.userMessageId),
		uniqueIndex("chat_runs_assistant_message_unique").on(table.assistantMessageId),
		uniqueIndex("chat_runs_client_request_unique").on(table.clientRequestId),
	],
);

export const chatRunEventsTable = sqliteTable(
	"chat_run_events",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => chatRunsTable.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		type: text("type").notNull(),
		sourceKind: text("source_kind", {
			enum: chatRunEventSourceKindValues,
		}).notNull(),
		sourceId: text("source_id"),
		visibility: text("visibility", {
			enum: chatRunEventVisibilityValues,
		}).notNull(),
		payloadJson: text("payload_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
	(table) => [
		uniqueIndex("chat_run_events_run_seq_unique").on(table.runId, table.seq),
		index("chat_run_events_run_seq_idx").on(table.runId, table.seq),
		index("chat_run_events_session_created_at_idx").on(table.sessionId, table.createdAtMs),
	],
);

export const retiredChatSessionsTable = sqliteTable(
	"retired_chat_sessions",
	{
		sessionId: text("session_id").primaryKey(),
		retiredAtMs: integer("retired_at_ms").notNull(),
	},
	(table) => [index("retired_chat_sessions_retired_at_idx").on(table.retiredAtMs)],
);

export const checkpointDeletionOutboxTable = sqliteTable(
	"checkpoint_deletion_outbox",
	{
		sessionId: text("session_id").primaryKey(),
		createdAtMs: integer("created_at_ms").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAtMs: integer("next_attempt_at_ms").notNull(),
		lastAttemptAtMs: integer("last_attempt_at_ms"),
		lastError: text("last_error"),
	},
	(table) => [index("checkpoint_deletion_outbox_next_attempt_idx").on(table.nextAttemptAtMs)],
);

export const appSchema = {
	checkpointDeletionOutboxTable,
	chatRunEventsTable,
	chatRunsTable,
	chatSessionCreateRequestsTable,
	chatSessionsTable,
	retiredChatSessionsTable,
};
