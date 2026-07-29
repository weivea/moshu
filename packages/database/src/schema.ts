import {
	agentModeValues,
	chatRunEventSourceKindValues,
	chatRunEventVisibilityValues,
	chatRunStatusValues,
} from "@moshu/contracts";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const runtimeBoxesTable = sqliteTable(
	"runtime_boxes",
	{
		id: text("id").primaryKey(),
		kind: text("kind", { enum: ["local", "remote"] }).notNull(),
		displayName: text("display_name").notNull(),
		runtimeBoxVersion: text("runtime_box_version").notNull(),
		platform: text("platform", { enum: ["darwin", "win32", "linux"] }).notNull(),
		arch: text("arch").notNull(),
		capabilitiesJson: text("capabilities_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		lastSeenAtMs: integer("last_seen_at_ms"),
		archivedAtMs: integer("archived_at_ms"),
		compatibility: text("compatibility", { enum: ["upgrade_required"] }),
		compatibilityGeneration: integer("compatibility_generation"),
		compatibilityProtocolVersion: integer("compatibility_protocol_version"),
	},
	(table) => [
		index("runtime_boxes_kind_archived_idx").on(table.kind, table.archivedAtMs),
		index("runtime_boxes_last_seen_idx").on(table.lastSeenAtMs),
	],
);

export const runtimeBoxInventoryStateTable = sqliteTable("runtime_box_inventory_state", {
	runtimeBoxId: text("runtime_box_id")
		.primaryKey()
		.references(() => runtimeBoxesTable.id, { onDelete: "cascade" }),
	inventoryEpoch: text("inventory_epoch"),
	inventoryRevision: integer("inventory_revision"),
	runtimeBoxGeneration: integer("runtime_box_generation"),
	capabilitiesJson: text("capabilities_json").notNull(),
	stale: integer("stale", { mode: "boolean" }).notNull(),
	syncedAtMs: integer("synced_at_ms"),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const runtimeBoxInventoryCacheTable = sqliteTable(
	"runtime_box_inventory_cache",
	{
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id, { onDelete: "cascade" }),
		resourceKind: text("resource_kind", { enum: ["mcp", "skill"] }).notNull(),
		stableResourceId: text("stable_resource_id").notNull(),
		version: text("version").notNull(),
		contentHash: text("content_hash").notNull(),
		descriptorJson: text("descriptor_json").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.runtimeBoxId, table.resourceKind, table.stableResourceId] }),
		index("runtime_box_inventory_cache_box_kind_idx").on(table.runtimeBoxId, table.resourceKind),
	],
);

