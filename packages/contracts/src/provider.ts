import { z } from "zod";

import { appErrorSchema } from "./app-error";

export const providerContractSchemaVersion = 1 as const;

export const providerTypeValues = ["openai-compatible", "anthropic-compatible"] as const;

export const providerTypeSchema = z.enum(providerTypeValues);

export const maxProviderCount = 64;
export const maxProviderModelCount = 1_024;
export const maxCustomHeaderCount = 32;
export const maxCustomHeaderNameCharacters = 128;
export const maxCustomHeaderValueCharacters = 4_096;
export const minAnthropicThinkingBudgetTokens = 1_024;
/** Anthropic needs `max_tokens` to leave room for the answer after the thinking budget. */
export const minOutputTokensAboveThinkingBudget = 1_024;

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const providerIdSchema = z.string().regex(uuidV7Pattern, "Expected UUIDv7.");
const providerDisplayNameSchema = z.string().trim().min(1).max(120);
const providerBaseUrlSchema = z.string().trim().url().max(2048);
const providerApiKeySchema = z.string().trim().min(1).max(4096);
const providerApiKeyMaskSchema = z.string().trim().min(1).max(64);
const modelIdSchema = z.string().trim().min(1).max(200);
const modelDisplayNameSchema = z.string().trim().min(1).max(200);
const reasoningEffortSchema = z.string().trim().min(1).max(32);
const tokenCountSchema = z.int().min(0).max(100_000_000);

const customHeaderNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(maxCustomHeaderNameCharacters)
	.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Expected a valid HTTP header name.");

export const customHeadersSchema = z
	.record(customHeaderNameSchema, z.string().max(maxCustomHeaderValueCharacters))
	.refine(
		(value) => Object.keys(value).length <= maxCustomHeaderCount,
		`At most ${maxCustomHeaderCount} custom headers are supported.`,
	);

export const modelThinkingBudgetSchema = z
	.object({
		adaptive: z.boolean().optional(),
		minBudgetTokens: tokenCountSchema.optional(),
		maxBudgetTokens: tokenCountSchema.optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.minBudgetTokens === undefined ||
			value.maxBudgetTokens === undefined ||
			value.minBudgetTokens <= value.maxBudgetTokens,
		"Thinking budget minimum cannot exceed its maximum.",
	);

export const providerModelSchema = z
	.object({
		id: modelIdSchema,
		enabled: z.boolean(),
		displayName: modelDisplayNameSchema.optional(),
		vendor: z.string().trim().min(1).max(120).optional(),
		kind: z.string().trim().min(1).max(64).optional(),
		preview: z.boolean().optional(),
		contextWindowTokens: tokenCountSchema.optional(),
		maxOutputTokens: tokenCountSchema.optional(),
		supportedEndpoints: z.array(z.string().trim().min(1).max(200)).max(16).optional(),
		reasoningEfforts: z.array(reasoningEffortSchema).max(16).optional(),
		thinking: modelThinkingBudgetSchema.optional(),
	})
	.strict();

export const reasoningCapabilitySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z
		.object({
			kind: z.literal("effort"),
			levels: z.array(reasoningEffortSchema).min(1).max(16),
		})
		.strict(),
	z
		.object({
			kind: z.literal("budget"),
			adaptive: z.boolean().optional(),
			minBudgetTokens: tokenCountSchema,
			maxBudgetTokens: tokenCountSchema.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("both"),
			levels: z.array(reasoningEffortSchema).min(1).max(16),
			adaptive: z.boolean().optional(),
			minBudgetTokens: tokenCountSchema,
			maxBudgetTokens: tokenCountSchema.optional(),
		})
		.strict(),
]);

export const reasoningSelectionSchema = z
	.object({
		effort: reasoningEffortSchema.optional(),
		budgetTokens: tokenCountSchema.optional(),
	})
	.strict();

export const providerSummarySchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		id: providerIdSchema,
		displayName: providerDisplayNameSchema,
		type: providerTypeSchema,
		baseUrl: providerBaseUrlSchema,
		enabled: z.boolean(),
		apiKeyMask: providerApiKeyMaskSchema.optional(),
		customHeaderNames: z.array(customHeaderNameSchema).max(maxCustomHeaderCount),
		models: z.array(providerModelSchema).max(maxProviderModelCount),
		modelsFetchedAt: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

export const availableModelSchema = z
	.object({
		providerId: providerIdSchema,
		providerDisplayName: providerDisplayNameSchema,
		providerType: providerTypeSchema,
		model: providerModelSchema,
		reasoning: reasoningCapabilitySchema,
	})
	.strict();

export const defaultModelSelectionSchema = z
	.object({
		providerId: providerIdSchema,
		modelId: modelIdSchema,
		reasoning: reasoningSelectionSchema.optional(),
	})
	.strict();

