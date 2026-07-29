import { z } from "zod";
import type { ExecutorToolName } from "@moshu/contracts";

export const riskClassSchema = z.enum(["low", "medium", "high", "forbidden"]);
export const sideEffectClassSchema = z.enum(["none", "local_reversible", "local", "remote"]);
export const idempotencyClassSchema = z.enum([
	"read",
	"idempotent",
	"detectable",
	"non_idempotent",
]);

export const toolMetadataSchema = z.object({
	name: z.string().min(1),
	riskClass: riskClassSchema,
	sideEffectClass: sideEffectClassSchema,
	idempotencyClass: idempotencyClassSchema,
	requiredCapabilities: z.array(z.string().min(1)),
});

export const actionRequestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	runId: z.string().min(1),
	sessionId: z.string().min(1),
	toolCallId: z.string().min(1),
	actionType: z.string().min(1),
	args: z.record(z.string(), z.json()),
	idempotencyKey: z.string().min(1),
	requestedCapabilities: z.array(z.string().min(1)),
	agentContext: z.object({
		agentVersionId: z.string().min(1),
		subagentId: z.string().min(1).optional(),
	}),
});

export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export type PolicyDecision =
	| { outcome: "allow"; policyRule: string }
	| { outcome: "approval_required"; policyRule: string; reason: string }
	| { outcome: "deny"; policyRule: string; reason: string };

export interface ActionResult {
	state: "succeeded" | "failed" | "unknown";
	safeSummary: string;
}

export interface ActionBroker {
	evaluate(request: ActionRequest): Promise<PolicyDecision>;
	execute(request: ActionRequest): Promise<ActionResult>;
}

const executorToolMetadata: Record<ExecutorToolName, ToolMetadata> = {
	read: {
		name: "executor.read",
		riskClass: "low",
		sideEffectClass: "none",
		idempotencyClass: "read",
		requiredCapabilities: ["tool.read"],
	},
	grep: {
		name: "executor.grep",
		riskClass: "low",
		sideEffectClass: "none",
		idempotencyClass: "read",
		requiredCapabilities: ["tool.grep"],
	},
	find: {
		name: "executor.find",
		riskClass: "low",
		sideEffectClass: "none",
		idempotencyClass: "read",
		requiredCapabilities: ["tool.find"],
	},
	ls: {
		name: "executor.ls",
		riskClass: "low",
		sideEffectClass: "none",
		idempotencyClass: "read",
		requiredCapabilities: ["tool.ls"],
	},
	edit: {
		name: "executor.edit",
		riskClass: "medium",
		sideEffectClass: "local_reversible",
		idempotencyClass: "detectable",
		requiredCapabilities: ["tool.edit"],
	},
	write: {
		name: "executor.write",
		riskClass: "medium",
		sideEffectClass: "local_reversible",
		idempotencyClass: "detectable",
		requiredCapabilities: ["tool.write"],
	},
	bash: {
		name: "executor.bash",
		riskClass: "high",
		sideEffectClass: "local",
		idempotencyClass: "non_idempotent",
		requiredCapabilities: ["tool.bash"],
	},
};

export function getExecutorToolMetadata(tool: ExecutorToolName): ToolMetadata {
	return toolMetadataSchema.parse(executorToolMetadata[tool]);
}

export class DefaultActionPolicy {
	constructor(private readonly allowSideEffects: boolean) {}

	evaluateTool(tool: ExecutorToolName): PolicyDecision {
		const metadata = getExecutorToolMetadata(tool);
		if (metadata.sideEffectClass === "none") {
			return { outcome: "allow", policyRule: "builtin-read-only" };
		}
		if (this.allowSideEffects) {
			return { outcome: "allow", policyRule: "poc-explicit-side-effects" };
		}
		return {
			outcome: "approval_required",
			policyRule: "side-effects-require-approval",
			reason: `${metadata.name} can change Runtime Box state.`,
		};
	}
}
