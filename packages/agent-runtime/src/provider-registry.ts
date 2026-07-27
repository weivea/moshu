import type {
	CustomHeaders,
	DefaultModelSelection,
	ProviderModel,
	ProviderSummary,
	ProviderType,
	ReasoningSelection,
} from "@moshu/contracts";

import type { ModelProtocol } from "./model-catalog";

export interface ProviderRecord {
	id: string;
	displayName: string;
	type: ProviderType;
	baseUrl: string;
	apiKey: string;
	customHeaders?: CustomHeaders | undefined;
	enabled: boolean;
	models: ProviderModel[];
	modelsFetchedAt?: string | undefined;
}

export interface CreateProviderRecordInput {
	displayName: string;
	type: ProviderType;
	baseUrl: string;
	apiKey: string;
	customHeaders?: CustomHeaders | undefined;
}

export interface UpdateProviderRecordInput {
	providerId: string;
	displayName?: string | undefined;
	type?: ProviderType | undefined;
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
	customHeaders?: CustomHeaders | undefined;
	enabled?: boolean | undefined;
}

/**
 * A provider plus a concrete model, ready for the runtime to build a chat model from.
 * `reasoning` is already validated against the model's declared capability.
 */
export interface ResolvedProviderConfiguration {
	providerId: string;
	providerName: string;
	type: ProviderType;
	protocol: ModelProtocol;
	baseUrl: string;
	apiKey: string;
	customHeaders?: CustomHeaders | undefined;
	model: string;
	maxOutputTokens?: number | undefined;
	reasoning?: ReasoningSelection | undefined;
}

export interface ProviderRegistry {
	list(): ProviderRecord[];
	get(providerId: string): ProviderRecord | null;
	create(input: CreateProviderRecordInput): ProviderRecord;
	update(input: UpdateProviderRecordInput): ProviderRecord;
	delete(providerId: string): void;
	setModels(providerId: string, models: ProviderModel[], fetchedAt: string): ProviderRecord;
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
		super(`At most ${limit} providers can be configured.`);
		this.name = "ProviderCapacityError";
	}
}

export function maskProviderApiKey(apiKey: string): string {
	const normalized = requireNonEmptyString(apiKey, "apiKey");
	const visibleSuffix = normalized.length > 4 ? normalized.slice(-4) : "";
	return `${"•".repeat(8)}${visibleSuffix}`;
}

/** Projects a stored record into the client-facing summary, dropping every secret value. */
export function toProviderSummary(record: ProviderRecord): ProviderSummary {
	return {
		schemaVersion: 1,
		id: record.id,
		displayName: record.displayName,
		type: record.type,
		baseUrl: record.baseUrl,
		enabled: record.enabled,
		apiKeyMask: maskProviderApiKey(record.apiKey),
		customHeaderNames: Object.keys(record.customHeaders ?? {}).sort(),
		models: record.models.map((model) => ({ ...model })),
		...(record.modelsFetchedAt === undefined ? {} : { modelsFetchedAt: record.modelsFetchedAt }),
	};
}

export function normalizeProviderBaseUrl(value: string): string {
	const normalized = value.trim().replace(/\/+$/, "");
	if (normalized.length === 0) {
		throw new TypeError("baseUrl must be a non-empty string.");
	}
	return normalized;
}

export function normalizeCustomHeaders(
	headers: CustomHeaders | undefined,
): CustomHeaders | undefined {
	if (headers === undefined) {
		return undefined;
	}
	const entries = Object.entries(headers)
		.map(([name, value]) => [name.trim(), value] as const)
		.filter(([name]) => name.length > 0);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function requireNonEmptyString(value: string, fieldName: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string.`);
	}
	return normalized;
}
