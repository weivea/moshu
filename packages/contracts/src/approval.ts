import { z } from "zod";
import { isoDateTimeSchema, toolCallIdSchema, uuidV7Schema } from "./contract-primitives";

// ---------------------------------------------------------------------------
// Durable Tool/Action approval domain contracts.
//
// These schemas are the versioned, client-neutral wire contract shared by the
// Agent Server, the Desktop client, and (in a later layer) a Mobile client. The
// server is the sole authority for risk classification and state transitions;
// nothing here is ever computed from Runtime Box or model self-reports.
// ---------------------------------------------------------------------------

export const actionRiskTierValues = ["low", "medium", "high", "critical"] as const;
export const actionRiskTierSchema = z.enum(actionRiskTierValues);
export type ActionRiskTier = z.infer<typeof actionRiskTierSchema>;

export const approvalStateValues = [
	"pending",
	"approved",
	"rejected",
	"expired",
	"cancelled",
] as const;
export const approvalStateSchema = z.enum(approvalStateValues);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

// A client only ever asks for one of these two decisions. "Allow all for this
// Session" is a policy toggle (see sessionApprovalPolicy) applied by the server
// when a request is created, not a per-request decision.
export const approvalDecisionKindValues = ["approve_once", "reject"] as const;
export const approvalDecisionKindSchema = z.enum(approvalDecisionKindValues);
export type ApprovalDecisionKind = z.infer<typeof approvalDecisionKindSchema>;

export const decisionSourceKindValues = ["client", "policy", "system"] as const;
export const decisionSourceKindSchema = z.enum(decisionSourceKindValues);

export const actionTargetKindValues = ["runtime-box", "agent-server"] as const;
export const actionTargetKindSchema = z.enum(actionTargetKindValues);

export const approvalOperationValues = [
	"read",
	"search",
	"list",
	"edit",
	"write",
	"bash",
	"mcp",
	"other",
] as const;
export const approvalOperationSchema = z.enum(approvalOperationValues);
export type ApprovalOperation = z.infer<typeof approvalOperationSchema>;

export const decisionSourceSchema = z
	.object({
		kind: decisionSourceKindSchema,
		clientId: z.string().min(1).max(256).optional(),
		clientRole: z.string().min(1).max(64).optional(),
	})
	.strict();
export type DecisionSource = z.infer<typeof decisionSourceSchema>;

export const actionRiskSchema = z
	.object({
		tier: actionRiskTierSchema,
		// Server-authoritative flag: overridable actions can be auto-approved by a
		// Session "Allow all" policy. Non-overridable (critical) actions always
		// require an explicit per-action decision and are never bypassed.
		overridable: z.boolean(),
		reasons: z.array(z.string().min(1).max(256)).max(16),
	})
	.strict();
export type ActionRisk = z.infer<typeof actionRiskSchema>;

export const actionTargetSchema = z
	.object({
		kind: actionTargetKindSchema,
		id: z.string().min(1).max(256),
	})
	.strict();

// Server-normalized, redacted description of what the Action will do. The
// Agent Server produces every field here from validated tool parameters; raw
// unredacted command environments and secrets are never included.
export const approvalActionSummarySchema = z
	.object({
		tool: z.string().min(1).max(256),
		operation: approvalOperationSchema,
		target: actionTargetSchema,
		command: z.string().max(4_096).optional(),
		path: z.string().max(4_096).optional(),
		mcpServerId: z.string().min(1).max(256).optional(),
		mcpToolId: z.string().min(1).max(256).optional(),
		redactedParams: z.record(z.string().min(1).max(128), z.json()),
	})
	.strict();
export type ApprovalActionSummary = z.infer<typeof approvalActionSummarySchema>;

export const approvalDecisionSchema = z
	.object({
		kind: approvalDecisionKindSchema,
		source: decisionSourceSchema,
		decidedAt: isoDateTimeSchema,
	})
	.strict();
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalPolicyEvidenceSchema = z
	.object({
		allowAllRevision: z.number().int().nonnegative(),
	})
	.strict();

export const approvalRequestSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().uuid(),
		sessionId: uuidV7Schema,
		runId: uuidV7Schema,
		actionId: z.string().uuid(),
		toolCallId: toolCallIdSchema,
		action: approvalActionSummarySchema,
		risk: actionRiskSchema,
		state: approvalStateSchema,
		// Monotonic optimistic-concurrency token. Every state transition bumps it;
		// clients pass the revision they observed as `expectedRevision` when deciding.
		revision: z.number().int().min(1),
		createdAt: isoDateTimeSchema,
		expiresAt: isoDateTimeSchema,
		decidedAt: isoDateTimeSchema.optional(),
		decision: approvalDecisionSchema.optional(),
		policyEvidence: approvalPolicyEvidenceSchema.optional(),
	})
	.strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const sessionApprovalPolicySchema = z
	.object({
		schemaVersion: z.literal(1),
		sessionId: uuidV7Schema,
		allowAll: z.boolean(),
		// Starts at 0 for the implicit default (allowAll=false); each update bumps it.
		revision: z.number().int().nonnegative(),
		updatedAt: isoDateTimeSchema,
		updatedBy: decisionSourceSchema.optional(),
	})
	.strict();
