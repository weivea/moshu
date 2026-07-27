import { describe, expect, test } from "vitest";

import { createPreviewChatTransport } from "./preview-transport";

describe("preview chat transport models", () => {
	test("only lists models from authorized Providers", async () => {
		const transport = createPreviewChatTransport();
		const provider = await transport.createProvider({
			schemaVersion: 2,
			displayName: "Preview",
			api: "openai-responses",
			baseUrl: "https://preview.example/v1",
		});
		const fetched = await transport.fetchProviderModels(provider.id);
		const model = fetched.models[0];
		if (model === undefined) {
			throw new Error("Expected the preview Provider to expose a model.");
		}
		await transport.setProviderModelsEnabled(provider.id, [model.id]);

		await expect(transport.listAvailableModels()).resolves.toEqual({ models: [] });

		await transport.updateProvider({
			schemaVersion: 2,
			providerId: provider.id,
			apiKey: "sk-preview",
		});
		const authorized = await transport.listAvailableModels();
		expect(authorized.models.map((entry) => entry.model.id)).toEqual([model.id]);
	});
});