export const sessionModelSelectionSchema = defaultModelSelectionSchema;

export const listProvidersOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providers: z.array(providerSummarySchema).max(maxProviderCount),
	})
	.strict();

export const createProviderInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		displayName: providerDisplayNameSchema,
		type: providerTypeSchema,
		baseUrl: providerBaseUrlSchema,
		apiKey: providerApiKeySchema,
		customHeaders: customHeadersSchema.optional(),
	})
	.strict();

export const providerMutationOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		provider: providerSummarySchema,
	})
	.strict();

export const updateProviderInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
		displayName: providerDisplayNameSchema.optional(),
		type: providerTypeSchema.optional(),
		baseUrl: providerBaseUrlSchema.optional(),
		apiKey: providerApiKeySchema.optional(),
		customHeaders: customHeadersSchema.optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

export const deleteProviderInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
	})
	.strict();

export const deleteProviderOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
	})
	.strict();

export const providerDraftSchema = z
	.object({
		displayName: providerDisplayNameSchema,
		type: providerTypeSchema,
		baseUrl: providerBaseUrlSchema,
		apiKey: providerApiKeySchema.optional(),
		customHeaders: customHeadersSchema.optional(),
	})
	.strict();

export const testProviderInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema.optional(),
		draft: providerDraftSchema.optional(),
	})
	.strict()
	.refine(
		(value) => (value.providerId === undefined) !== (value.draft === undefined),
		"Provide exactly one of providerId or draft.",
	);

export const testProviderOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		ok: z.boolean(),
		latencyMs: z.int().min(0),
		error: appErrorSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.ok && value.error !== undefined) {
			context.addIssue({
				code: "custom",
				message: "Successful provider tests cannot include an error.",
				path: ["error"],
			});
		}
		if (!value.ok && value.error === undefined) {
			context.addIssue({
				code: "custom",
				message: "Failed provider tests require an error.",
				path: ["error"],
			});
		}
	});

export const fetchProviderModelsInputSchema = deleteProviderInputSchema;
export const fetchProviderModelsOutputSchema = providerMutationOutputSchema;

export const setProviderModelsEnabledInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		providerId: providerIdSchema,
		enabledModelIds: z.array(modelIdSchema).max(maxProviderModelCount),
	})
	.strict();

export const setProviderModelsEnabledOutputSchema = providerMutationOutputSchema;

export const listAvailableModelsOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		models: z.array(availableModelSchema).max(maxProviderCount * maxProviderModelCount),
		defaultModel: defaultModelSelectionSchema.optional(),
	})
	.strict();

export const getDefaultModelOutputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		defaultModel: defaultModelSelectionSchema.optional(),
	})
	.strict();

export const setDefaultModelInputSchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		defaultModel: defaultModelSelectionSchema.nullable(),
	})
	.strict();

export const setDefaultModelOutputSchema = getDefaultModelOutputSchema;

export type ProviderType = z.infer<typeof providerTypeSchema>;
export type CustomHeaders = z.infer<typeof customHeadersSchema>;
export type ModelThinkingBudget = z.infer<typeof modelThinkingBudgetSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ReasoningCapability = z.infer<typeof reasoningCapabilitySchema>;
export type ReasoningSelection = z.infer<typeof reasoningSelectionSchema>;
export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type AvailableModel = z.infer<typeof availableModelSchema>;
export type DefaultModelSelection = z.infer<typeof defaultModelSelectionSchema>;
export type SessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;
export type ListProvidersOutput = z.infer<typeof listProvidersOutputSchema>;
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;
export type DeleteProviderInput = z.infer<typeof deleteProviderInputSchema>;
export type DeleteProviderOutput = z.infer<typeof deleteProviderOutputSchema>;
export type ProviderDraft = z.infer<typeof providerDraftSchema>;
export type ProviderMutationOutput = z.infer<typeof providerMutationOutputSchema>;
export type TestProviderInput = z.infer<typeof testProviderInputSchema>;
export type TestProviderOutput = z.infer<typeof testProviderOutputSchema>;
export type FetchProviderModelsInput = z.infer<typeof fetchProviderModelsInputSchema>;
export type FetchProviderModelsOutput = z.infer<typeof fetchProviderModelsOutputSchema>;
export type SetProviderModelsEnabledInput = z.infer<typeof setProviderModelsEnabledInputSchema>;
export type SetProviderModelsEnabledOutput = z.infer<typeof setProviderModelsEnabledOutputSchema>;
export type ListAvailableModelsOutput = z.infer<typeof listAvailableModelsOutputSchema>;
export type GetDefaultModelOutput = z.infer<typeof getDefaultModelOutputSchema>;
export type SetDefaultModelInput = z.infer<typeof setDefaultModelInputSchema>;
export type SetDefaultModelOutput = z.infer<typeof setDefaultModelOutputSchema>;
