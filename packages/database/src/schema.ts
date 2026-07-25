import { agentModeValues, chatMessageRoleValues, chatMessageStatusValues } from "@moshu/contracts";
import {
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

export const chatRunsTable = sqliteTable(
	"chat_runs",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		mode: text("mode", { enum: agentModeValues }).notNull(),
		status: text("status", { enum: chatRunStatusValues }).notNull(),
		providerJson: text("provider_json").notNull(),
		userMessageId: text("user_message_id"),
		assistantMessageId: text("assistant_message_id"),
		lastErrorJson: text("last_error_json"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		completedAtMs: integer("completed_at_ms"),
	},
	(table) => [
		index("chat_runs_session_created_at_idx").on(table.sessionId, table.createdAtMs),
		uniqueIndex("chat_runs_user_message_unique").on(table.userMessageId),
		uniqueIndex("chat_runs_assistant_message_unique").on(table.assistantMessageId),
	],
);

export const chatMessagesTable = sqliteTable(
	"chat_messages",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		runId: text("run_id").references(() => chatRunsTable.id, { onDelete: "cascade" }),
		role: text("role", { enum: chatMessageRoleValues }).notNull(),
		status: text("status", { enum: chatMessageStatusValues }).notNull(),
		contentJson: text("content_json").notNull(),
		errorJson: text("error_json"),
		sequence: integer("sequence").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
	},
	(table) => [
		uniqueIndex("chat_messages_session_sequence_unique").on(table.sessionId, table.sequence),
		uniqueIndex("chat_messages_run_role_unique").on(table.runId, table.role),
		index("chat_messages_session_sequence_idx").on(table.sessionId, table.sequence),
		index("chat_messages_run_idx").on(table.runId),
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
		sourceKind: text("source_kind", { enum: chatRunEventSourceKindValues }).notNull(),
		sourceId: text("source_id"),
		visibility: text("visibility", { enum: chatRunEventVisibilityValues }).notNull(),
		payloadJson: text("payload_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
	(table) => [
		uniqueIndex("chat_run_events_run_seq_unique").on(table.runId, table.seq),
		index("chat_run_events_run_seq_idx").on(table.runId, table.seq),
		index("chat_run_events_session_created_at_idx").on(table.sessionId, table.createdAtMs),
	],
);

export const appSchema = {
	chatMessagesTable,
	chatRunEventsTable,
	chatRunsTable,
	chatSessionsTable,
};
