import { z } from "zod";

export const emptyParamsSchema = z.object({}).strict();

export const agentRuntimeInfoSchema = z
	.object({
		loaded: z.boolean(),
		foundation: z.literal("pi-agent"),
		versions: z
			.object({
				piAi: z.string().min(1),
				piAgentCore: z.string().min(1),
				piCodingAgent: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export const agentsRuntimeInfoSchema = z
	.object({
		apiVersion: z.literal(2),
		serverVersion: z.string().min(1),
		bunVersion: z.string().min(1),
		platform: z.enum(["darwin", "win32", "linux"]),
		arch: z.string().min(1),
		agentRuntime: agentRuntimeInfoSchema,
		ready: z.boolean(),
		executor: z
			.object({
				connected: z.boolean(),
				registered: z.boolean(),
				peerId: z.string().min(1).max(256).optional(),
				instanceId: z.string().min(1).max(256).optional(),
				generation: z.int().nonnegative().safe().optional(),
			})
			.strict(),
	})
	.strict();

export const runtimeInfoSchema = z.object({
	apiVersion: z.literal(2),
	appName: z.string().min(1),
	appVersion: z.string().min(1),
	channel: z.enum(["dev", "canary", "stable"]),
	electrobunVersion: z.string().min(1),
	bunVersion: z.string().min(1),
	platform: z.enum(["darwin", "win32", "linux"]),
	arch: z.string().min(1),
	agentRuntime: agentRuntimeInfoSchema,
});

export type EmptyParams = z.infer<typeof emptyParamsSchema>;
export type AgentRuntimeInfo = z.infer<typeof agentRuntimeInfoSchema>;
export type AgentsRuntimeInfo = z.infer<typeof agentsRuntimeInfoSchema>;
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;
