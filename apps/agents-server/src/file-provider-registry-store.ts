import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
	type CreateProviderRecordInput,
	normalizeCustomHeaders,
	normalizeProviderBaseUrl,
	ProviderCapacityError,
	ProviderNotFoundError,
	type ProviderRecord,
	type ProviderRegistry,
	requireNonEmptyString,
	type UpdateProviderRecordInput,
} from "@moshu/agent-runtime";
import {
	type CustomHeaders,
	type DefaultModelSelection,
	maxProviderCount,
	maxProviderModelCount,
	type ProviderModel,
	type ProviderType,
	providerModelSchema,
	providerTypeValues,
} from "@moshu/contracts";
import { createUuidV7 } from "@moshu/database";

export const providerRegistrySchemaVersion = 3 as const;

interface ProviderRegistryDocument {
	schemaVersion: typeof providerRegistrySchemaVersion;
	providers: ProviderRecord[];
	defaultModel?: DefaultModelSelection;
}

/**
 * Owner-only JSON registry of every configured Provider. Secrets stay in this file and never
 * reach the product database, RPC responses or logs.
 */
export class FileProviderRegistryStore implements ProviderRegistry {
	#document: ProviderRegistryDocument;

	constructor(private readonly filename: string) {
		if (filename.trim().length === 0) {
			throw new TypeError("A Provider configuration filename is required.");
		}
		rmSync(this.#temporaryFilename(), { force: true });
		const { document, migrated } = this.#read();
		this.#document = document;
		if (migrated) {
			this.#write();
		}
	}

	list(): ProviderRecord[] {
		return this.#document.providers.map(cloneRecord);
	}

	get(providerId: string): ProviderRecord | null {
		const record = this.#find(providerId);
		return record === undefined ? null : cloneRecord(record);
	}

	create(input: CreateProviderRecordInput): ProviderRecord {
		if (this.#document.providers.length >= maxProviderCount) {
			throw new ProviderCapacityError(maxProviderCount);
		}
		const record: ProviderRecord = {
			id: createUuidV7(),
			displayName: requireNonEmptyString(input.displayName, "displayName"),
			type: assertProviderType(input.type),
			baseUrl: normalizeProviderBaseUrl(input.baseUrl),
			apiKey: requireNonEmptyString(input.apiKey, "apiKey"),
			enabled: true,
			models: [],
		};
		const customHeaders = normalizeCustomHeaders(input.customHeaders);
		if (customHeaders !== undefined) {
			record.customHeaders = customHeaders;
		}

		this.#document.providers.push(record);
		this.#write();
		return cloneRecord(record);
	}

	update(input: UpdateProviderRecordInput): ProviderRecord {
		const record = this.#require(input.providerId);
		if (input.displayName !== undefined) {
			record.displayName = requireNonEmptyString(input.displayName, "displayName");
		}
		if (input.type !== undefined) {
			record.type = assertProviderType(input.type);
		}
		if (input.baseUrl !== undefined) {
			record.baseUrl = normalizeProviderBaseUrl(input.baseUrl);
		}
		if (input.apiKey !== undefined) {
			record.apiKey = requireNonEmptyString(input.apiKey, "apiKey");
		}
		if (input.customHeaders !== undefined) {
			const customHeaders = normalizeCustomHeaders(input.customHeaders);
			if (customHeaders === undefined) {
				delete record.customHeaders;
			} else {
				record.customHeaders = customHeaders;
			}
		}
		if (input.enabled !== undefined) {
			record.enabled = input.enabled;
		}

		this.#write();
		return cloneRecord(record);
	}

	delete(providerId: string): void {
		const index = this.#document.providers.findIndex((provider) => provider.id === providerId);
		if (index < 0) {
			throw new ProviderNotFoundError(providerId);
		}
		this.#document.providers.splice(index, 1);
		if (this.#document.defaultModel?.providerId === providerId) {
			delete this.#document.defaultModel;
		}
		this.#write();
	}

	setModels(providerId: string, models: ProviderModel[], fetchedAt: string): ProviderRecord {
		const record = this.#require(providerId);
		const previouslyEnabled = new Set(
			record.models.filter((model) => model.enabled).map((model) => model.id),
		);
		// Validate before writing so the file can always be read back.
		record.models = models
			.slice(0, maxProviderModelCount)
			.map((model) =>
				providerModelSchema.safeParse({ ...model, enabled: previouslyEnabled.has(model.id) }),
			)
			.flatMap((result) => (result.success ? [result.data] : []));
		record.modelsFetchedAt = fetchedAt;
		this.#pruneDefaultModel();
		this.#write();
		return cloneRecord(record);
	}

	setModelsEnabled(providerId: string, enabledModelIds: readonly string[]): ProviderRecord {
		const record = this.#require(providerId);
		const enabled = new Set(enabledModelIds);
		record.models = record.models.map((model) => ({ ...model, enabled: enabled.has(model.id) }));
		this.#pruneDefaultModel();
		this.#write();
		return cloneRecord(record);
	}

	getDefaultModel(): DefaultModelSelection | null {
		const selection = this.#document.defaultModel;
		return selection === undefined ? null : structuredClone(selection);
	}

	setDefaultModel(selection: DefaultModelSelection | null): DefaultModelSelection | null {
		if (selection === null) {
			delete this.#document.defaultModel;
			this.#write();
			return null;
		}

		const record = this.#require(selection.providerId);
		if (!record.models.some((model) => model.id === selection.modelId)) {
			throw new ProviderNotFoundError(selection.providerId);
		}
		this.#document.defaultModel = structuredClone(selection);
		this.#write();
		return structuredClone(selection);
	}

	#pruneDefaultModel(): void {
		const selection = this.#document.defaultModel;
		if (selection === undefined) {
			return;
		}
		const record = this.#find(selection.providerId);
		const model = record?.models.find((candidate) => candidate.id === selection.modelId);
		if (record === undefined || model === undefined || !model.enabled) {
			delete this.#document.defaultModel;
		}
	}

