import type {
	CreateProviderInput,
	ProviderModel,
	ProviderSummary,
	TestProviderInput,
	UpdateProviderInput,
} from "@moshu/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import type { ChatTransport, ProviderConnectionTestResult } from "../../chat/transport";
import { I18nProvider } from "../../i18n";
import { ProvidersSettingsPage } from "./providers-page";

const providerAId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5aa";
const providerBId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5bb";
const createdProviderId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5cc";

interface MakeProviderOptions {
	id: string;
	displayName?: string;
	api?: ProviderSummary["api"];
	baseUrl?: string;
	enabled?: boolean;
	apiKeyMask?: string;
	customHeaderNames?: string[];
	models?: ProviderModel[];
	modelsFetchedAt?: string;
	source?: ProviderSummary["source"];
}

function makeProvider(options: MakeProviderOptions): ProviderSummary {
	return {
		schemaVersion: 2,
		id: options.id,
		displayName: options.displayName ?? "OpenAI",
		source: options.source ?? "custom",
		api: options.api ?? "openai-responses",
		baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
		enabled: options.enabled ?? true,
		authMethods: ["api_key"],
		credential: {
			configured: options.apiKeyMask !== undefined,
			...(options.apiKeyMask === undefined ? {} : { type: "api_key" as const }),
		},
		customHeaderNames: options.customHeaderNames ?? [],
		models: options.models ?? [],
		...(options.modelsFetchedAt === undefined ? {} : { modelsFetchedAt: options.modelsFetchedAt }),
	};
}

function makeModel(
	id: string,
	displayName: string,
	enabled: boolean,
	overrides: Partial<ProviderModel> = {},
): ProviderModel {
	return {
		id,
		displayName,
		enabled,
		api: "openai-responses",
		input: ["text"],
		reasoning: false,
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		thinkingLevels: [],
		...overrides,
	};
}

class FakeProvidersTransport {
	readonly createInputs: CreateProviderInput[] = [];
	readonly updateInputs: UpdateProviderInput[] = [];
	readonly testInputs: TestProviderInput[] = [];
	readonly deletedIds: string[] = [];
	readonly fetchedIds: string[] = [];
	readonly setEnabledCalls: Array<{ providerId: string; enabledModelIds: string[] }> = [];
	fetchModelsResult: ProviderModel[] = [];
	#providers: ProviderSummary[];

	constructor(providers: ProviderSummary[]) {
		this.#providers = providers;
	}

	#find(providerId: string): ProviderSummary {
		const provider = this.#providers.find((candidate) => candidate.id === providerId);
		if (provider === undefined) {
			throw new Error(`Unknown provider ${providerId}.`);
		}
		return structuredClone(provider);
	}

	async listProviders(): Promise<ProviderSummary[]> {
		return this.#providers.map((provider) => structuredClone(provider));
	}

	async createProvider(input: CreateProviderInput): Promise<ProviderSummary> {
		this.createInputs.push(input);
		return makeProvider({
			id: createdProviderId,
			displayName: input.displayName,
			api: input.api,
			baseUrl: input.baseUrl,
			apiKeyMask: "****",
			customHeaderNames: Object.keys(input.customHeaders ?? {}),
		});
	}

	async updateProvider(input: UpdateProviderInput): Promise<ProviderSummary> {
		this.updateInputs.push(input);
		const provider = this.#find(input.providerId);
		return {
			...provider,
			...(input.displayName === undefined ? {} : { displayName: input.displayName }),
			...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
			...(input.enabled === undefined ? {} : { enabled: input.enabled }),
		};
	}

	async deleteProvider(providerId: string): Promise<void> {
		this.deletedIds.push(providerId);
		this.#providers = this.#providers.filter((provider) => provider.id !== providerId);
	}

	async testProvider(input: TestProviderInput): Promise<ProviderConnectionTestResult> {
		this.testInputs.push(input);
		return { ok: true, latencyMs: 5 };
	}

	async fetchProviderModels(providerId: string): Promise<ProviderSummary> {
		this.fetchedIds.push(providerId);
		return {
			...this.#find(providerId),
			models: structuredClone(this.fetchModelsResult),
			modelsFetchedAt: "2026-01-01T00:00:00.000Z",
		};
	}

	async setProviderModelsEnabled(
		providerId: string,
		enabledModelIds: string[],
	): Promise<ProviderSummary> {
		this.setEnabledCalls.push({ providerId, enabledModelIds });
		const provider = this.#find(providerId);
		return {
			...provider,
			models: provider.models.map((model) => ({
				...model,
				enabled: enabledModelIds.includes(model.id),
			})),
		};
	}
}

