import type { AvailableModel, ThinkingLevel } from "@moshu/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { ModelSelector } from "./model-selector";

const providerAId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5aa";
const providerBId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5bb";

function availableModel(
	providerId: string,
	providerDisplayName: string,
	modelId: string,
	thinkingLevels: ThinkingLevel[] = [],
): AvailableModel {
	return {
		providerId,
		providerDisplayName,
		providerSource: "builtin",
		model: {
			id: modelId,
			enabled: true,
			displayName: modelId,
			api: "openai-responses",
			input: ["text"],
			reasoning: thinkingLevels.length > 0,
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			thinkingLevels,
		},
	};
}

function renderSelector(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
	const onSelect = vi.fn();
	const onThinkingLevelChange = vi.fn();
	render(
		<I18nProvider>
			<ModelSelector
				models={props.models ?? []}
				onSelect={onSelect}
				onThinkingLevelChange={onThinkingLevelChange}
				{...props}
			/>
		</I18nProvider>,
	);
	return { onSelect, onThinkingLevelChange };
}

describe("ModelSelector", () => {
	test("groups models by provider and reports model changes", () => {
		const models = [
			availableModel(providerAId, "Provider A", "gpt-5.4"),
			availableModel(providerBId, "Provider B", "claude-opus"),
		];
		const { onSelect } = renderSelector({
			models,
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		expect(screen.getAllByRole("group").map((group) => group.getAttribute("label"))).toEqual([
			"Provider A",
			"Provider B",
		]);
		const picker = screen.getByRole("combobox", { name: "Model" });
		fireEvent.change(picker, { target: { value: `${providerBId}\0claude-opus` } });
		expect(onSelect).toHaveBeenCalledWith(providerBId, "claude-opus");
	});

	test("renders and reports exactly the Pi thinking levels advertised by the selected model", () => {
		const model = availableModel(providerAId, "Provider A", "gpt-5.4", [
			"off",
			"low",
			"medium",
			"high",
		]);
		const { onThinkingLevelChange } = renderSelector({
			models: [model],
			providerId: providerAId,
			modelId: model.model.id,
		});

		const thinking = screen.getByRole("combobox", { name: "Reasoning effort" });
		expect(
			within(thinking)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["Provider default", "off", "low", "medium", "high"]);
		fireEvent.change(thinking, { target: { value: "high" } });
		expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
	});

	test("does not require a thinking control for non-reasoning models", () => {
		renderSelector({
			models: [availableModel(providerAId, "Provider A", "gpt-5.4-mini")],
			providerId: providerAId,
			modelId: "gpt-5.4-mini",
		});
		expect(screen.getAllByRole("combobox")).toHaveLength(1);
	});
});
