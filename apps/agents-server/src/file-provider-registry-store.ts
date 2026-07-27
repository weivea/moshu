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
	type CredentialStore,
	type CreateProviderRecordInput,
	type ModelRuntime,
	ProviderCapacityError,
	ProviderNotFoundError,
	type ProviderRecord,
	type ProviderRegistry,
	toProviderModel,
	type UpdateProviderRecordInput,
	InMemoryModelsStore,
} from "@moshu/agent-runtime";
import {
	type CustomProviderApi,
	customProviderApiSchema,
	type DefaultModelSelection,
	defaultModelSelectionSchema,
	maxProviderCount,
	maxProviderModelCount,
	type ProviderModel,
	providerModelSchema,
} from "@moshu/contracts";
import { createUuidV7 } from "@moshu/database";
import { z } from "zod";

export const providerRegistrySchemaVersion = 5 as const;

interface CustomProviderRecord {
	id: string;
	displayName: string;
	api: CustomProviderApi;
	baseUrl: string;
	enabled: boolean;
	customHeaderNames: string[];
	models: ProviderModel[];
	modelsFetchedAt?: string;
}

interface ProviderRegistryDocument {
	schemaVersion: typeof providerRegistrySchemaVersion;
	providers: CustomProviderRecord[];
	builtinPreferences: BuiltinProviderPreference[];
	defaultModel?: DefaultModelSelection;
}

interface BuiltinProviderPreference {
	id: string;
	enabled: boolean;
	enabledModelIds?: string[];
	modelsFetchedAt?: string;
}

const providerRegistryDocumentSchema = z
	.object({
		schemaVersion: z.literal(providerRegistrySchemaVersion),
		providers: z
			.array(
				z
					.object({
						id: z.string().min(1),
						displayName: z.string().min(1),
						api: customProviderApiSchema,
						baseUrl: z.string().url(),
						enabled: z.boolean(),
						customHeaderNames: z.array(z.string().min(1)).max(100),
						models: z.array(providerModelSchema),
						modelsFetchedAt: z.string().datetime().optional(),
					})
					.strict(),
			)
			.max(maxProviderCount),
		builtinPreferences: z
			.array(
				z
					.object({
						id: z.string().min(1),
						enabled: z.boolean(),
						enabledModelIds: z.array(z.string().min(1)).max(maxProviderModelCount).optional(),
						modelsFetchedAt: z.string().datetime().optional(),
					})
					.strict(),
			)
			.max(1_000),
		defaultModel: defaultModelSelectionSchema.optional(),
	})
	.strict();

export class FileProviderRegistryStore implements ProviderRegistry {
	#document: ProviderRegistryDocument;
	readonly #modelsStore = new InMemoryModelsStore();
	#mutationInFlight = false;
	#mutationTail = Promise.resolve();

	constructor(
		private readonly filename: string,
		private readonly modelRuntime: ModelRuntime,
		private readonly credentials: CredentialStore,
	) {
		if (filename.trim().length === 0) {
			throw new TypeError("A Provider configuration filename is required.");
		}
		this.#document = this.#read();
	}

	async initialize(): Promise<void> {
		for (const provider of this.#document.providers) {
			await this.#register(provider);
		}
	}

