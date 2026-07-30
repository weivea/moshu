import { createHash } from "node:crypto";
import {
	actionIdSchema,
	actionParameterDigestSchema,
	executionGrantIdSchema,
	type RuntimeBoxActionResult,
	runtimeBoxActionResultSchema,
	runtimeBoxInvocationEvidenceSchema,
	type RuntimeBoxInvocationEvidence,
} from "@moshu/contracts";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { AppDrizzleDatabase } from "./database";
import { actionIntentsTable, chatRunsTable, executionGrantsTable } from "./schema";

export type ActionIntentState =
	| "granted"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "outcome_unknown";

export interface CreateActionGrantInput {
	actionId: string;
	grantId: string;
	grantTokenHash: string;
	invocationId: string;
	targetKind: "agent-server" | "runtime-box";
	targetId: string;
	runId: string;
	toolCallId: string;
	tool: string;
	parameterDigest: string;
	riskClass: string;
	sideEffectClass: string;
	idempotencyClass: string;
	policyRule: string;
	originInstanceId: string;
	originGeneration: number;
	targetInstanceId: string;
	targetGeneration: number;
	executionScope: string;
	expiresAtMs: number;
}

export interface ActionIntentRecord {
	actionId: string;
	grantId: string;
	invocationId: string;
	targetKind: "agent-server" | "runtime-box";
	targetId: string;
	runId: string;
	tool: string;
	parameterDigest: string;
	state: ActionIntentState;
	result?: RuntimeBoxActionResult;
	safeError?: string;
	grantConsumedAtMs?: number;
	serverAckedAtMs?: number;
	boxReceiptConfirmedAtMs?: number;
}

export class ActionGrantRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionGrantRejectedError";
	}
}

export class ActionEvidenceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionEvidenceConflictError";
	}
}

export interface ActionRepository {
	createGrant(input: CreateActionGrantInput): void;
	consumeGrant(actionId: string, grantId: string, grantTokenHash: string): void;
	markRunning(invocationId: string): void;
	markFailed(invocationId: string, safeError: string): void;
	markCancelled(invocationId: string, safeError: string): void;
	markOutcomeUnknown(invocationId: string, safeError: string): void;
	complete(runtimeBoxId: string, evidence: RuntimeBoxInvocationEvidence): void;
	completeLocal(targetId: string, invocationId: string, result: RuntimeBoxActionResult): void;
	markServerAcked(invocationIds: readonly string[]): void;
	markReceiptConfirmed(runtimeBoxId: string, invocationIds: readonly string[]): void;
	cancelUndispatched(invocationId: string, safeError: string): void;
	recoverOnStartup(): { cancelled: number; outcomeUnknown: number };
	hasUnacknowledgedForSession(sessionId: string): boolean;
	hasUnacknowledgedForProject(projectId: string): boolean;
	get(invocationId: string): ActionIntentRecord;
}

export class SqliteActionRepository implements ActionRepository {
	constructor(
		private readonly orm: AppDrizzleDatabase,
		private readonly clock: { now(): number } = { now: Date.now },
	) {}

