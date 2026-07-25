import {
	type AskProviderConfiguration,
	type AskProviderConfigurationInput,
	type AskProviderConfigurationStatus,
	type AskProviderConfigStore,
	getAskProviderConfigurationStatus,
	normalizeAskProviderConfiguration,
} from "@moshu/agent-runtime";
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

interface ProviderConfigDocument {
	schemaVersion: 1;
	configuration: AskProviderConfiguration;
}

export class FileAskProviderConfigStore implements AskProviderConfigStore {
	#configuration: AskProviderConfiguration | null;

	constructor(private readonly filename: string) {
		if (filename.trim().length === 0) {
			throw new TypeError("A Provider configuration filename is required.");
		}
		rmSync(this.#temporaryFilename(), { force: true });
		this.#configuration = this.#read();
	}

	set(configuration: AskProviderConfigurationInput): void {
		const normalized = normalizeAskProviderConfiguration(configuration);
		this.#write(normalized);
		this.#configuration = normalized;
	}

	clear(): void {
		rmSync(this.#temporaryFilename(), { force: true });
		rmSync(this.filename, { force: true });
		this.#configuration = null;
	}

	get(): AskProviderConfiguration | null {
		return this.#configuration === null ? null : { ...this.#configuration };
	}

	getStatus(): AskProviderConfigurationStatus {
		return getAskProviderConfigurationStatus(this.#configuration);
	}

	#read(): AskProviderConfiguration | null {
		if (!existsSync(this.filename)) {
			return null;
		}

		const document = parseProviderConfigDocument(
			JSON.parse(readFileSync(this.filename, "utf8")) as unknown,
		);
		chmodSync(this.filename, 0o600);
		return document.configuration;
	}

	#write(configuration: AskProviderConfiguration): void {
		mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
		const temporaryFilename = this.#temporaryFilename();
		const document: ProviderConfigDocument = {
			schemaVersion: 1,
			configuration,
		};

		try {
			writeFileSync(temporaryFilename, `${JSON.stringify(document, null, 2)}\n`, {
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

function parseProviderConfigDocument(value: unknown): ProviderConfigDocument {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.configuration)) {
		throw new TypeError("Provider configuration file has an unsupported format.");
	}

	const configuration = value.configuration;
	const provider = configuration.provider;
	if (provider !== "openai" && provider !== "openai-compatible") {
		throw new TypeError("Provider configuration file contains an unsupported Provider.");
	}
	if (typeof configuration.apiKey !== "string" || typeof configuration.model !== "string") {
		throw new TypeError("Provider configuration file is missing required fields.");
	}
	if (configuration.baseUrl !== undefined && typeof configuration.baseUrl !== "string") {
		throw new TypeError("Provider configuration file contains an invalid base URL.");
	}

	return {
		schemaVersion: 1,
		configuration: normalizeAskProviderConfiguration({
			provider,
			apiKey: configuration.apiKey,
			model: configuration.model,
			baseUrl: configuration.baseUrl,
		}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
