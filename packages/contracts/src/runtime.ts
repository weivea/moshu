import { z } from "zod";

export const emptyParamsSchema = z.object({}).strict();

export const deepAgentsRuntimeInfoSchema = z
	.object({
		loaded: z.boolean(),
		version: z.string().min(1),
	})
	.strict();

export const agentsRuntimeInfoSchema = z
	.object({
		apiVersion: z.literal(1),
		serverVersion: z.string().min(1),
		bunVersion: z.string().min(1),
		platform: z.enum(["darwin", "win32", "linux"]),
		arch: z.string().min(1),
		deepAgents: deepAgentsRuntimeInfoSchema,
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
	apiVersion: z.literal(1),
	appName: z.string().min(1),
	appVersion: z.string().min(1),
	channel: z.enum(["dev", "canary", "stable"]),
	electrobunVersion: z.string().min(1),
	bunVersion: z.string().min(1),
	platform: z.enum(["darwin", "win32", "linux"]),
	arch: z.string().min(1),
	deepAgents: deepAgentsRuntimeInfoSchema,
});

export type EmptyParams = z.infer<typeof emptyParamsSchema>;
export type AgentsRuntimeInfo = z.infer<typeof agentsRuntimeInfoSchema>;
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;