	#find(providerId: string): ProviderRecord | undefined {
		return this.#document.providers.find((provider) => provider.id === providerId);
	}

	#require(providerId: string): ProviderRecord {
		const record = this.#find(providerId);
		if (record === undefined) {
			throw new ProviderNotFoundError(providerId);
		}
		return record;
	}

	#read(): { document: ProviderRegistryDocument; migrated: boolean } {
		if (!existsSync(this.filename)) {
			return {
				document: { schemaVersion: providerRegistrySchemaVersion, providers: [] },
				migrated: false,
			};
		}

		const raw = JSON.parse(readFileSync(this.filename, "utf8")) as unknown;
		chmodSync(this.filename, 0o600);
		if (!isRecord(raw)) {
			throw new TypeError("Provider configuration file has an unsupported format.");
		}
		if (raw.schemaVersion === 1) {
			return { document: migrateLegacyDocument(raw), migrated: true };
		}
		if (raw.schemaVersion === 2) {
			return { document: migrateVersion2Document(raw), migrated: true };
		}
		if (raw.schemaVersion !== providerRegistrySchemaVersion) {
			throw new TypeError("Provider configuration file has an unsupported format.");
		}

		return { document: parseRegistryDocument(raw), migrated: false };
	}

	#write(): void {
		mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
		const temporaryFilename = this.#temporaryFilename();

		try {
			writeFileSync(temporaryFilename, `${JSON.stringify(this.#document, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			chmodSync(temporaryFilename, 0o600);
			renameSync(temporaryFilename, this.filename);
			chmodSync(this.filename, 0o600);
		} catch (error) {
			rmSync(temporaryFilename, { force: true });
			throw error;
		}
	}

	#temporaryFilename(): string {
		return `${this.filename}.tmp`;
	}
}

/** Carries the single pre-multi-provider configuration forward as one Provider entry. */
function migrateLegacyDocument(raw: Record<string, unknown>): ProviderRegistryDocument {
	const configuration = raw.configuration;
	if (
		!isRecord(configuration) ||
		typeof configuration.apiKey !== "string" ||
		typeof configuration.model !== "string"
	) {
		throw new TypeError("Provider configuration file is missing required fields.");
	}
	const baseUrl =
		typeof configuration.baseUrl === "string" && configuration.baseUrl.trim().length > 0
			? normalizeProviderBaseUrl(configuration.baseUrl)
			: "https://api.openai.com/v1";
	const providerId = createUuidV7();
	const modelId = configuration.model.trim();

	return {
		schemaVersion: providerRegistrySchemaVersion,
		providers: [
			{
				id: providerId,
				displayName: readHostLabel(baseUrl),
				type: "openai-compatible",
				baseUrl,
				apiKey: configuration.apiKey.trim(),
				enabled: true,
				models: modelId.length === 0 ? [] : [{ id: modelId, enabled: true }],
			},
		],
		...(modelId.length === 0 ? {} : { defaultModel: { providerId, modelId } }),
	};
}

/**
 * Collapses the three protocol-shaped v2 Provider types into two compatibility families.
 * Models under a legacy Responses Provider retain that protocol until their catalog is fetched
 * again, while the other legacy types already match the new family defaults.
 */
function migrateVersion2Document(raw: Record<string, unknown>): ProviderRegistryDocument {
	if (!Array.isArray(raw.providers)) {
		throw new TypeError("Provider configuration file has an unsupported format.");
	}

	return parseRegistryDocument({
		...raw,
		schemaVersion: providerRegistrySchemaVersion,
		providers: raw.providers.map((provider) => migrateVersion2Provider(provider)),
	});
}

function migrateVersion2Provider(value: unknown): unknown {
	if (!isRecord(value)) {
		return value;
	}
	const legacyType = value.type;
	const type =
		legacyType === "openai-chat-completions" || legacyType === "openai-responses"
			? "openai-compatible"
			: legacyType === "anthropic-messages"
				? "anthropic-compatible"
				: legacyType;
	const models =
		legacyType === "openai-responses" && Array.isArray(value.models)
			? value.models.map((model) => preserveLegacyResponsesProtocol(model))
			: value.models;

	return { ...value, type, models };
}

function preserveLegacyResponsesProtocol(value: unknown): unknown {
	if (!isRecord(value) || value.supportedEndpoints !== undefined) {
		return value;
	}
	return { ...value, supportedEndpoints: ["/responses"] };
}

function parseRegistryDocument(raw: Record<string, unknown>): ProviderRegistryDocument {
	if (!Array.isArray(raw.providers)) {
		throw new TypeError("Provider configuration file has an unsupported format.");
	}
	const providers = raw.providers.slice(0, maxProviderCount).map(parseProviderRecord);
	const defaultModel = parseDefaultModel(raw.defaultModel, providers);

	return {
		schemaVersion: providerRegistrySchemaVersion,
		providers,
		...(defaultModel === undefined ? {} : { defaultModel }),
	};
}

function parseProviderRecord(value: unknown): ProviderRecord {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.displayName !== "string" ||
		typeof value.baseUrl !== "string" ||
		typeof value.apiKey !== "string"
	) {
		throw new TypeError("Provider configuration file contains an invalid Provider.");
	}

	const record: ProviderRecord = {
		id: value.id,
		displayName: requireNonEmptyString(value.displayName, "displayName"),
		type: assertProviderType(value.type),
		baseUrl: normalizeProviderBaseUrl(value.baseUrl),
		apiKey: requireNonEmptyString(value.apiKey, "apiKey"),
		enabled: value.enabled !== false,
		// A single unreadable catalog entry must not make the whole registry unopenable.
		models: Array.isArray(value.models)
			? value.models
					.slice(0, maxProviderModelCount)
					.map((model) => providerModelSchema.safeParse(model))
					.flatMap((result) => (result.success ? [result.data] : []))
			: [],
	};
	const customHeaders = normalizeCustomHeaders(parseCustomHeaders(value.customHeaders));
	if (customHeaders !== undefined) {
		record.customHeaders = customHeaders;
	}
	if (typeof value.modelsFetchedAt === "string") {
		record.modelsFetchedAt = value.modelsFetchedAt;
	}

	return record;
}

function parseCustomHeaders(value: unknown): CustomHeaders | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function parseDefaultModel(
	value: unknown,
	providers: readonly ProviderRecord[],
): DefaultModelSelection | undefined {
	if (
		!isRecord(value) ||
		typeof value.providerId !== "string" ||
		typeof value.modelId !== "string"
	) {
		return undefined;
	}
	const provider = providers.find((candidate) => candidate.id === value.providerId);
	if (provider === undefined || !provider.models.some((model) => model.id === value.modelId)) {
		return undefined;
	}

	const reasoning = isRecord(value.reasoning)
		? {
				...(typeof value.reasoning.effort === "string" ? { effort: value.reasoning.effort } : {}),
				...(typeof value.reasoning.budgetTokens === "number"
					? { budgetTokens: value.reasoning.budgetTokens }
					: {}),
			}
		: {};

	return {
		providerId: value.providerId,
		modelId: value.modelId,
		...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
	};
}

function assertProviderType(value: unknown): ProviderType {
	if (typeof value !== "string" || !providerTypeValues.includes(value as ProviderType)) {
		throw new TypeError("Provider configuration file contains an unsupported Provider type.");
	}
	return value as ProviderType;
}

function readHostLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return "OpenAI";
	}
}

function cloneRecord(record: ProviderRecord): ProviderRecord {
	return structuredClone(record);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
