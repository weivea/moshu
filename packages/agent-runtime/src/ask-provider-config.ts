export type AskProviderKind = "openai" | "openai-compatible";

export interface AskProviderConfigurationInput {
	provider: AskProviderKind;
	apiKey: string;
	model: string;
	baseUrl?: string;
	endpoint?: string;
}

export interface AskProviderConfiguration {
	provider: AskProviderKind;
	apiKey: string;
	model: string;
	baseUrl?: string;
}

export interface AskProviderConfigurationStatus {
	configured: boolean;
	baseUrl?: string;
	model?: string;
	apiKeyMask?: string;
}

export interface AskProviderConfigStore {
	set(configuration: AskProviderConfigurationInput): void;
	clear(): void;
	get(): AskProviderConfiguration | null;
	getStatus(): AskProviderConfigurationStatus;
}

export class InMemoryAskProviderConfigStore implements AskProviderConfigStore {
	#configuration: AskProviderConfiguration | null = null;

	set(configuration: AskProviderConfigurationInput): void {
		this.#configuration = normalizeAskProviderConfiguration(configuration);
	}

	clear(): void {
		this.#configuration = null;
	}

	get(): AskProviderConfiguration | null {
		if (this.#configuration === null) {
			return null;
		}

		return { ...this.#configuration };
	}

	getStatus(): AskProviderConfigurationStatus {
		return getAskProviderConfigurationStatus(this.#configuration);
	}
}

export function getAskProviderConfigurationStatus(
	configuration: AskProviderConfiguration | null,
): AskProviderConfigurationStatus {
	if (configuration === null) {
		return { configured: false };
	}

	return {
		configured: true,
		model: configuration.model,
		apiKeyMask: maskAskProviderApiKey(configuration.apiKey),
		...(configuration.baseUrl === undefined ? {} : { baseUrl: configuration.baseUrl }),
	};
}

export function maskAskProviderApiKey(apiKey: string): string {
	const normalized = requireNonEmptyString(apiKey, "apiKey");
	const visibleSuffix = normalized.length > 4 ? normalized.slice(-4) : "";
	return `${"•".repeat(8)}${visibleSuffix}`;
}

export function normalizeAskProviderConfiguration(
	configuration: AskProviderConfigurationInput,
): AskProviderConfiguration {
	const apiKey = requireNonEmptyString(configuration.apiKey, "apiKey");
	const model = requireNonEmptyString(configuration.model, "model");
	const baseUrl = normalizeBaseUrl(configuration.endpoint ?? configuration.baseUrl);

	if (configuration.provider === "openai-compatible" && baseUrl === undefined) {
		throw new TypeError("OpenAI-compatible provider configuration requires a baseUrl or endpoint.");
	}

	return {
		provider: configuration.provider,
		apiKey,
		model,
		...(baseUrl === undefined ? {} : { baseUrl }),
	};
}

function requireNonEmptyString(value: string, fieldName: string): string {
	const normalized = value.trim();

	if (normalized.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string.`);
	}

	return normalized;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : undefined;
}
