import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	classifyExecutorAction,
	classifyMcpAction,
	DefaultActionPolicy,
	getExecutorToolMetadata,
} from "@moshu/action-broker";
import {
	type ActionRisk,
	type ApprovalActionSummary,
	createExecutorToolParameterPayload,
	createMcpToolParameterPayload,
	type ExecutorExecutionContext,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ProcessPeerIdentity,
	type ReconcileRuntimeBoxInvocationsOutput,
	type RuntimeBoxActionResult,
	type RuntimeBoxInvocationEvidence,
	type RuntimeBoxMcpToolInvokeInput,
	type RuntimeBoxMcpToolInvokeOutput,
	type RuntimeBoxToolAuthorization,
	reconcileRuntimeBoxInvocationsOutputSchema,
	runtimeBoxMcpToolInvokeInputSchema,
	runtimeBoxToolInvokeInputSchema,
} from "@moshu/contracts";
import type { ActionRepository, RunJournalRepository } from "@moshu/database";
import type { RpcPeerIdentity } from "@moshu/process-rpc";
import type { ActionApprovalGate, ApprovalGateRequest } from "./approval-service";
import type { RuntimeBoxActionAuthorizer } from "./runtime-box-registry";

const executionGrantLifetimeMs = 60_000;

export class ActionPolicyDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionPolicyDeniedError";
	}
}

export class DurableActionAuthorizationService implements RuntimeBoxActionAuthorizer {
	readonly #policy: DefaultActionPolicy;
	readonly #allowMcpTools: boolean;
	readonly #approvalGate: ActionApprovalGate | undefined;

	constructor(
		private readonly actions: ActionRepository,
		private readonly runs: Pick<RunJournalRepository, "get">,
		private readonly authority: ProcessPeerIdentity,
		options: { allowSideEffects: boolean; approvalGate?: ActionApprovalGate } = {
			allowSideEffects: true,
		},
	) {
		this.#policy = new DefaultActionPolicy(options.allowSideEffects);
		this.#allowMcpTools = options.allowSideEffects;
		this.#approvalGate = options.approvalGate;
	}

