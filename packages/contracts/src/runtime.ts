import { z } from "zod";

export const emptyParamsSchema = z.object({}).strict();

export const runtimeInfoSchema = z.object({
	apiVersion: z.literal(1),
	appName: z.string().min(1),
	appVersion: z.string().min(1),
	channel: z.enum(["dev", "canary", "stable"]),
	electrobunVersion: z.string().min(1),
	bunVersion: z.string().min(1),
	platform: z.enum(["darwin", "win32", "linux"]),
	arch: z.string().min(1),
	deepAgents: z.object({
		loaded: z.boolean(),
		version: z.string().min(1),
	}),
});

export type EmptyParams = z.infer<typeof emptyParamsSchema>;
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;
