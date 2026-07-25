import { z } from "zod";

export const appErrorCategorySchema = z.enum([
	"validation",
	"permission",
	"authentication",
	"rate_limit",
	"network",
	"provider",
	"tool",
	"conflict",
	"storage",
	"runtime",
	"unknown",
]);

export const appErrorSchema = z.object({
	code: z.string().min(1),
	category: appErrorCategorySchema,
	messageKey: z.string().min(1),
	safeMessage: z.string().min(1),
	retryable: z.boolean(),
	details: z.record(z.string(), z.json()).optional(),
	causeId: z.string().min(1).optional(),
});

export type AppErrorCategory = z.infer<typeof appErrorCategorySchema>;
export type AppError = z.infer<typeof appErrorSchema>;