	list(): ProviderRecord[] {
		const customById = new Map(this.#document.providers.map((provider) => [provider.id, provider]));
		const builtinPreferences = new Map(
			this.#document.builtinPreferences.map((preference) => [preference.id, preference]),
		);
		return this.modelRuntime.getProviders().map((provider) => {
			const custom = customById.get(provider.id);
			const preference = builtinPreferences.get(provider.id);
			const auth = provider.auth;
			const status = this.modelRuntime.getProviderAuthStatus(provider.id);
			const modelsFetchedAt = custom?.modelsFetchedAt ?? preference?.modelsFetchedAt;
			return {
				id: provider.id,
				displayName: custom?.displayName ?? provider.name,
				source: custom === undefined ? "builtin" : "custom",
				...(custom === undefined ? {} : { api: custom.api, baseUrl: custom.baseUrl }),
				enabled: custom?.enabled ?? preference?.enabled ?? true,
				authMethods:
					custom === undefined
						? [
								...(auth.apiKey === undefined ? [] : (["api_key"] as const)),
								...(auth.oauth === undefined ? [] : (["oauth"] as const)),
							]
						: ["api_key"],
				credential: {
					configured: status.configured,
					...(status.configured
						? {
								type:
									custom === undefined && this.modelRuntime.isUsingOAuth(provider.id)
										? ("oauth" as const)
										: ("api_key" as const),
							}
						: {}),
					...(status.label === undefined ? {} : { label: status.label }),
				},
				customHeaderNames: [...(custom?.customHeaderNames ?? [])],
				models: this.modelRuntime.getModels(provider.id).map((model) => ({
					...toProviderModel(model),
					enabled:
						custom?.models.find((candidate) => candidate.id === model.id)?.enabled ??
						(preference?.enabledModelIds === undefined
							? true
							: preference.enabledModelIds.includes(model.id)),
				})),
				...(modelsFetchedAt === undefined ? {} : { modelsFetchedAt }),
			};
		});
	}

	get(providerId: string): ProviderRecord | null {
		return this.list().find((provider) => provider.id === providerId) ?? null;
	}

	async create(input: CreateProviderRecordInput): Promise<ProviderRecord> {
		return this.#mutate(() => this.#create(input));
	}

	async #create(input: CreateProviderRecordInput): Promise<ProviderRecord> {
		if (this.#document.providers.length >= maxProviderCount) {
			throw new ProviderCapacityError(maxProviderCount);
		}
		const record: CustomProviderRecord = {
			id: createUuidV7(),
			displayName: requireText(input.displayName, "displayName"),
			api: input.api,
			baseUrl: normalizeUrl(input.baseUrl),
			enabled: true,
			customHeaderNames: Object.keys(input.customHeaders ?? {}).sort(),
			models: (input.models ?? []).map((model) => providerModelSchema.parse(model)),
		};
		try {
			await this.#storeSecrets(record.id, input.apiKey, input.customHeaders);
			this.#document.providers.push(record);
			await this.#register(record);
			this.#write();
		} catch (error) {
			this.#document.providers = this.#document.providers.filter(
				(provider) => provider.id !== record.id,
			);
			this.modelRuntime.unregisterProvider(record.id);
			await this.credentials.delete(record.id);
			throw error;
		}
		return this.#require(record.id);
	}

	async update(input: UpdateProviderRecordInput): Promise<ProviderRecord> {
		return this.#mutate(() => this.#update(input));
	}

	async #update(input: UpdateProviderRecordInput): Promise<ProviderRecord> {
		const before = structuredClone(this.#document);
		const current = this.#require(input.providerId);
		if (current.source === "builtin") {
			if (
				input.displayName !== undefined ||
				input.api !== undefined ||
				input.baseUrl !== undefined ||
				input.apiKey !== undefined ||
				input.customHeaders !== undefined
			) {
				throw new TypeError("Built-in Provider identity and endpoint configuration are read-only.");
			}
			const preference = this.#builtinPreference(input.providerId);
			if (input.enabled !== undefined) {
				preference.enabled = input.enabled;
				if (!input.enabled && this.#document.defaultModel?.providerId === input.providerId) {
					delete this.#document.defaultModel;
				}
			}
			try {
				this.#write();
			} catch (error) {
				this.#document = before;
				throw error;
			}
			return this.#require(input.providerId);
		}
		const record = this.#requireCustom(input.providerId);
		const previousCredential = await this.credentials.read(record.id);
		if (input.displayName !== undefined)
			record.displayName = requireText(input.displayName, "displayName");
		if (input.api !== undefined) record.api = input.api;
		if (input.baseUrl !== undefined) record.baseUrl = normalizeUrl(input.baseUrl);
		if (input.enabled !== undefined) record.enabled = input.enabled;
		if (input.customHeaders !== undefined) {
			record.customHeaderNames = Object.keys(input.customHeaders).sort();
		}
		try {
			if (input.apiKey !== undefined || input.customHeaders !== undefined) {
				await this.#storeSecrets(record.id, input.apiKey, input.customHeaders);
			}
			await this.#register(record);
			this.#clearInvalidDefault();
			this.#write();
		} catch (error) {
			this.#document = before;
			await this.#restoreCredential(record.id, previousCredential);
			await this.#register(this.#requireCustom(record.id));
			throw error;
		}
		return this.#require(record.id);
	}

	async delete(providerId: string): Promise<void> {
		return this.#mutate(() => this.#delete(providerId));
	}

	async #delete(providerId: string): Promise<void> {
		const before = structuredClone(this.#document);
		const previousCredential = await this.credentials.read(providerId);
		const index = this.#document.providers.findIndex((provider) => provider.id === providerId);
		if (index < 0) throw new ProviderNotFoundError(providerId);
		const record = this.#document.providers[index];
		if (record === undefined) throw new ProviderNotFoundError(providerId);
		const previousRecord = structuredClone(record);
		this.#document.providers.splice(index, 1);
		try {
			this.modelRuntime.unregisterProvider(providerId);
			await this.credentials.delete(providerId);
			if (this.#document.defaultModel?.providerId === providerId) {
				delete this.#document.defaultModel;
			}
			this.#write();
		} catch (error) {
			this.#document = before;
			await this.#restoreCredential(providerId, previousCredential);
			await this.#register(previousRecord);
			throw error;
		}
	}

	async refreshModels(providerId: string): Promise<ProviderRecord> {
		return this.#mutate(() => this.#refreshModels(providerId));
	}

	async #refreshModels(providerId: string): Promise<ProviderRecord> {
		const provider = this.modelRuntime.getProvider(providerId);
		if (provider === undefined) {
			throw new ProviderNotFoundError(providerId);
		}
		if (provider.refreshModels !== undefined) {
			const credential = await this.credentials.read(providerId);
			await provider.refreshModels({
				...(credential === undefined ? {} : { credential }),
				store: {
					read: () => this.#modelsStore.read(providerId),
					write: (entry) => this.#modelsStore.write(providerId, entry),
					delete: () => this.#modelsStore.delete(providerId),
				},
				allowNetwork: true,
				force: true,
			});
		}
		const record = this.#document.providers.find((candidate) => candidate.id === providerId);
		const fetchedAt = new Date().toISOString();
		if (record === undefined) {
			this.#builtinPreference(providerId).modelsFetchedAt = fetchedAt;
		} else {
			record.models = this.modelRuntime.getModels(providerId).map((model) => ({
				...toProviderModel(model),
				enabled: record.models.find((candidate) => candidate.id === model.id)?.enabled ?? true,
			}));
			record.modelsFetchedAt = fetchedAt;
		}
		this.#clearInvalidDefault();
		this.#write();
		return this.#require(providerId);
	}

	async setModels(
		providerId: string,
		models: ProviderModel[],
		fetchedAt: string,
	): Promise<ProviderRecord> {
		return this.#mutate(() => this.#setModels(providerId, models, fetchedAt));
	}

	async #setModels(
		providerId: string,
		models: ProviderModel[],
		fetchedAt: string,
	): Promise<ProviderRecord> {
		const record = this.#requireCustom(providerId);
		const enabled = new Set(
			record.models.filter((model) => model.enabled).map((model) => model.id),
		);
		record.models = models.slice(0, maxProviderModelCount).map((model) =>
			providerModelSchema.parse({
				...model,
				enabled: record.models.length === 0 || enabled.has(model.id),
			}),
		);
		record.modelsFetchedAt = fetchedAt;
		if (
			this.#document.defaultModel?.providerId === providerId &&
			!record.models.some(
				(model) => model.id === this.#document.defaultModel?.modelId && model.enabled,
			)
		) {
			delete this.#document.defaultModel;
		}
		await this.#register(record);
		this.#write();
		return this.#require(providerId);
	}

	setModelsEnabled(providerId: string, enabledModelIds: readonly string[]): ProviderRecord {
		this.#assertNoMutation();
		const provider = this.#require(providerId);
		const enabled = new Set(enabledModelIds);
		if (provider.source === "builtin") {
			const known = new Set(provider.models.map((model) => model.id));
			this.#builtinPreference(providerId).enabledModelIds = [...enabled].filter((id) =>
				known.has(id),
			);
		} else {
			const record = this.#requireCustom(providerId);
			record.models = record.models.map((model) => ({ ...model, enabled: enabled.has(model.id) }));
		}
		if (
			this.#document.defaultModel?.providerId === providerId &&
			!enabled.has(this.#document.defaultModel.modelId)
		) {
			delete this.#document.defaultModel;
		}
		this.#write();
		return this.#require(providerId);
	}

	getDefaultModel(): DefaultModelSelection | null {
		return this.#document.defaultModel === undefined
			? null
			: structuredClone(this.#document.defaultModel);
	}

	setDefaultModel(selection: DefaultModelSelection | null): DefaultModelSelection | null {
		this.#assertNoMutation();
		if (selection === null) {
			delete this.#document.defaultModel;
		} else {
			const provider = this.#require(selection.providerId);
			const model = provider.models.find((candidate) => candidate.id === selection.modelId);
			if (
				!provider.enabled ||
				model === undefined ||
				!model.enabled ||
				(selection.thinkingLevel !== undefined &&
					!model.thinkingLevels.includes(selection.thinkingLevel))
			) {
				throw new ProviderNotFoundError(selection.providerId);
			}
			this.#document.defaultModel = structuredClone(selection);
		}
		this.#write();
		return selection === null ? null : structuredClone(selection);
	}

	async #register(record: CustomProviderRecord): Promise<void> {
		const credential = await this.credentials.read(record.id);
		const headers = credential?.type === "api_key" ? credential.env : undefined;
		this.modelRuntime.unregisterProvider(record.id);
		this.modelRuntime.registerProvider(record.id, {
			name: record.displayName,
			api: record.api,
			baseUrl: record.baseUrl,
			...(headers === undefined ? {} : { headers }),
			models: record.models.map((model) => ({
				id: model.id,
				name: model.displayName,
				api: record.api,
				reasoning: model.reasoning,
				input: [...model.input],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindowTokens,
				maxTokens: model.maxOutputTokens,
			})),
			refreshModels: async (context) => {
				if (!context.allowNetwork) {
					return record.models.map((model) => toPiModelConfig(record, model));
				}
				const credential = context.credential;
				const key = credential?.type === "api_key" ? credential.key : undefined;
				const headers =
					credential?.type === "api_key" && credential.env !== undefined ? credential.env : {};
				const endpoint = `${record.baseUrl.replace(/\/+$/, "")}/models`;
				const url =
					record.api === "google-generative-ai" && key !== undefined
						? `${endpoint}?key=${encodeURIComponent(key)}`
						: endpoint;
				const response = await fetch(url, {
					headers: {
						accept: "application/json",
						...(key === undefined || record.api === "google-generative-ai"
							? {}
							: record.api === "anthropic-messages"
								? { "x-api-key": key, "anthropic-version": "2023-06-01" }
								: { authorization: ["Bearer", key].join(" ") }),
						...headers,
					},
					...(context.signal === undefined ? {} : { signal: context.signal }),
				});
				if (!response.ok) {
					throw new Error(`Custom Provider model discovery failed with status ${response.status}.`);
				}
				const payload: unknown = await response.json();
				return parseModelIds(payload).map((id) =>
					toPiModelConfig(record, {
						id,
						displayName: id,
						api: record.api,
						input: ["text"],
						reasoning: false,
						contextWindowTokens: 128_000,
						maxOutputTokens: 8_192,
						thinkingLevels: ["off"],
						enabled: true,
					}),
				);
			},
		});
		await this.modelRuntime.refresh({ allowNetwork: false });
	}

	async #storeSecrets(
		providerId: string,
		apiKey?: string,
		headers?: Record<string, string>,
	): Promise<void> {
		if (apiKey !== undefined && apiKey.trim().length === 0) {
			throw new TypeError("API key must not be empty.");
		}
		const current = await this.credentials.read(providerId);
		if (
			current === undefined &&
			apiKey === undefined &&
			(headers === undefined || Object.keys(headers).length === 0)
		) {
			return;
		}
		await this.credentials.modify(providerId, async (current) => ({
			type: "api_key",
			...(apiKey === undefined
				? current?.type === "api_key" && current.key !== undefined
					? { key: current.key }
					: {}
				: { key: apiKey }),
			...(headers === undefined
				? current?.type === "api_key" && current.env !== undefined
					? { env: current.env }
					: {}
				: { env: { ...headers } }),
		}));
	}

	async #restoreCredential(
		providerId: string,
		credential: Awaited<ReturnType<CredentialStore["read"]>>,
	): Promise<void> {
		if (credential === undefined) {
			await this.credentials.delete(providerId);
			return;
		}
		await this.credentials.modify(providerId, async () => credential);
	}

	async onCredentialChanged(providerId: string): Promise<void> {
		await this.#mutate(async () => {
			const record = this.#document.providers.find((provider) => provider.id === providerId);
			if (record !== undefined) {
				await this.#register(record);
			}
		});
	}

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		const gate = Promise.withResolvers<void>();
		const previous = this.#mutationTail;
		this.#mutationTail = gate.promise;
		await previous;
		this.#mutationInFlight = true;
		try {
			return await operation();
		} finally {
			this.#mutationInFlight = false;
			gate.resolve();
		}
	}

	#assertNoMutation(): void {
		if (this.#mutationInFlight) {
			throw new Error("Another Provider configuration change is already in progress.");
		}
	}

	#builtinPreference(providerId: string): BuiltinProviderPreference {
		let preference = this.#document.builtinPreferences.find(
			(candidate) => candidate.id === providerId,
		);
		if (preference === undefined) {
			if (this.modelRuntime.getProvider(providerId) === undefined) {
				throw new ProviderNotFoundError(providerId);
			}
			preference = { id: providerId, enabled: true };
			this.#document.builtinPreferences.push(preference);
		}
		return preference;
	}

	#clearInvalidDefault(): void {
		const selection = this.#document.defaultModel;
		if (selection === undefined) return;
		const provider = this.get(selection.providerId);
		const model = provider?.models.find((candidate) => candidate.id === selection.modelId);
		if (
			provider === null ||
			!provider.enabled ||
			model === undefined ||
			!model.enabled ||
			(selection.thinkingLevel !== undefined &&
				!model.thinkingLevels.includes(selection.thinkingLevel))
		) {
			delete this.#document.defaultModel;
		}
	}

	#require(providerId: string): ProviderRecord {
		const record = this.get(providerId);
		if (record === null) throw new ProviderNotFoundError(providerId);
		return record;
	}

	#requireCustom(providerId: string): CustomProviderRecord {
		const record = this.#document.providers.find((provider) => provider.id === providerId);
		if (record === undefined) throw new ProviderNotFoundError(providerId);
		return record;
	}

	#read(): ProviderRegistryDocument {
		if (!existsSync(this.filename)) {
			return {
				schemaVersion: providerRegistrySchemaVersion,
				providers: [],
				builtinPreferences: [],
			};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.filename, "utf8"));
		} catch {
			throw new Error("The Provider configuration file is invalid.");
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("schemaVersion" in parsed) ||
			parsed.schemaVersion !== providerRegistrySchemaVersion
		) {
			return {
				schemaVersion: providerRegistrySchemaVersion,
				providers: [],
				builtinPreferences: [],
			};
		}
		const result = providerRegistryDocumentSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error("The Provider configuration file is invalid.");
		}
		chmodSync(this.filename, 0o600);
		return result.data as unknown as ProviderRegistryDocument;
	}

	#write(): void {
		const parent = dirname(this.filename);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		chmodSync(parent, 0o700);
		const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(this.#document, null, 2)}\n`, {
				mode: 0o600,
				flag: "w",
			});
			renameSync(temporary, this.filename);
			chmodSync(this.filename, 0o600);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}

function toPiModelConfig(record: CustomProviderRecord, model: ProviderModel) {
	return {
		id: model.id,
		name: model.displayName,
		api: record.api,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindowTokens,
		maxTokens: model.maxOutputTokens,
	};
}

function parseModelIds(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const record = payload as Record<string, unknown>;
	const values = Array.isArray(record.data)
		? record.data
		: Array.isArray(record.models)
			? record.models
			: [];
	return values.flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const candidate = value as Record<string, unknown>;
		const id = typeof candidate.id === "string" ? candidate.id : candidate.name;
		return typeof id === "string" && id.length > 0 ? [id.replace(/^models\//, "")] : [];
	});
}

function normalizeUrl(value: string): string {
	const normalized = requireText(value, "baseUrl").replace(/\/+$/, "");
	new URL(normalized);
	return normalized;
}

function requireText(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new TypeError(`${field} must not be empty.`);
	return normalized;
}
