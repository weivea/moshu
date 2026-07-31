import {
	agentModeValues,
	approvalStateValues,
	chatRunEventSourceKindValues,
	chatRunEventVisibilityValues,
	chatRunStatusValues,
	projectPathIssueCodeValues,
	projectPathStatusValues,
} from "@moshu/contracts";
import { sql } from "drizzle-orm";
import {
	check,
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

export const agentServerMcpServersTable = sqliteTable("agent_server_mcp_servers", {
	id: text("id").primaryKey(),
	configRevision: integer("config_revision").notNull(),
	version: text("version").notNull(),
	contentHash: text("content_hash").notNull(),
	displayName: text("display_name").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	transportJson: text("transport_json").notNull(),
	secretLocator: text("secret_locator"),
	credentialConfigured: integer("credential_configured", { mode: "boolean" }).notNull(),
	health: text("health", { enum: ["ready", "stopped", "error"] }).notNull(),
	toolsJson: text("tools_json").notNull(),
	createdAtMs: integer("created_at_ms").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentServerMcpRetainedSecretsTable = sqliteTable("agent_server_mcp_retained_secrets", {
	id: text("id").primaryKey(),
	secretLocator: text("secret_locator").notNull(),
});

export const agentServerMcpPendingSecretDeletionsTable = sqliteTable(
	"agent_server_mcp_pending_secret_deletions",
	{
		secretLocator: text("secret_locator").primaryKey(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
);

export const agentServerMcpCommandResultsTable = sqliteTable(
	"agent_server_mcp_command_results",
	{
		commandId: text("command_id").primaryKey(),
		operation: text("operation").notNull(),
		requestDigest: text("request_digest").notNull(),
		resultJson: text("result_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
	(table) => [index("agent_server_mcp_command_results_created_idx").on(table.createdAtMs)],
);

export const agentServerSkillInstallationsTable = sqliteTable("agent_server_skill_installations", {
	id: text("id").primaryKey(),
	configRevision: integer("config_revision").notNull(),
	currentVersion: text("current_version").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	sourceKind: text("source_kind", {
		enum: ["inline-editor", "local-upload", "import"],
	}).notNull(),
	sourceLabel: text("source_label"),
	health: text("health", { enum: ["ready", "stopped", "error"] }).notNull(),
	lastErrorCode: text("last_error_code"),
	createdAtMs: integer("created_at_ms").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentServerSkillVersionsTable = sqliteTable(
	"agent_server_skill_versions",
	{
		skillId: text("skill_id").notNull(),
		version: text("version").notNull(),
		contentHash: text("content_hash").notNull(),
		metadataJson: text("metadata_json").notNull(),
		contentLocator: text("content_locator").notNull(),
		installedAtMs: integer("installed_at_ms").notNull(),
	},
	(table) => [primaryKey({ columns: [table.skillId, table.version] })],
);

export const agentServerSkillPendingContentDeletionsTable = sqliteTable(
	"agent_server_skill_pending_content_deletions",
	{
		contentLocator: text("content_locator").primaryKey(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
);

export const agentServerSkillCommandResultsTable = sqliteTable(
	"agent_server_skill_command_results",
	{
		commandId: text("command_id").primaryKey(),
		operation: text("operation").notNull(),
		requestDigest: text("request_digest").notNull(),
		resultJson: text("result_json").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
	},
	(table) => [index("agent_server_skill_command_results_created_idx").on(table.createdAtMs)],
);

export const agentGlobalProfilesTable = sqliteTable("agent_global_profiles", {
	agentId: text("agent_id").primaryKey(),
	revision: integer("revision").notNull(),
	serverMcpRefsJson: text("server_mcp_refs_json").notNull(),
	serverSkillRefsJson: text("server_skill_refs_json").notNull(),
	createdAtMs: integer("created_at_ms").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const appSettingsTable = sqliteTable("app_settings", {
	id: integer("id").primaryKey(),
	activeRuntimeBoxId: text("active_runtime_box_id")
		.notNull()
		.references(() => runtimeBoxesTable.id),
	activeRuntimeRevision: integer("active_runtime_revision").notNull(),
	actionJournalEpoch: text("action_journal_epoch").notNull(),
});

// Per-client active Runtime Box preference keyed by the authenticated client identity (the peer's
// `peerId`). `app_settings.active_runtime_box_id` remains the global default that seeds a client's
// first read; each client thereafter revisions its own selection independently. Session/Project/Run
// still persist their own `runtime_box_id`, so this table only records UI selection, not routing.
export const clientRuntimeBoxPreferencesTable = sqliteTable("client_runtime_box_preferences", {
	clientId: text("client_id").primaryKey(),
	runtimeBoxId: text("runtime_box_id")
		.notNull()
		.references(() => runtimeBoxesTable.id),
	revision: integer("revision").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const remoteAccessSettingsTable = sqliteTable("remote_access_settings", {
	id: integer("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull(),
	tunnelId: text("tunnel_id"),
	publicUrl: text("public_url"),
	runtimeIngressPort: integer("runtime_ingress_port"),
	mobileIngressPort: integer("mobile_ingress_port"),
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

// Layer 3 — Mobile ingress persistence. Deliberately separate from the Runtime Box tables so a
// Mobile device identity, its keys, its pairing sessions and its generation fence live and are
// revoked entirely independently of the Runtime Box surface.
export const mobileDevicesTable = sqliteTable("mobile_devices", {
	id: text("id").primaryKey(),
	displayName: text("display_name").notNull(),
	model: text("model").notNull(),
	platform: text("platform", { enum: ["ios", "ipados", "android"] }).notNull(),
	appVersion: text("app_version").notNull(),
	createdAtMs: integer("created_at_ms").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
	approvedAtMs: integer("approved_at_ms").notNull(),
	lastSeenAtMs: integer("last_seen_at_ms"),
	revokedAtMs: integer("revoked_at_ms"),
});

export const mobileDeviceKeysTable = sqliteTable(
	"mobile_device_keys",
	{
		keyId: text("key_id").notNull(),
		mobileClientId: text("mobile_client_id")
			.notNull()
			.references(() => mobileDevicesTable.id, { onDelete: "cascade" }),
		publicKey: text("public_key").notNull(),
		publicKeyFingerprint: text("public_key_fingerprint").notNull(),
		createdAtMs: integer("created_at_ms").notNull(),
		revokedAtMs: integer("revoked_at_ms"),
	},
	(table) => [
		primaryKey({ columns: [table.mobileClientId, table.keyId] }),
		index("mobile_device_keys_client_revoked_idx").on(table.mobileClientId, table.revokedAtMs),
	],
);

export const mobileDeviceGenerationFencesTable = sqliteTable("mobile_device_generation_fences", {
	mobileClientId: text("mobile_client_id")
		.primaryKey()
		.references(() => mobileDevicesTable.id, { onDelete: "cascade" }),
	acceptedGeneration: integer("accepted_generation").notNull(),
	acceptedInstanceId: text("accepted_instance_id").notNull(),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

export const mobilePairingSessionsTable = sqliteTable(
	"mobile_pairing_sessions",
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
		model: text("model"),
		platform: text("platform", { enum: ["ios", "ipados", "android"] }),
		appVersion: text("app_version"),
		mobileClientId: text("mobile_client_id").references(() => mobileDevicesTable.id),
		createdAtMs: integer("created_at_ms").notNull(),
		expiresAtMs: integer("expires_at_ms").notNull(),
		claimedAtMs: integer("claimed_at_ms"),
		decidedAtMs: integer("decided_at_ms"),
	},
	(table) => [
		uniqueIndex("mobile_pairing_sessions_code_hash_unique").on(table.codeHash),
		index("mobile_pairing_sessions_state_expiry_idx").on(table.state, table.expiresAtMs),
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
		pathRevision: integer("path_revision").notNull(),
		pathStatus: text("path_status", { enum: projectPathStatusValues }).notNull(),
		pathCheckedAtMs: integer("path_checked_at_ms"),
		pathIssueCode: text("path_issue_code", { enum: projectPathIssueCodeValues }),
		gitRootPath: text("git_root_path"),
		gitBranch: text("git_branch"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
		archivedAtMs: integer("archived_at_ms"),
		deletionRequestedAtMs: integer("deletion_requested_at_ms"),
	},
	(table) => [
		uniqueIndex("projects_runtime_path_unique").on(table.runtimeBoxId, table.path),
		index("projects_runtime_archived_created_idx").on(
			table.runtimeBoxId,
			table.archivedAtMs,
			table.createdAtMs,
		),
		check(
			"projects_path_health_check",
			sql`(${table.pathStatus} = 'unavailable' AND ${table.pathIssueCode} IS NOT NULL)
				OR (${table.pathStatus} <> 'unavailable' AND ${table.pathIssueCode} IS NULL)`,
		),
		check("projects_path_revision_positive_check", sql`${table.pathRevision} > 0`),
	],
);

export const projectDeletionJobsTable = sqliteTable(
	"project_deletion_jobs",
	{
		projectId: text("project_id")
			.primaryKey()
			.references(() => projectsTable.id, { onDelete: "cascade" }),
		state: text("state", { enum: ["pending", "processing", "blocked"] }).notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAtMs: integer("next_attempt_at_ms").notNull(),
		lastAttemptAtMs: integer("last_attempt_at_ms"),
		lastErrorCode: text("last_error_code"),
		createdAtMs: integer("created_at_ms").notNull(),
		updatedAtMs: integer("updated_at_ms").notNull(),
	},
	(table) => [index("project_deletion_jobs_next_attempt_idx").on(table.nextAttemptAtMs)],
);

export const chatSessionsTable = sqliteTable(
	"chat_sessions",
	{
		id: text("id").primaryKey(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
		projectId: text("project_id").references(() => projectsTable.id),
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
		index("chat_sessions_project_archived_activity_idx").on(
			table.projectId,
			table.archivedAtMs,
			table.lastMessageAtMs,
			table.updatedAtMs,
		),
	],
);

export const chatSessionCreateRequestsTable = sqliteTable(
	"chat_session_create_requests",
	{
		createKey: text("create_key").primaryKey(),
		runtimeBoxId: text("runtime_box_id")
			.notNull()
			.references(() => runtimeBoxesTable.id),
		projectId: text("project_id").references(() => projectsTable.id),
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
		projectId: text("project_id").references(() => projectsTable.id),
		projectPath: text("project_path"),
		projectPathRevision: integer("project_path_revision"),
		projectGitRootPath: text("project_git_root_path"),
		projectGitBranch: text("project_git_branch"),
		projectRootAgentsHash: text("project_root_agents_hash"),
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
		index("chat_runs_project_status_idx").on(table.projectId, table.status),
		check(
			"chat_runs_project_context_check",
			sql`(${table.projectId} IS NULL AND ${table.projectPath} IS NULL AND ${table.projectPathRevision} IS NULL
					AND ${table.projectGitRootPath} IS NULL AND ${table.projectGitBranch} IS NULL
					AND ${table.projectRootAgentsHash} IS NULL)
				OR (${table.projectId} IS NOT NULL AND ${table.projectPath} IS NOT NULL
					AND ${table.projectPathRevision} > 0)`,
		),
	],
);

export const actionIntentsTable = sqliteTable(
	"action_intents",
	{
		id: text("id").primaryKey(),
		invocationId: text("invocation_id").notNull(),
		targetKind: text("target_kind", { enum: ["agent-server", "runtime-box"] }).notNull(),
		targetId: text("target_id").notNull(),
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
		index("action_intents_target_state_idx").on(table.targetKind, table.targetId, table.state),
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

export const actionApprovalRequestsTable = sqliteTable(
	"action_approval_requests",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
		runId: text("run_id")
			.notNull()
			.references(() => chatRunsTable.id, { onDelete: "cascade" }),
		actionId: text("action_id").notNull(),
		toolCallId: text("tool_call_id").notNull(),
		tool: text("tool").notNull(),
		operation: text("operation").notNull(),
		actionSummaryJson: text("action_summary_json").notNull(),
		riskTier: text("risk_tier").notNull(),
		riskOverridable: integer("risk_overridable").notNull(),
		riskJson: text("risk_json").notNull(),
		state: text("state", { enum: approvalStateValues }).notNull(),
		revision: integer("revision").notNull(),
		decisionIdempotencyKey: text("decision_idempotency_key"),
		decisionJson: text("decision_json"),
		policyEvidenceJson: text("policy_evidence_json"),
		createdAtMs: integer("created_at_ms").notNull(),
		expiresAtMs: integer("expires_at_ms").notNull(),
		decidedAtMs: integer("decided_at_ms"),
	},
	(table) => [
		uniqueIndex("action_approval_requests_action_unique").on(table.actionId),
		uniqueIndex("action_approval_requests_idempotency_unique").on(table.decisionIdempotencyKey),
		index("action_approval_requests_session_state_idx").on(table.sessionId, table.state),
		index("action_approval_requests_state_expiry_idx").on(table.state, table.expiresAtMs),
	],
);

export const sessionApprovalPoliciesTable = sqliteTable("session_approval_policies", {
	sessionId: text("session_id")
		.primaryKey()
		.references(() => chatSessionsTable.id, { onDelete: "cascade" }),
	allowAll: integer("allow_all").notNull(),
	revision: integer("revision").notNull(),
	updatedByJson: text("updated_by_json"),
	lastIdempotencyKey: text("last_idempotency_key"),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

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
	agentGlobalProfilesTable,
	agentRuntimeProfilesTable,
	agentServerMcpCommandResultsTable,
	agentServerMcpPendingSecretDeletionsTable,
	agentServerMcpRetainedSecretsTable,
	agentServerMcpServersTable,
	agentServerSkillCommandResultsTable,
	agentServerSkillInstallationsTable,
	agentServerSkillPendingContentDeletionsTable,
	agentServerSkillVersionsTable,
	appSettingsTable,
	clientRuntimeBoxPreferencesTable,
	remoteAccessSettingsTable,
	projectsTable,
	projectDeletionJobsTable,
	agentSessionCleanupOutboxTable,
	chatRunEventsTable,
	chatRunsTable,
	actionIntentsTable,
	actionApprovalRequestsTable,
	sessionApprovalPoliciesTable,
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
	mobileDevicesTable,
	mobileDeviceKeysTable,
	mobileDeviceGenerationFencesTable,
	mobilePairingSessionsTable,
};
