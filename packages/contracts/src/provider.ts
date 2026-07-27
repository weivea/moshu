import { z } from "zod";

import { appErrorSchema } from "./app-error";

export const providerContractSchemaVersion = 2 as const;
export const maxProviderCount = 128;
export const maxProviderModelCount = 2_048;
export const maxCustomHeaderCount = 32;
export const maxCustomHeaderNameCharacters = 128;
export const maxCustomHeaderValueCharacters = 4_096;

export const providerSourceValues = ["builtin", "custom"] as const;
export const providerSourceSchema = z.enum(providerSourceValues);
export const customProviderApiValues = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
export const customProviderApiSchema = z.enum(customProviderApiValues);
export const thinkingLevelValues = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export const thinkingLevelSchema = z.enum(thinkingLevelValues);
export const providerAuthTypeValues = ["api_key", "oauth"] as const;
export const providerAuthTypeSchema = z.enum(providerAuthTypeValues);

export const providerIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a stable Provider ID.");
const providerDisplayNameSchema = z.string().trim().min(1).max(120);
const providerBaseUrlSchema = z.string().trim().url().max(2048);
const providerApiKeySchema = z.string().trim().min(1).max(4096);
const modelIdSchema = z.string().trim().min(1).max(200);
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

export const providerCredentialStatusSchema = z
	.object({
		configured: z.boolean(),
		type: providerAuthTypeSchema.optional(),
		label: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

export const providerModelSchema = z
	.object({
		id: modelIdSchema,
		enabled: z.boolean(),
		displayName: z.string().trim().min(1).max(200),
		api: z.string().trim().min(1).max(100),
		input: z
			.array(z.enum(["text", "image"]))
			.min(1)
			.max(2),
		reasoning: z.boolean(),
		contextWindowTokens: tokenCountSchema,
		maxOutputTokens: tokenCountSchema,
		thinkingLevels: z.array(thinkingLevelSchema).max(thinkingLevelValues.length),
	})
	.strict();

export const providerSummarySchema = z
	.object({
		schemaVersion: z.literal(providerContractSchemaVersion),
		id: providerIdSchema,
		displayName: providerDisplayNameSchema,
		source: providerSourceSchema,
		enabled: z.boolean(),
		api: customProviderApiSchema.optional(),
		baseUrl: providerBaseUrlSchema.optional(),
		authMethods: z.array(providerAuthTypeSchema).max(2),
		credential: providerCredentialStatusSchema,
		customHeaderNames: z.array(customHeaderNameSchema).max(maxCustomHeaderCount),
		models: z.array(providerModelSchema).max(maxProviderModelCount),
		modelsFetchedAt: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

export const availableModelSchema = z
	.object({
		providerId: providerIdSchema,
		providerDisplayName: providerDisplayNameSchema,
		providerSource: providerSourceSchema,
		model: providerModelSchema,
	})
	.strict();

export const defaultModelSelectionSchema = z
	.object({
		providerId: providerIdSchema,
		modelId: modelIdSchema,
		thinkingLevel: thinkingLevelSchema.optional(),
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
		api: customProviderApiSchema,
		baseUrl: providerBaseUrlSchema,
		apiKey: providerApiKeySchema.optional(),
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
		api: customProviderApiSchema.optional(),
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

export const providerDraftSchema = createProviderInputSchema.omit({ schemaVersion: true });
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
	.strict();

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

export type ProviderSource = z.infer<typeof providerSourceSchema>;
export type CustomProviderApi = z.infer<typeof customProviderApiSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ProviderAuthType = z.infer<typeof providerAuthTypeSchema>;
export type CustomHeaders = z.infer<typeof customHeadersSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
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
