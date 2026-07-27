import type {
	AvailableModel,
	CreateProviderInput,
	DefaultModelSelection,
	ProviderModel,
	ProviderAuthAttempt,
	ProviderAuthType,
	SessionModelSelection,
	TestProviderInput,
	UpdateProviderInput,
} from "@moshu/contracts";

import type { ProviderConnectionTestResult, ProviderSummary } from "./transport";

export const testProviderId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5aa";

export const testProviderModel: ProviderModel = {
	id: "gpt-5.4",
	enabled: true,
	displayName: "GPT-5.4",
	api: "openai-responses",
	input: ["text"],
	reasoning: true,
	contextWindowTokens: 272_000,
	maxOutputTokens: 128_000,
	thinkingLevels: ["off", "low", "medium", "high"],
};

export const testAvailableModel: AvailableModel = {
	providerId: testProviderId,
	providerDisplayName: "Test provider",
	providerSource: "custom",
	model: testProviderModel,
};

export const testDefaultModel: DefaultModelSelection = {
	providerId: testProviderId,
	modelId: testProviderModel.id,
};

/** Builds an available model backed by the shared test provider for a specific model id. */
export function availableModelFor(modelId: string): AvailableModel {
	return {
		...structuredClone(testAvailableModel),
		model: { ...structuredClone(testProviderModel), id: modelId, displayName: modelId },
	};
}

/** Builds a session/default model selection pointing at the shared test provider. */
export function modelSelectionFor(modelId: string): SessionModelSelection {
	return { providerId: testProviderId, modelId };
}

export interface ProviderModelTransportOptions {
	models?: AvailableModel[];
	defaultModel?: DefaultModelSelection | null;
}

/**
 * Shared, in-memory implementation of the provider and model members of `ChatTransport`.
 * Test fakes extend this base and add their chat-specific overrides so the composer renders as
 * "configured" by default (one available model plus a matching default selection).
 */
export class ProviderModelTransportDefaults {
	availableModels: AvailableModel[];
	sessionDefaultModel: DefaultModelSelection | undefined;
	nextListAvailableModelsError: Error | null = null;

	constructor(options: ProviderModelTransportOptions = {}) {
		this.availableModels = options.models ?? [structuredClone(testAvailableModel)];
		this.sessionDefaultModel =
			options.defaultModel === null
				? undefined
				: (options.defaultModel ??
					(this.availableModels.length > 0 ? { ...testDefaultModel } : undefined));
	}

	async listProviders(): Promise<ProviderSummary[]> {
		return [];
	}

	async createProvider(_input: CreateProviderInput): Promise<ProviderSummary> {
		throw new Error("createProvider is not implemented in this test transport.");
	}

	async updateProvider(_input: UpdateProviderInput): Promise<ProviderSummary> {
		throw new Error("updateProvider is not implemented in this test transport.");
	}

	async deleteProvider(_providerId: string): Promise<void> {}

	async testProvider(_input: TestProviderInput): Promise<ProviderConnectionTestResult> {
		return { ok: true, latencyMs: 1 };
	}

	async fetchProviderModels(_providerId: string): Promise<ProviderSummary> {
		throw new Error("fetchProviderModels is not implemented in this test transport.");
	}

	async setProviderModelsEnabled(
		_providerId: string,
		_enabledModelIds: string[],
	): Promise<ProviderSummary> {
		throw new Error("setProviderModelsEnabled is not implemented in this test transport.");
	}

	async startProviderAuth(
		_providerId: string,
		_authType: ProviderAuthType,
	): Promise<ProviderAuthAttempt> {
		throw new Error("startProviderAuth is not implemented in this test transport.");
	}

	async getProviderAuth(_attemptId: string): Promise<ProviderAuthAttempt> {
		throw new Error("getProviderAuth is not implemented in this test transport.");
	}

	async respondProviderAuth(
		_attemptId: string,
		_challengeId: string,
		_value: string,
	): Promise<ProviderAuthAttempt> {
		throw new Error("respondProviderAuth is not implemented in this test transport.");
	}

	async cancelProviderAuth(_attemptId: string): Promise<ProviderAuthAttempt> {
		throw new Error("cancelProviderAuth is not implemented in this test transport.");
	}

	async logoutProvider(_providerId: string): Promise<void> {}

	async openExternalUrl(_url: string): Promise<void> {}

	async listAvailableModels(): Promise<{
		models: AvailableModel[];
		defaultModel?: DefaultModelSelection;
	}> {
		if (this.nextListAvailableModelsError !== null) {
			const error = this.nextListAvailableModelsError;
			this.nextListAvailableModelsError = null;
			throw error;
		}
		return {
			models: this.availableModels.map((model) => structuredClone(model)),
			...(this.sessionDefaultModel === undefined
				? {}
				: { defaultModel: { ...this.sessionDefaultModel } }),
		};
	}

	async getDefaultModel(): Promise<DefaultModelSelection | undefined> {
		return this.sessionDefaultModel === undefined ? undefined : { ...this.sessionDefaultModel };
	}

	async setDefaultModel(
		selection: DefaultModelSelection | null,
	): Promise<DefaultModelSelection | undefined> {
		this.sessionDefaultModel = selection ?? undefined;
		return this.sessionDefaultModel === undefined ? undefined : { ...this.sessionDefaultModel };
	}

	async setSessionModel(
		_sessionId: string,
		selection: SessionModelSelection | null,
	): Promise<SessionModelSelection | undefined> {
		return selection ?? undefined;
	}
}