	createGrant(input: CreateActionGrantInput): void {
		const actionId = actionIdSchema.parse(input.actionId);
		const grantId = executionGrantIdSchema.parse(input.grantId);
		const parameterDigest = actionParameterDigestSchema.parse(input.parameterDigest);
		if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.clock.now()) {
			throw new TypeError("Execution grant expiry must be in the future.");
		}
		const now = this.clock.now();
		this.orm.transaction((transaction) => {
			transaction
				.insert(actionIntentsTable)
				.values({
					id: actionId,
					invocationId: input.invocationId,
					targetKind: input.targetKind,
					targetId: input.targetId,
					runId: input.runId,
					toolCallId: input.toolCallId,
					tool: input.tool,
					parameterDigest,
					riskClass: input.riskClass,
					sideEffectClass: input.sideEffectClass,
					idempotencyClass: input.idempotencyClass,
					policyRule: input.policyRule,
					originInstanceId: input.originInstanceId,
					originGeneration: input.originGeneration,
					targetInstanceId: input.targetInstanceId,
					targetGeneration: input.targetGeneration,
					executionScope: input.executionScope,
					state: "granted",
					createdAtMs: now,
					updatedAtMs: now,
				})
				.run();
			transaction
				.insert(executionGrantsTable)
				.values({
					id: grantId,
					actionId,
					tokenHash: requireHash(input.grantTokenHash, "Grant token hash"),
					parameterDigest,
					expiresAtMs: input.expiresAtMs,
					createdAtMs: now,
				})
				.run();
		});
	}

	consumeGrant(actionId: string, grantId: string, grantTokenHash: string): void {
		const now = this.clock.now();
		this.orm.transaction((transaction) => {
			const grant = transaction
				.select()
				.from(executionGrantsTable)
				.where(
					and(
						eq(executionGrantsTable.id, grantId),
						eq(executionGrantsTable.actionId, actionId),
						isNull(executionGrantsTable.consumedAtMs),
					),
				)
				.get();
			if (
				grant === undefined ||
				grant.expiresAtMs <= now ||
				grant.tokenHash !== requireHash(grantTokenHash, "Grant token hash")
			) {
				throw new ActionGrantRejectedError("Execution grant is invalid, expired, or already used.");
			}
			const action = transaction
				.select()
				.from(actionIntentsTable)
				.where(eq(actionIntentsTable.id, actionId))
				.get();
			if (action === undefined || action.state !== "granted") {
				throw new ActionGrantRejectedError("Action intent is not awaiting execution.");
			}
			transaction
				.update(executionGrantsTable)
				.set({ consumedAtMs: now })
				.where(eq(executionGrantsTable.id, grantId))
				.run();
			transaction
				.update(actionIntentsTable)
				.set({ state: "running", updatedAtMs: now })
				.where(eq(actionIntentsTable.id, actionId))
				.run();
		});
	}

	markRunning(invocationId: string): void {
		const action = this.#select(invocationId);
		if (action.state !== "running") {
			throw new ActionGrantRejectedError("Action grant was not consumed before execution.");
		}
	}

	markFailed(invocationId: string, safeError: string): void {
		this.#markTerminal(invocationId, "failed", safeError);
	}

	markCancelled(invocationId: string, safeError: string): void {
		this.#markTerminal(invocationId, "cancelled", safeError);
	}

	markOutcomeUnknown(invocationId: string, safeError: string): void {
		const action = this.#select(invocationId);
		if (isTerminal(action.state)) {
			return;
		}
		const now = this.clock.now();
		this.orm
			.update(actionIntentsTable)
			.set({
				state: "outcome_unknown",
				safeError: boundSafeError(safeError),
				updatedAtMs: now,
				completedAtMs: now,
				...(action.targetKind === "agent-server" ? { serverAckedAtMs: now } : {}),
			})
			.where(eq(actionIntentsTable.invocationId, invocationId))
			.run();
	}

	complete(runtimeBoxId: string, evidenceValue: RuntimeBoxInvocationEvidence): void {
		const evidence = runtimeBoxInvocationEvidenceSchema.parse(evidenceValue);
		const action = this.#select(evidence.invocationId);
		if (
			action.targetKind !== "runtime-box" ||
			action.targetId !== runtimeBoxId ||
			action.id !== evidence.actionId ||
			action.parameterDigest !== evidence.parameterDigest ||
			action.originInstanceId !== evidence.originInstanceId ||
			action.originGeneration !== evidence.originGeneration ||
			action.targetId !== evidence.targetRuntimeBoxId ||
			action.targetInstanceId !== evidence.targetInstanceId ||
			action.targetGeneration !== evidence.targetGeneration
		) {
			throw new ActionEvidenceConflictError(
				"Runtime Box invocation evidence did not match intent.",
			);
		}
		const grant = this.orm
			.select()
			.from(executionGrantsTable)
			.where(eq(executionGrantsTable.actionId, action.id))
			.get();
		if (grant?.id !== evidence.grantId || grant.consumedAtMs === null) {
			throw new ActionEvidenceConflictError("Runtime Box invocation evidence did not match grant.");
		}
		const nextResult =
			evidence.result === undefined
				? undefined
				: runtimeBoxActionResultSchema.parse(evidence.result);
		const resultTool =
			nextResult === undefined
				? undefined
				: "tool" in nextResult
					? nextResult.tool
					: `mcp:${nextResult.mcpServerId}:${nextResult.stableToolId}`;
		if (
			nextResult !== undefined &&
			(nextResult.invocationId !== action.invocationId || resultTool !== action.tool)
		) {
			throw new ActionEvidenceConflictError(
				"Runtime Box result did not match the Action invocation or tool.",
			);
		}
		const resultJson = nextResult === undefined ? null : JSON.stringify(nextResult);
		const resultHash = resultJson === null ? null : sha256(resultJson);
		if (isTerminal(action.state)) {
			if (
				action.state !== evidence.state ||
				(action.resultHash !== null && action.resultHash !== resultHash)
			) {
				throw new ActionEvidenceConflictError(
					"Terminal Action evidence conflicts with persisted state.",
				);
			}
		}
		this.orm
			.update(actionIntentsTable)
			.set({
				state: evidence.state,
				resultJson,
				resultHash,
				safeError: evidence.safeError ?? null,
				updatedAtMs: this.clock.now(),
				completedAtMs: Date.parse(evidence.completedAt),
			})
			.where(eq(actionIntentsTable.id, action.id))
			.run();
	}

	completeLocal(targetId: string, invocationId: string, resultValue: RuntimeBoxActionResult): void {
		const action = this.#select(invocationId);
		if (action.targetKind !== "agent-server" || action.targetId !== targetId) {
			throw new ActionEvidenceConflictError(
				"Agent Server MCP result did not match its Action target.",
			);
		}
		const result = runtimeBoxActionResultSchema.parse(resultValue);
		const resultTool =
			"tool" in result ? result.tool : `mcp:${result.mcpServerId}:${result.stableToolId}`;
		if (result.invocationId !== action.invocationId || resultTool !== action.tool) {
			throw new ActionEvidenceConflictError(
				"Agent Server MCP result did not match the Action invocation or tool.",
			);
		}
		const resultJson = JSON.stringify(result);
		const resultHash = sha256(resultJson);
		const grant = this.orm
			.select()
			.from(executionGrantsTable)
			.where(eq(executionGrantsTable.actionId, action.id))
			.get();
		if (grant === undefined || grant.consumedAtMs === null) {
			throw new ActionEvidenceConflictError(
				"Agent Server MCP Action grant was not consumed before completion.",
			);
		}
		if (isTerminal(action.state)) {
			if (action.state === "succeeded" && action.resultHash === resultHash) {
				return;
			}
			throw new ActionEvidenceConflictError(
				"Agent Server MCP result conflicts with the terminal Action state.",
			);
		}
		if (action.state !== "running") {
			throw new ActionEvidenceConflictError(
				"Agent Server MCP Action is not awaiting a local result.",
			);
		}
		const now = this.clock.now();
		this.orm
			.update(actionIntentsTable)
			.set({
				state: "succeeded",
				resultJson,
				resultHash,
				updatedAtMs: now,
				completedAtMs: now,
				serverAckedAtMs: now,
			})
			.where(eq(actionIntentsTable.id, action.id))
			.run();
	}

	markServerAcked(invocationIds: readonly string[]): void {
		const now = this.clock.now();
		for (const invocationId of new Set(invocationIds)) {
			const action = this.#select(invocationId);
			if (!isTerminal(action.state) && action.state !== "outcome_unknown") {
				throw new ActionEvidenceConflictError(
					"Only completed Action evidence can be acknowledged.",
				);
			}

			this.orm
				.update(actionIntentsTable)
				.set({ serverAckedAtMs: now, updatedAtMs: now })
				.where(eq(actionIntentsTable.invocationId, invocationId))
				.run();
		}
	}

	markReceiptConfirmed(runtimeBoxId: string, invocationIds: readonly string[]): void {
		const now = this.clock.now();
		for (const invocationId of new Set(invocationIds)) {
			const action = this.orm
				.select()
				.from(actionIntentsTable)
				.where(eq(actionIntentsTable.invocationId, invocationId))
				.get();
			if (action === undefined) {
				continue;
			}
			if (action.targetKind !== "runtime-box" || action.targetId !== runtimeBoxId) {
				throw new ActionEvidenceConflictError(
					"Box receipt confirmation did not match the Runtime Box.",
				);
			}
			if (action.serverAckedAtMs === null) {
				throw new ActionEvidenceConflictError(
					"Box receipt cannot be confirmed before evidence acknowledgement.",
				);
			}
			this.orm
				.update(actionIntentsTable)
				.set({ boxReceiptConfirmedAtMs: now, updatedAtMs: now })
				.where(eq(actionIntentsTable.invocationId, invocationId))
				.run();
		}
	}

	cancelUndispatched(invocationId: string, safeError: string): void {
		const action = this.#select(invocationId);
		if (isTerminal(action.state)) {
			return;
		}
		const now = this.clock.now();
		this.orm
			.update(actionIntentsTable)
			.set({
				state: "cancelled",
				safeError: boundSafeError(safeError),
				updatedAtMs: now,
				completedAtMs: now,
				serverAckedAtMs: now,
				boxReceiptConfirmedAtMs: now,
			})
			.where(eq(actionIntentsTable.invocationId, invocationId))
			.run();
	}

	recoverOnStartup(): { cancelled: number; outcomeUnknown: number } {
		const rows = this.orm
			.select({
				id: actionIntentsTable.id,
				state: actionIntentsTable.state,
				targetKind: actionIntentsTable.targetKind,
			})
			.from(actionIntentsTable)
			.where(inArray(actionIntentsTable.state, ["granted", "running"]))
			.all();
		const now = this.clock.now();
		let cancelled = 0;
		let outcomeUnknown = 0;
		this.orm.transaction((transaction) => {
			for (const row of rows) {
				if (row.state === "granted") {
					cancelled += 1;
					transaction
						.update(actionIntentsTable)
						.set({
							state: "cancelled",
							safeError: "Agent Server restarted before the execution grant was dispatched.",
							updatedAtMs: now,
							completedAtMs: now,
							serverAckedAtMs: now,
							boxReceiptConfirmedAtMs: now,
						})
						.where(eq(actionIntentsTable.id, row.id))
						.run();
				} else {
					outcomeUnknown += 1;
					transaction
						.update(actionIntentsTable)
						.set({
							state: "outcome_unknown",
							safeError: "Agent Server restarted before the Action outcome was confirmed.",
							updatedAtMs: now,
							completedAtMs: now,
							...(row.targetKind === "agent-server" ? { serverAckedAtMs: now } : {}),
						})
						.where(eq(actionIntentsTable.id, row.id))
						.run();
				}
			}
		});
		return { cancelled, outcomeUnknown };
	}

	hasUnacknowledgedForSession(sessionId: string): boolean {
		return (
			this.orm
				.select({ id: actionIntentsTable.id })
				.from(actionIntentsTable)
				.innerJoin(chatRunsTable, eq(chatRunsTable.id, actionIntentsTable.runId))
				.where(
					and(
						eq(chatRunsTable.sessionId, sessionId),
						or(
							and(
								eq(actionIntentsTable.targetKind, "runtime-box"),
								isNull(actionIntentsTable.boxReceiptConfirmedAtMs),
							),
							and(
								eq(actionIntentsTable.targetKind, "agent-server"),
								isNull(actionIntentsTable.serverAckedAtMs),
							),
						),
					),
				)
				.limit(1)
				.get() !== undefined
		);
	}

	hasUnacknowledgedForProject(projectId: string): boolean {
		return (
			this.orm
				.select({ id: actionIntentsTable.id })
				.from(actionIntentsTable)
				.innerJoin(chatRunsTable, eq(chatRunsTable.id, actionIntentsTable.runId))
				.where(
					and(
						eq(chatRunsTable.projectId, projectId),
						or(
							and(
								eq(actionIntentsTable.targetKind, "runtime-box"),
								isNull(actionIntentsTable.boxReceiptConfirmedAtMs),
							),
							and(
								eq(actionIntentsTable.targetKind, "agent-server"),
								isNull(actionIntentsTable.serverAckedAtMs),
							),
						),
					),
				)
				.limit(1)
				.get() !== undefined
		);
	}

	get(invocationId: string): ActionIntentRecord {
		const action = this.#select(invocationId);
		const grant = this.orm
			.select()
			.from(executionGrantsTable)
			.where(eq(executionGrantsTable.actionId, action.id))
			.get();
		if (grant === undefined) {
			throw new Error("Action intent is missing its execution grant.");
		}
		return {
			actionId: action.id,
			grantId: grant.id,
			invocationId: action.invocationId,
			targetKind: action.targetKind,
			targetId: action.targetId,
			runId: action.runId,
			tool: action.tool,
			parameterDigest: action.parameterDigest,
			state: action.state,
			...(action.resultJson === null
				? {}
				: { result: runtimeBoxActionResultSchema.parse(JSON.parse(action.resultJson)) }),
			...(action.safeError === null ? {} : { safeError: action.safeError }),
			...(grant.consumedAtMs === null ? {} : { grantConsumedAtMs: grant.consumedAtMs }),
			...(action.serverAckedAtMs === null ? {} : { serverAckedAtMs: action.serverAckedAtMs }),
			...(action.boxReceiptConfirmedAtMs === null
				? {}
				: { boxReceiptConfirmedAtMs: action.boxReceiptConfirmedAtMs }),
		};
	}

	#markTerminal(invocationId: string, state: "failed" | "cancelled", safeError: string): void {
		const action = this.#select(invocationId);
		if (isTerminal(action.state)) {
			return;
		}
		const now = this.clock.now();
		this.orm
			.update(actionIntentsTable)
			.set({
				state,
				safeError: boundSafeError(safeError),
				updatedAtMs: now,
				completedAtMs: now,
				...(action.targetKind === "agent-server" ? { serverAckedAtMs: now } : {}),
			})
			.where(eq(actionIntentsTable.invocationId, invocationId))
			.run();
	}

	#select(invocationId: string) {
		const action = this.orm
			.select()
			.from(actionIntentsTable)
			.where(eq(actionIntentsTable.invocationId, invocationId))
			.get();
		if (action === undefined) {
			throw new ActionEvidenceConflictError("Action intent was not found.");
		}
		return action;
	}
}

function isTerminal(state: ActionIntentState): state is "succeeded" | "failed" | "cancelled" {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

function requireHash(value: string, label: string): string {
	if (!/^[a-f0-9]{64}$/.test(value)) {
		throw new TypeError(`${label} must be a SHA-256 digest.`);
	}
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function boundSafeError(value: string): string {
	const normalized = value.trim();
	return normalized.length === 0 ? "Action failed." : normalized.slice(0, 1_024);
}
