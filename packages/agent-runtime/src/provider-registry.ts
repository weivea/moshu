import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	CustomProviderApi,
	DefaultModelSelection,
	ProviderModel,
	ProviderSummary,
	ThinkingLevel,
} from "@moshu/contracts";

export interface ProviderRecord {
	id: string;
	displayName: string;
	source: "builtin" | "custom";
	api?: CustomProviderApi;
	baseUrl?: string;
	enabled: boolean;
	authMethods: Array<"api_key" | "oauth">;
	credential: ProviderSummary["credential"];
	customHeaderNames: string[];
	models: ProviderModel[];
	modelsFetchedAt?: string;
}

export interface CreateProviderRecordInput {
	displayName: string;
	api: CustomProviderApi;
	baseUrl: string;
	apiKey?: string;
	customHeaders?: Record<string, string>;
	models?: ProviderModel[];
}

export interface UpdateProviderRecordInput {
	providerId: string;
	displayName?: string;
	api?: CustomProviderApi;
	baseUrl?: string;
	apiKey?: string;
	customHeaders?: Record<string, string>;
	enabled?: boolean;
}

export interface ResolvedProviderConfiguration {
	providerId: string;
	providerName: string;
	source: "builtin" | "custom";
	api: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ProviderRegistry {
	list(): ProviderRecord[];
	get(providerId: string): ProviderRecord | null;
	create(input: CreateProviderRecordInput): Promise<ProviderRecord>;
	update(input: UpdateProviderRecordInput): Promise<ProviderRecord>;
	delete(providerId: string): Promise<void>;
	refreshModels(providerId: string): Promise<ProviderRecord>;
	setModels(
		providerId: string,
		models: ProviderModel[],
		fetchedAt: string,
	): Promise<ProviderRecord>;
	setModelsEnabled(providerId: string, enabledModelIds: readonly string[]): ProviderRecord;
	getDefaultModel(): DefaultModelSelection | null;
	setDefaultModel(selection: DefaultModelSelection | null): DefaultModelSelection | null;
}

export class ProviderNotFoundError extends Error {
	constructor(readonly providerId: string) {
		super(`Provider ${providerId} was not found.`);
		this.name = "ProviderNotFoundError";
	}
}

export class ProviderModelNotFoundError extends Error {
	constructor(
		readonly providerId: string,
		readonly modelId: string,
	) {
		super(`Model ${modelId} was not found on provider ${providerId}.`);
		this.name = "ProviderModelNotFoundError";
	}
}

export class ProviderCapacityError extends Error {
	constructor(limit: number) {
		super(`At most ${limit} custom providers can be configured.`);
		this.name = "ProviderCapacityError";
	}
}

export function listProviderSummaries(
	modelRuntime: ModelRuntime,
	customProviders: readonly ProviderRecord[],
): ProviderSummary[] {
	const customById = new Map(customProviders.map((provider) => [provider.id, provider]));
	return modelRuntime.getProviders().map((provider) => {
		const custom = customById.get(provider.id);
		return {
			schemaVersion: 2,
			id: provider.id,
			displayName: custom?.displayName ?? provider.name,
			source: custom === undefined ? "builtin" : "custom",
			enabled: custom?.enabled ?? true,
			authMethods: toAuthMethods(modelRuntime, provider.id),
			credential: toCredentialStatus(modelRuntime, provider.id),
			customHeaderNames: [],
			models: modelRuntime.getModels(provider.id).map(toProviderModel),
		};
	});
}

export function toProviderSummary(record: ProviderRecord): ProviderSummary {
	return {
		schemaVersion: 2,
		id: record.id,
		displayName: record.displayName,
		source: record.source,
		enabled: record.enabled,
		...(record.api === undefined ? {} : { api: record.api }),
		...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
		authMethods: [...record.authMethods],
		credential: { ...record.credential },
		customHeaderNames: [...record.customHeaderNames],
		models: record.models.map((model) => ({ ...model })),
		...(record.modelsFetchedAt === undefined ? {} : { modelsFetchedAt: record.modelsFetchedAt }),
	};
}

export function resolveProviderConfiguration(input: {
	modelRuntime: ModelRuntime;
	providerId: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}): ResolvedProviderConfiguration {
	const provider = input.modelRuntime.getProvider(input.providerId);
	if (provider === undefined) {
		throw new ProviderNotFoundError(input.providerId);
	}
	const model = input.modelRuntime.getModel(input.providerId, input.modelId);
	if (model === undefined) {
		throw new ProviderModelNotFoundError(input.providerId, input.modelId);
	}
	return {
		providerId: provider.id,
		providerName: provider.name,
		source: input.modelRuntime.getRegisteredProviderIds().includes(provider.id)
			? "custom"
			: "builtin",
		api: model.api,
		model: model.id,
		...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
	};
}

function toAuthMethods(runtime: ModelRuntime, providerId: string): ProviderSummary["authMethods"] {
	const auth = runtime.getProvider(providerId)?.auth;
	return [
		...(auth?.apiKey === undefined ? [] : (["api_key"] as const)),
		...(auth?.oauth === undefined ? [] : (["oauth"] as const)),
	];
}

function toCredentialStatus(
	runtime: ModelRuntime,
	providerId: string,
): ProviderSummary["credential"] {
	const status = runtime.getProviderAuthStatus(providerId);
	return {
		configured: status.configured,
		...(status.configured
			? { type: runtime.isUsingOAuth(providerId) ? ("oauth" as const) : ("api_key" as const) }
			: {}),
		...(status.label === undefined ? {} : { label: status.label }),
	};
}

export function toProviderModel(
	model: ReturnType<ModelRuntime["getModels"]>[number],
): ProviderModel {
	return {
		id: model.id,
		displayName: model.name,
		api: model.api,
		input: [...model.input],
		reasoning: model.reasoning,
		contextWindowTokens: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		thinkingLevels: [...getSupportedThinkingLevels(model)],
		enabled: true,
	};
}