	async authorize(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		executionContext: ExecutorExecutionContext,
		options: { signal?: AbortSignal } = {},
	): Promise<ExecutorToolInvokeInput> {
		if (input.authorization !== undefined) {
			throw new ActionPolicyDeniedError("Tool invocation authorization is Server-owned.");
		}
		if (targetIdentity.role !== "runtime-box" || targetIdentity.peerId !== runtimeBoxId) {
			throw new ActionPolicyDeniedError("Execution grant target identity is invalid.");
		}
		const metadata = getExecutorToolMetadata(input.call.tool);
		const decision = this.#policy.evaluateTool(input.call.tool);
		if (decision.outcome !== "allow") {
			throw new ActionPolicyDeniedError(
				decision.outcome === "deny" ? decision.reason : "Action approval is required.",
			);
		}
		const actionId = randomUUID();
		const grantId = randomUUID();
		const grantToken = randomBytes(32).toString("base64url");
		const authoritativeContext = this.#resolveExecutionContext(
			runtimeBoxId,
			input,
			executionContext,
		);
		// User-level Action approval gate: server-authoritative risk is computed here
		// from the validated Tool call, and no execution grant is issued or consumed
		// until the Action is approved (interactively or by a Session Allow-all policy).
		if (this.#approvalGate !== undefined) {
			const classification = classifyExecutorAction(input.call);
			if (classification.requiresApproval) {
				await this.#requireApproval(
					input,
					actionId,
					{
						tool: input.call.tool,
						operation: classification.operation,
						target: { kind: "runtime-box", id: runtimeBoxId },
						...(classification.summary.command === undefined
							? {}
							: { command: classification.summary.command }),
						...(classification.summary.path === undefined
							? {}
							: { path: classification.summary.path }),
						redactedParams: classification.summary.redactedParams,
					},
					classification.risk,
					options.signal,
				);
			}
		}
		const parameterDigest = sha256(createExecutorToolParameterPayload(input, authoritativeContext));
		const expiresAtMs = Date.now() + executionGrantLifetimeMs;
		const authorization: RuntimeBoxToolAuthorization = {
			actionId,
			grantId,
			grantToken,
			parameterDigest,
			originInstanceId: this.authority.instanceId,
			originGeneration: this.authority.generation,
			targetRuntimeBoxId: runtimeBoxId,
			targetInstanceId: targetIdentity.instanceId,
			targetGeneration: targetIdentity.generation,
			...authoritativeContext,
			expiresAt: new Date(expiresAtMs).toISOString(),
		};
		const authorizedInput = runtimeBoxToolInvokeInputSchema.parse({
			...input,
			authorization,
		});
		this.actions.createGrant({
			actionId,
			grantId,
			grantTokenHash: sha256(grantToken),
			invocationId: input.invocationId,
			targetKind: "runtime-box",
			targetId: runtimeBoxId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			tool: input.call.tool,
			parameterDigest,
			riskClass: metadata.riskClass,
			sideEffectClass: metadata.sideEffectClass,
			idempotencyClass: metadata.idempotencyClass,
			policyRule: decision.policyRule,
			originInstanceId: this.authority.instanceId,
			originGeneration: this.authority.generation,
			targetInstanceId: targetIdentity.instanceId,
			targetGeneration: targetIdentity.generation,
			executionScope: authoritativeContext.executionScope,
			expiresAtMs,
		});
		this.actions.consumeGrant(actionId, grantId, sha256(grantToken));
		return authorizedInput;
	}

	#resolveExecutionContext(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		requested: ExecutorExecutionContext,
	): ExecutorExecutionContext {
		let run: ReturnType<RunJournalRepository["get"]>;
		try {
			run = this.runs.get(input.runId);
		} catch {
			throw new ActionPolicyDeniedError("Tool invocation Run snapshot is unavailable.");
		}
		const project = run.projectContext;
		if (project === undefined) {
			if (requested.executionScope === "project-root") {
				throw new ActionPolicyDeniedError(
					"project-root authorization requires a persisted Project Run snapshot.",
				);
			}
			return requested;
		}
		if (
			requested.executionScope !== "project-root" ||
			requested.projectPathRevision !== project.projectPathRevision ||
			project.runtimeBoxId !== runtimeBoxId ||
			input.cwd !== project.projectPath
		) {
			throw new ActionPolicyDeniedError(
				"Tool invocation did not match its persisted Project Run snapshot.",
			);
		}
		return {
			executionScope: "project-root",
			projectPathRevision: project.projectPathRevision,
		};
	}

	#buildMcpSummary(
		input: RuntimeBoxMcpToolInvokeInput,
		target: { kind: "runtime-box" | "agent-server"; id: string },
	): ApprovalActionSummary {
		const classification = classifyMcpAction(input);
		return {
			tool: `mcp:${input.mcpServerId}:${input.stableToolId}`,
			operation: classification.operation,
			target,
			...(classification.summary.mcpServerId === undefined
				? {}
				: { mcpServerId: classification.summary.mcpServerId }),
			...(classification.summary.mcpToolId === undefined
				? {}
				: { mcpToolId: classification.summary.mcpToolId }),
			redactedParams: classification.summary.redactedParams,
		};
	}

	async #requireApproval(
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		actionId: string,
		action: ApprovalActionSummary,
		risk: ActionRisk,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (this.#approvalGate === undefined) {
			return;
		}
		const request: ApprovalGateRequest = {
			runId: input.runId,
			invocationId: input.invocationId,
			toolCallId: input.toolCallId,
			actionId,
			action,
			risk,
		};
		await this.#approvalGate.requireApproval(request, signal === undefined ? {} : { signal });
	}

	async authorizeMcp(
		runtimeBoxId: string,
		input: RuntimeBoxMcpToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		options: { signal?: AbortSignal } = {},
	): Promise<RuntimeBoxMcpToolInvokeInput> {
		if (input.authorization !== undefined) {
			throw new ActionPolicyDeniedError("MCP Tool authorization is Server-owned.");
		}
		if (!this.#allowMcpTools) {
			throw new ActionPolicyDeniedError("MCP Tool execution is denied by policy.");
		}
		if (targetIdentity.role !== "runtime-box" || targetIdentity.peerId !== runtimeBoxId) {
			throw new ActionPolicyDeniedError("Execution grant target identity is invalid.");
		}
		const actionId = randomUUID();
		const grantId = randomUUID();
		const grantToken = randomBytes(32).toString("base64url");
		if (this.#approvalGate !== undefined) {
			const classification = classifyMcpAction(input);
			await this.#requireApproval(
				input,
				actionId,
				this.#buildMcpSummary(input, { kind: "runtime-box", id: runtimeBoxId }),
				classification.risk,
				options.signal,
			);
		}
		const parameterDigest = sha256(createMcpToolParameterPayload(input));
		const expiresAtMs = Date.now() + executionGrantLifetimeMs;
		const authorization: RuntimeBoxToolAuthorization = {
			actionId,
			grantId,
			grantToken,
			parameterDigest,
			originInstanceId: this.authority.instanceId,
			originGeneration: this.authority.generation,
			targetRuntimeBoxId: runtimeBoxId,
			targetInstanceId: targetIdentity.instanceId,
			targetGeneration: targetIdentity.generation,
			executionScope: "runtime-box-workspace",
			expiresAt: new Date(expiresAtMs).toISOString(),
		};
		const authorizedInput = runtimeBoxMcpToolInvokeInputSchema.parse({
			...input,
			authorization,
		});
		this.actions.createGrant({
			actionId,
			grantId,
			grantTokenHash: sha256(grantToken),
			invocationId: input.invocationId,
			targetKind: "runtime-box",
			targetId: runtimeBoxId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			tool: `mcp:${input.mcpServerId}:${input.stableToolId}`,
			parameterDigest,
			riskClass: "critical",
			sideEffectClass: "external",
			idempotencyClass: "non_idempotent",
			policyRule: "poc.trusted-bound-agent-server.mcp",
			originInstanceId: this.authority.instanceId,
			originGeneration: this.authority.generation,
			targetInstanceId: targetIdentity.instanceId,
			targetGeneration: targetIdentity.generation,
			executionScope: "runtime-box-workspace",
			expiresAtMs,
		});
		this.actions.consumeGrant(actionId, grantId, sha256(grantToken));
		return authorizedInput;
	}

	async authorizeAgentServerMcp(
		agentServerId: string,
		input: RuntimeBoxMcpToolInvokeInput,
		options: { signal?: AbortSignal } = {},
	): Promise<RuntimeBoxMcpToolInvokeInput> {
		if (input.authorization !== undefined) {
			throw new ActionPolicyDeniedError("MCP Tool authorization is Server-owned.");
		}
		if (!this.#allowMcpTools) {
			throw new ActionPolicyDeniedError("MCP Tool execution is denied by policy.");
		}
		const actionId = randomUUID();
		const grantId = randomUUID();
		const grantToken = randomBytes(32).toString("base64url");
		if (this.#approvalGate !== undefined) {
			const classification = classifyMcpAction(input);
			await this.#requireApproval(
				input,
				actionId,
				this.#buildMcpSummary(input, { kind: "agent-server", id: agentServerId }),
				classification.risk,
				options.signal,
			);
		}
		const parameterDigest = sha256(createMcpToolParameterPayload(input));
		const expiresAtMs = Date.now() + executionGrantLifetimeMs;
		this.actions.createGrant({
			actionId,
			grantId,
			grantTokenHash: sha256(grantToken),
			invocationId: input.invocationId,
			targetKind: "agent-server",
			targetId: agentServerId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			tool: `mcp:${input.mcpServerId}:${input.stableToolId}`,
			parameterDigest,
			riskClass: "critical",
			sideEffectClass: "external",
			idempotencyClass: "non_idempotent",
			policyRule: "poc.trusted-agent-server.mcp",
			originInstanceId: this.authority.instanceId,
			originGeneration: this.authority.generation,
			targetInstanceId: this.authority.instanceId,
			targetGeneration: this.authority.generation,
			executionScope: "agent-server-mcp",
			expiresAtMs,
		});
		this.actions.consumeGrant(actionId, grantId, sha256(grantToken));
		return input;
	}

	completeAgentServerMcp(
		agentServerId: string,
		input: RuntimeBoxMcpToolInvokeInput,
		result: RuntimeBoxMcpToolInvokeOutput,
	): void {
		this.actions.completeLocal(agentServerId, input.invocationId, result);
	}

	complete(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		result: ExecutorToolInvokeOutput | RuntimeBoxMcpToolInvokeOutput,
	): void {
		this.actions.complete(runtimeBoxId, createEvidence(input, "succeeded", { result }));
	}

	fail(input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput, safeError: string): void {
		this.actions.markFailed(input.invocationId, safeError);
	}

	cancel(input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput, safeError: string): void {
		this.actions.markCancelled(input.invocationId, safeError);
	}

	cancelUndispatched(
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		safeError: string,
	): void {
		this.actions.cancelUndispatched(input.invocationId, safeError);
	}

	markOutcomeUnknown(
		input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
		safeError: string,
	): void {
		this.actions.markOutcomeUnknown(input.invocationId, safeError);
	}

	reconcile(
		runtimeBoxId: string,
		items: readonly RuntimeBoxInvocationEvidence[],
		acknowledgedInvocationIds: readonly string[],
	): ReconcileRuntimeBoxInvocationsOutput {
		for (const evidence of items) {
			this.actions.complete(runtimeBoxId, evidence);
		}
		const ackedInvocationIds = items.map((item) => item.invocationId);
		const confirmedAcknowledgementIds = [...new Set(acknowledgedInvocationIds)];
		this.actions.markServerAcked(ackedInvocationIds);
		this.actions.markReceiptConfirmed(runtimeBoxId, confirmedAcknowledgementIds);
		return reconcileRuntimeBoxInvocationsOutputSchema.parse({
			ackedInvocationIds,
			confirmedAcknowledgementIds,
		});
	}

	markServerAcked(invocationIds: readonly string[]): void {
		this.actions.markServerAcked(invocationIds);
	}

	markReceiptConfirmed(runtimeBoxId: string, invocationIds: readonly string[]): void {
		this.actions.markReceiptConfirmed(runtimeBoxId, invocationIds);
	}
}

function createEvidence(
	input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
	state: "succeeded",
	detail: { result: RuntimeBoxActionResult },
): RuntimeBoxInvocationEvidence {
	const authorization = requireAuthorization(input);
	return {
		invocationId: input.invocationId,
		actionId: authorization.actionId,
		grantId: authorization.grantId,
		parameterDigest: authorization.parameterDigest,
		originInstanceId: authorization.originInstanceId,
		originGeneration: authorization.originGeneration,
		targetRuntimeBoxId: authorization.targetRuntimeBoxId,
		targetInstanceId: authorization.targetInstanceId,
		targetGeneration: authorization.targetGeneration,
		state,
		result: detail.result,
		completedAt: new Date().toISOString(),
	};
}

function requireAuthorization(
	input: ExecutorToolInvokeInput | RuntimeBoxMcpToolInvokeInput,
): RuntimeBoxToolAuthorization {
	if (input.authorization === undefined) {
		throw new Error("Authorized invocation is missing its execution grant.");
	}
	return input.authorization;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
