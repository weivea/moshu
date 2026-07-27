import { z } from "zod";

import {
	providerAuthTypeSchema,
	providerContractSchemaVersion,
	providerIdSchema,
} from "./provider";

export const authAttemptStatusValues = [
	"created",
	"waiting_for_interaction",
	"authenticating",
	"completed",
	"failed",
	"cancelled",
] as const;
export const authAttemptStatusSchema = z.enum(authAttemptStatusValues);
export const authAttemptIdSchema = z.string().uuid();

const authPromptBaseSchema = z.object({
	id: z.string().uuid(),
	message: z.string().min(1).max(4_096),
	placeholder: z.string().max(500).optional(),
});
export const authChallengeSchema = z.discriminatedUnion("type", [
	authPromptBaseSchema.extend({ type: z.literal("text") }).strict(),
	authPromptBaseSchema.extend({ type: z.literal("secret") }).strict(),
	authPromptBaseSchema.extend({ type: z.literal("manual_code") }).strict(),
	authPromptBaseSchema
		.extend({
			type: z.literal("select"),
			options: z
				.array(
					z
						.object({
							id: z.string().min(1).max(200),
							label: z.string().min(1).max(500),
							description: z.string().max(2_000).optional(),
						})
						.strict(),
				)
				.min(1)
				.max(100),
		})
		.strict(),
]);

export const authNotificationSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("info"),
			message: z.string().min(1).max(4_096),
			links: z
				.array(z.object({ url: z.string().url(), label: z.string().max(500).optional() }).strict())
				.max(16)
				.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("auth_url"),
			url: z.string().url(),
			instructions: z.string().max(4_096).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("device_code"),
			userCode: z.string().min(1).max(500),
			verificationUri: z.string().url(),
			intervalSeconds: z.number().positive().optional(),
			expiresInSeconds: z.number().positive().optional(),
		})
		.strict(),
	z.object({ type: z.literal("progress"), message: z.string().min(1).max(4_096) }).strict(),
]);

export const providerAuthAttemptSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		id: authAttemptIdSchema,
		providerId: providerIdSchema,
		authType: providerAuthTypeSchema,
		status: authAttemptStatusSchema,
		createdAt: z.string().datetime({ offset: true }),
		updatedAt: z.string().datetime({ offset: true }),
		challenge: authChallengeSchema.optional(),
		notifications: z.array(authNotificationSchema).max(1_000),
		error: z.string().min(1).max(1_000).optional(),
	})
	.strict();
export const startProviderAuthInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
		authType: providerAuthTypeSchema,
	})
	.strict();
export const providerAuthAttemptInputSchema = z.object({ attemptId: authAttemptIdSchema }).strict();
export const respondProviderAuthInputSchema = providerAuthAttemptInputSchema
	.extend({
		challengeId: z.string().uuid(),
		value: z.string().max(8_192),
	})
	.strict();
export const providerAuthAttemptOutputSchema = z
	.object({ attempt: providerAuthAttemptSchema })
	.strict();
export const logoutProviderInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
	})
	.strict();
export const logoutProviderOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
		configured: z.literal(false),
	})
	.strict();

export type AuthChallenge = z.infer<typeof authChallengeSchema>;
export type AuthNotification = z.infer<typeof authNotificationSchema>;
export type ProviderAuthAttempt = z.infer<typeof providerAuthAttemptSchema>;
export type ProviderAuthAttemptOutput = z.infer<typeof providerAuthAttemptOutputSchema>;
export type StartProviderAuthInput = z.infer<typeof startProviderAuthInputSchema>;
export type RespondProviderAuthInput = z.infer<typeof respondProviderAuthInputSchema>;
