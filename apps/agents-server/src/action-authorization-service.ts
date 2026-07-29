import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DefaultActionPolicy, getExecutorToolMetadata } from "@moshu/action-broker";
import {
	createExecutorToolParameterPayload,
	type ExecutorToolInvokeInput,
	type ExecutorToolInvokeOutput,
	type ProcessPeerIdentity,
	reconcileRuntimeBoxInvocationsOutputSchema,
	type ReconcileRuntimeBoxInvocationsOutput,
	type RuntimeBoxInvocationEvidence,
	type RuntimeBoxToolAuthorization,
	runtimeBoxToolInvokeInputSchema,
} from "@moshu/contracts";
import type { ActionRepository } from "@moshu/database";
import type { RpcPeerIdentity } from "@moshu/process-rpc";
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

	constructor(
		private readonly actions: ActionRepository,
		private readonly authority: ProcessPeerIdentity,
		options: { allowSideEffects: boolean } = { allowSideEffects: true },
	) {
		this.#policy = new DefaultActionPolicy(options.allowSideEffects);
	}

	async authorize(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		targetIdentity: RpcPeerIdentity,
		executionScope: "request-cwd" | "runtime-box-workspace",
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
		const parameterDigest = sha256(createExecutorToolParameterPayload(input));
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
			executionScope,
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
			runtimeBoxId,
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
			executionScope,
			expiresAtMs,
		});
		this.actions.consumeGrant(actionId, grantId, sha256(grantToken));
		return authorizedInput;
	}

	complete(
		runtimeBoxId: string,
		input: ExecutorToolInvokeInput,
		result: ExecutorToolInvokeOutput,
	): void {
		this.actions.complete(runtimeBoxId, createEvidence(input, "succeeded", { result }));
	}

	fail(input: ExecutorToolInvokeInput, safeError: string): void {
		this.actions.markFailed(input.invocationId, safeError);
	}

	cancel(input: ExecutorToolInvokeInput, safeError: string): void {
		this.actions.markCancelled(input.invocationId, safeError);
	}

	cancelUndispatched(input: ExecutorToolInvokeInput, safeError: string): void {
		this.actions.cancelUndispatched(input.invocationId, safeError);
	}

	markOutcomeUnknown(input: ExecutorToolInvokeInput, safeError: string): void {
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
		this.actions.markReceiptConfirmed(confirmedAcknowledgementIds);
		return reconcileRuntimeBoxInvocationsOutputSchema.parse({
			ackedInvocationIds,
			confirmedAcknowledgementIds,
		});
	}

	markServerAcked(invocationIds: readonly string[]): void {
		this.actions.markServerAcked(invocationIds);
	}

	markReceiptConfirmed(invocationIds: readonly string[]): void {
		this.actions.markReceiptConfirmed(invocationIds);
	}
}

function createEvidence(
	input: ExecutorToolInvokeInput,
	state: "succeeded",
	detail: { result: ExecutorToolInvokeOutput },
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

function requireAuthorization(input: ExecutorToolInvokeInput): RuntimeBoxToolAuthorization {
	if (input.authorization === undefined) {
		throw new Error("Authorized invocation is missing its execution grant.");
	}
	return input.authorization;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
