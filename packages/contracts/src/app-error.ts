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

export const maxAppErrorCodeCharacters = 128;
export const maxAppErrorMessageKeyCharacters = 256;
export const maxAppErrorSafeMessageCharacters = 1_024;
export const maxAppErrorCauseIdCharacters = 256;

export const appErrorSchema = z.object({
	code: z.string().min(1).max(maxAppErrorCodeCharacters),
	category: appErrorCategorySchema,
	messageKey: z.string().min(1).max(maxAppErrorMessageKeyCharacters),
	safeMessage: z.string().min(1).max(maxAppErrorSafeMessageCharacters),
	retryable: z.boolean(),
	details: z.record(z.string(), z.json()).optional(),
	causeId: z.string().min(1).max(maxAppErrorCauseIdCharacters).optional(),
});

export function normalizeAppErrorSafeMessage(value: unknown, fallback: string): string {
	const normalizedFallback = fallback.trim().slice(0, maxAppErrorSafeMessageCharacters);
	if (normalizedFallback.length === 0) {
		throw new TypeError("A non-empty safe error fallback is required.");
	}
	if (typeof value !== "string") {
		return normalizedFallback;
	}
	const normalized = value.trim();
	return (normalized.length === 0 ? normalizedFallback : normalized).slice(
		0,
		maxAppErrorSafeMessageCharacters,
	);
}

export type AppErrorCategory = z.infer<typeof appErrorCategorySchema>;
export type AppError = z.infer<typeof appErrorSchema>;