export const agentRuntimeProfilesTable = sqliteTable(
	"agent_runtime_profiles",
	{
		agentId: text("agent_id").notNull(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		resourcesJson: text("resources_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
	},
	(table) => [primaryKey({ columns: [table.agentId, table.runtimeBoxId] })],
);

export const appSettingsTable = sqliteTable("app_settings", {
	id: integer("id").primaryKey(),
	activeRuntimeBoxId: text("active_runtime_box_id")
		.notNull()
		.references(() => runtimeBoxesTable.id),
	activeRuntimeRevision: integer("active_runtime_revision").notNull(),
	actionJournalEpoch: text("action_journal_epoch").notNull(),
});

export const remoteAccessSettingsTable = sqliteTable("remote_access_settings", {
	id: integer("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	tunnelId: text("tunnel_id"),
	publicUrl: text("public_url"),
	runtimeIngressPort: integer("runtime_ingress_port"),
	trafficMonth: text("traffic_month").notNull(),
	trafficReceivedBytes: integer("traffic_received_bytes").notNull(),
	trafficSentBytes: integer("traffic_sent_bytes").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const runtimeBoxGenerationFencesTable = sqliteTable("runtime_box_generation_fences", {
	runtimeBoxId: text("runtime_box_id")
		.primaryKey()
		.references(() => runtimeBoxesTable.id, { onDelete: "cascade" }),
	acceptedGeneration: integer("accepted_generation").notNull(),
	acceptedInstanceId: text("accepted_instance_id").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const runtimeBoxDeviceKeysTable = sqliteTable(
	"runtime_box_device_keys",
	{
		keyId: text("key_id").notNull(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id, { onDelete: "cascade" }),
		publicKey: text("public_key").notNull(),
		publicKeyFingerprint: text("public_key_fingerprint").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		revokedAtMs: integer("revoked_at_ms"),
	},
	(table) => [
		primaryKey({ columns: [table.runtimeBoxId, table.keyId] }),
		index("runtime_box_device_keys_box_revoked_idx").on(table.runtimeBoxId, table.revokedAtMs),
	],
);

export const runtimeBoxPairingSessionsTable = sqliteTable(
	"runtime_box_pairing_sessions",
	{
		id: text("id").primaryKey(),
		codeHash: text("code_hash").notNull(),
		claimTokenHash: text("claim_token_hash"),
		state: text("state", {
			enum: ["open", "claimed", "approved", "rejected"],
		}).notNull(),
		deviceKeyId: text("device_key_id"),
		publicKey: text("public_key"),
		publicKeyFingerprint: text("public_key_fingerprint"),
		displayName: text("display_name"),
		platform: text("platform", { enum: ["darwin", "win32", "linux"] }),
		arch: text("arch"),
		runtimeBoxId: text("runtime_box_id").references(() => runtimeBoxesTable.id),
		createdAtMs: integer("created_at_ms").notNull(),
		expiresAtMs: integer("expires_at_ms").notNull(),
		claimedAtMs: integer("claimed_at_ms"),
		decidedAtMs: integer("decided_at_ms"),
	},
	(table) => [
		uniqueIndex("runtime_box_pairing_sessions_code_hash_unique").on(table.codeHash),
		index("runtime_box_pairing_sessions_state_expiry_idx").on(table.state, table.expiresAtMs),
	],
);

export const projectsTable = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
		name: text("name").notNull(),
		path: text("path").notNull(),
		gitRootPath: text("git_root_path"),
		gitBranch: text("git_branch"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		archivedAtMs: integer("archived_at_ms"),
	},
	(table) => [
		uniqueIndex("projects_runtime_path_unique").on(table.runtimeBoxId, table.path),
		index("projects_runtime_archived_updated_idx").on(
			table.runtimeBoxId,
			table.archivedAtMs,
			table.updatedAtMs,
		),
	],
);

export const chatSessionsTable = sqliteTable(
	"chat_sessions",
	{
		id: text("id").primaryKey(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
		title: text("title").notNull(),
		defaultMode: text("default_mode", { enum: agentModeValues }).notNull(),
		providerId: text("provider_id"),
		modelId: text("model_id"),
		thinkingLevel: text("thinking_level"),
		piSessionId: text("pi_session_id").notNull(),
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
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
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
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
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

export const actionIntentsTable = sqliteTable(
	"action_intents",
	{
		id: text("id").primaryKey(),
		invocationId: text("invocation_id").notNull(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
		runId: text("run_id")
			.notNull()
			.references(() => chatRunsTable.id, { onDelete: "cascade" }),
		toolCallId: text("tool_call_id").notNull(),
		tool: text("tool").notNull(),
		parameterDigest: text("parameter_digest").notNull(),
		riskClass: text("risk_class").notNull(),
		sideEffectClass: text("side_effect_class").notNull(),
		idempotencyClass: text("idempotency_class").notNull(),
		policyRule: text("policy_rule").notNull(),
		originInstanceId: text("origin_instance_id").notNull(),
		originGeneration: integer("origin_generation").notNull(),
		targetInstanceId: text("target_instance_id").notNull(),
		targetGeneration: integer("target_generation").notNull(),
		executionScope: text("execution_scope").notNull(),
		state: text("state", {
			enum: ["granted", "running", "succeeded", "failed", "cancelled", "outcome_unknown"],
		}).notNull(),
		resultJson: text("result_json"),
		resultHash: text("result_hash"),
		safeError: text("safe_error"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		completedAtMs: integer("completed_at_ms"),
		serverAckedAtMs: integer("server_acked_at_ms"),
		boxReceiptConfirmedAtMs: integer("box_receipt_confirmed_at_ms"),
	},
	(table) => [
		uniqueIndex("action_intents_invocation_unique").on(table.invocationId),
		index("action_intents_runtime_state_idx").on(table.runtimeBoxId, table.state),
		index("action_intents_run_idx").on(table.runId),
	],
);

export const executionGrantsTable = sqliteTable(
	"execution_grants",
	{
		id: text("id").primaryKey(),
		actionId: text("action_id")
			.notNull()
			.references(() => actionIntentsTable.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		parameterDigest: text("parameter_digest").notNull(),
		expiresAtMs: integer("expires_at_ms").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		consumedAtMs: integer("consumed_at_ms"),
	},
	(table) => [
		uniqueIndex("execution_grants_action_unique").on(table.actionId),
		index("execution_grants_expiry_idx").on(table.expiresAtMs),
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

export const agentSessionCleanupOutboxTable = sqliteTable(
	"agent_session_cleanup_outbox",
	{
		sessionId: text("session_id").primaryKey(),
		createdAtMs: integer("created_at_ms").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAtMs: integer("next_attempt_at_ms").notNull(),
		lastAttemptAtMs: integer("last_attempt_at_ms"),
		lastError: text("last_error"),
	},
	(table) => [index("agent_session_cleanup_outbox_next_attempt_idx").on(table.nextAttemptAtMs)],
);

export const appSchema = {
	agentRuntimeProfilesTable,
	appSettingsTable,
	remoteAccessSettingsTable,
	projectsTable,
	agentSessionCleanupOutboxTable,
	chatRunEventsTable,
	chatRunsTable,
	actionIntentsTable,
	executionGrantsTable,
	chatSessionCreateRequestsTable,
	chatSessionsTable,
	retiredChatSessionsTable,
	runtimeBoxGenerationFencesTable,
	runtimeBoxInventoryCacheTable,
	runtimeBoxInventoryStateTable,
	runtimeBoxDeviceKeysTable,
	runtimeBoxPairingSessionsTable,
	runtimeBoxesTable,
};