export type SessionApprovalPolicy = z.infer<typeof sessionApprovalPolicySchema>;

// --- Product RPC input/output --------------------------------------------

export const listApprovalsInputSchema = z
	.object({
		sessionId: uuidV7Schema.optional(),
		states: z.array(approvalStateSchema).min(1).max(approvalStateValues.length).optional(),
		limit: z.number().int().min(1).max(200).optional(),
	})
	.strict();
export type ListApprovalsInput = z.infer<typeof listApprovalsInputSchema>;

export const listApprovalsOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		items: z.array(approvalRequestSchema).max(200),
		policies: z.array(sessionApprovalPolicySchema).max(200),
	})
	.strict();
export type ListApprovalsOutput = z.infer<typeof listApprovalsOutputSchema>;

export const getApprovalInputSchema = z
	.object({
		approvalId: z.string().uuid(),
	})
	.strict();
export type GetApprovalInput = z.infer<typeof getApprovalInputSchema>;

export const getApprovalOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		request: approvalRequestSchema,
		policy: sessionApprovalPolicySchema,
	})
	.strict();
export type GetApprovalOutput = z.infer<typeof getApprovalOutputSchema>;

export const decideApprovalInputSchema = z
	.object({
		approvalId: z.string().uuid(),
		expectedRevision: z.number().int().min(1),
		decision: approvalDecisionKindSchema,
		idempotencyKey: z.string().uuid(),
	})
	.strict();
export type DecideApprovalInput = z.infer<typeof decideApprovalInputSchema>;

export const decideApprovalOutcomeValues = ["applied", "idempotent", "superseded"] as const;
export const decideApprovalOutcomeSchema = z.enum(decideApprovalOutcomeValues);

export const decideApprovalOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		// "applied": this decision won. "idempotent": same key retried, returns the
		// prior result. "superseded": another client already decided; the returned
		// request is the authoritative final state (no duplicate side effect).
		outcome: decideApprovalOutcomeSchema,
		request: approvalRequestSchema,
	})
	.strict();
export type DecideApprovalOutput = z.infer<typeof decideApprovalOutputSchema>;

export const getSessionApprovalPolicyInputSchema = z
	.object({
		sessionId: uuidV7Schema,
	})
	.strict();
export type GetSessionApprovalPolicyInput = z.infer<typeof getSessionApprovalPolicyInputSchema>;

export const getSessionApprovalPolicyOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		policy: sessionApprovalPolicySchema,
	})
	.strict();
export type GetSessionApprovalPolicyOutput = z.infer<typeof getSessionApprovalPolicyOutputSchema>;

export const updateSessionApprovalPolicyInputSchema = z
	.object({
		sessionId: uuidV7Schema,
		allowAll: z.boolean(),
		expectedRevision: z.number().int().nonnegative(),
		idempotencyKey: z.string().uuid(),
		approveRequest: z
			.object({
				approvalId: z.string().uuid(),
				expectedRevision: z.number().int().min(1),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (!value.allowAll && value.approveRequest !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["approveRequest"],
				message: "A current approval can only be approved while enabling Allow all.",
			});
		}
	});
export type UpdateSessionApprovalPolicyInput = z.infer<
	typeof updateSessionApprovalPolicyInputSchema
>;

export const updateSessionApprovalPolicyOutputSchema = z
	.object({
		schemaVersion: z.literal(1),
		policy: sessionApprovalPolicySchema,
		request: approvalRequestSchema.optional(),
	})
	.strict();
export type UpdateSessionApprovalPolicyOutput = z.infer<
	typeof updateSessionApprovalPolicyOutputSchema
>;

// --- Product RPC events ---------------------------------------------------

export const approvalEventKindValues = ["created", "updated"] as const;
export const approvalEventKindSchema = z.enum(approvalEventKindValues);

export const approvalEventDeliverySchema = z
	.object({
		schemaVersion: z.literal(1),
		kind: approvalEventKindSchema,
		request: approvalRequestSchema,
	})
	.strict();
export type ApprovalEventDelivery = z.infer<typeof approvalEventDeliverySchema>;

export const sessionApprovalPolicyEventSchema = z
	.object({
		schemaVersion: z.literal(1),
		policy: sessionApprovalPolicySchema,
	})
	.strict();
export type SessionApprovalPolicyEvent = z.infer<typeof sessionApprovalPolicyEventSchema>;

// A no-payload hint broadcast to every authenticated client so a cross-session
// "pending approvals" activity panel can refresh its snapshot. It carries no
// session-scoped or secret content; the snapshot itself comes from approvals.list.
export const approvalActivityChangedEventSchema = z
	.object({
		schemaVersion: z.literal(1),
	})
	.strict();
export type ApprovalActivityChangedEvent = z.infer<typeof approvalActivityChangedEventSchema>;

// Stable RPC error codes so clients can render conflict/expiry/cancellation UX.
export const approvalRpcErrorCodes = {
	notFound: "APPROVAL_NOT_FOUND",
	revisionConflict: "APPROVAL_REVISION_CONFLICT",
	alreadyDecided: "APPROVAL_ALREADY_DECIDED",
	policyRevisionConflict: "SESSION_APPROVAL_POLICY_REVISION_CONFLICT",
} as const;