function renderPage(transport: FakeProvidersTransport) {
	render(
		<I18nProvider>
			<ProvidersSettingsPage transport={transport as unknown as ChatTransport} />
		</I18nProvider>,
	);
}

describe("ProvidersSettingsPage", () => {
	test("renders the configured providers and selects the first one", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({ id: providerAId, displayName: "OpenAI" }),
			makeProvider({ id: providerBId, displayName: "Anthropic", api: "anthropic-messages" }),
		]);

		renderPage(transport);

		const firstItem = await screen.findByRole("button", { name: /OpenAI/ });
		expect(firstItem).toHaveAttribute("aria-current", "true");
		expect(screen.getByRole("button", { name: /Anthropic/ })).toBeVisible();

		const form = screen.getByRole("form", { name: "Provider settings" });
		expect(within(form).getByRole("heading", { name: "OpenAI" })).toBeVisible();
	});

	test("adds a provider with the parsed custom headers and chosen type", async () => {
		const transport = new FakeProvidersTransport([makeProvider({ id: providerAId })]);
		renderPage(transport);

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
		const form = await screen.findByRole("form", { name: "Add provider" });
		const typeOptions = within(within(form).getByLabelText(/Type/)).getAllByRole("option");
		expect(typeOptions.map((option) => option.textContent)).toEqual([
			"OpenAI Compatible",
			"OpenAI Compatible",
			"Anthropic Compatible",
			"OpenAI Compatible",
		]);
		fireEvent.change(within(form).getByLabelText(/Display name/), {
			target: { value: "Claude" },
		});
		fireEvent.change(within(form).getByLabelText(/Type/), {
			target: { value: "anthropic-messages" },
		});
		fireEvent.change(within(form).getByLabelText(/Base URL/), {
			target: { value: "https://api.anthropic.com" },
		});
		fireEvent.change(within(form).getByLabelText(/API key/), {
			target: { value: "sk-anthropic" },
		});
		fireEvent.change(within(form).getByLabelText(/Custom headers/), {
			target: { value: '{"X-Org":"acme"}' },
		});
		fireEvent.click(within(form).getByRole("button", { name: "Add provider" }));

		await waitFor(() => expect(transport.createInputs).toHaveLength(1));
		expect(transport.createInputs[0]).toEqual({
			schemaVersion: 2,
			displayName: "Claude",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			apiKey: "sk-anthropic",
			customHeaders: { "X-Org": "acme" },
		});
	});

	test("rejects invalid custom headers JSON without calling the transport", async () => {
		const transport = new FakeProvidersTransport([makeProvider({ id: providerAId })]);
		renderPage(transport);

		const form = await screen.findByRole("form", { name: "Provider settings" });
		const headersInput = within(form).getByLabelText(/Custom headers/);
		await waitFor(() => {
			fireEvent.change(headersInput, { target: { value: "not json" } });
			expect(headersInput).toHaveValue("not json");
		});
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText("Custom headers must be a JSON object of string values."),
		).toBeVisible();
		expect(transport.updateInputs).toHaveLength(0);
	});

	test("keeps API-key replacement out of the endpoint edit form", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({ id: providerAId, displayName: "OpenAI", apiKeyMask: "********cret" }),
		]);
		renderPage(transport);

		const form = await screen.findByRole("form", { name: "Provider settings" });
		expect(within(form).queryByLabelText(/API key/)).toBeNull();
		fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(transport.updateInputs).toHaveLength(1));
		const input = transport.updateInputs[0];
		expect(input).toEqual({
			schemaVersion: 2,
			providerId: providerAId,
			displayName: "OpenAI",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		});
		expect(input !== undefined && "apiKey" in input).toBe(false);
	});

	test("fetches the model list and renders badges only for advertised metadata", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({ id: providerAId, apiKeyMask: "configured" }),
		]);
		transport.fetchModelsResult = [
			makeModel("gpt-5.4", "GPT-5.4", true, {
				contextWindowTokens: 272_000,
				reasoning: true,
				thinkingLevels: ["low", "medium", "high"],
			}),
			makeModel("text-embed", "Text Embed", false),
		];
		renderPage(transport);

		await screen.findByRole("form", { name: "Provider settings" });
		fireEvent.click(screen.getByRole("button", { name: "Fetch model list" }));

		await waitFor(() => expect(transport.fetchedIds).toEqual([providerAId]));
		expect(await screen.findByText("272K ctx")).toBeVisible();
		expect(screen.getByText("3 effort levels")).toBeVisible();
		expect(screen.getAllByText("openai-responses")).toHaveLength(2);

		const embedItem = screen.getByRole("checkbox", { name: "Enable Text Embed" }).closest("li");
		expect(within(embedItem as HTMLElement).queryByText(/effort levels/)).toBeNull();
	});

	test("saves the new enabled model ids when a checkbox is toggled", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({
				id: providerAId,
				apiKeyMask: "configured",
				models: [makeModel("gpt-5.4", "GPT-5.4", true), makeModel("o3-mini", "o3-mini", false)],
			}),
		]);
		renderPage(transport);

		await screen.findByRole("form", { name: "Provider settings" });
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable o3-mini" }));

		await waitFor(() => expect(transport.setEnabledCalls).toHaveLength(1));
		expect(transport.setEnabledCalls[0]).toEqual({
			providerId: providerAId,
			enabledModelIds: ["gpt-5.4", "o3-mini"],
		});
	});

	test("deletes a provider only after the confirmation dialog is confirmed", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({ id: providerAId, displayName: "OpenAI" }),
		]);
		renderPage(transport);

		await screen.findByRole("form", { name: "Provider settings" });
		fireEvent.click(screen.getByRole("button", { name: "Delete Provider" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(transport.deletedIds).toHaveLength(0);
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete Provider" }));

		await waitFor(() => expect(transport.deletedIds).toEqual([providerAId]));
		expect(await screen.findByText("Provider deleted.")).toBeVisible();
	});

	test("never renders the API key or custom header values, only the mask and header names", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({
				id: providerAId,
				apiKeyMask: "sk-…abcd",
				customHeaderNames: ["X-Org", "X-Trace"],
			}),
		]);
		renderPage(transport);

		const form = await screen.findByRole("form", { name: "Provider settings" });
		expect(within(form).queryByLabelText(/API key/)).toBeNull();

		const headersInput = within(form).getByLabelText(/Custom headers/);
		expect(headersInput).toHaveValue("");
		expect(within(form).getByText("Stored header names: X-Org, X-Trace")).toBeVisible();
	});

	test("keeps built-in identity read-only while allowing enablement and authentication", async () => {
		const transport = new FakeProvidersTransport([
			makeProvider({
				id: providerAId,
				displayName: "Anthropic",
				source: "builtin",
			}),
		]);
		renderPage(transport);

		const form = await screen.findByRole("form", { name: "Provider settings" });
		expect(within(form).queryByLabelText("Display name")).toBeNull();
		expect(within(form).queryByLabelText("Base URL")).toBeNull();
		expect(within(form).queryByLabelText("Custom headers (JSON)")).toBeNull();
		expect(within(form).queryByRole("button", { name: "Delete Provider" })).toBeNull();
		expect(within(form).getByText("Built-in")).toBeVisible();

		fireEvent.click(within(form).getByRole("checkbox", { name: "Enabled" }));
		await waitFor(() =>
			expect(transport.updateInputs).toEqual([
				{ schemaVersion: 2, providerId: providerAId, enabled: false },
			]),
		);
	});
});
