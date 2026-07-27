import type { AvailableModel, ReasoningCapability } from "@moshu/contracts";
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
	overrides: {
		displayName?: string;
		contextWindowTokens?: number;
		reasoning?: ReasoningCapability;
	} = {},
): AvailableModel {
	return {
		providerId,
		providerDisplayName,
		providerType: "openai-compatible",
		model: {
			id: modelId,
			enabled: true,
			displayName: overrides.displayName ?? modelId,
			...(overrides.contextWindowTokens === undefined
				? {}
				: { contextWindowTokens: overrides.contextWindowTokens }),
		},
		reasoning: overrides.reasoning ?? { kind: "none" },
	};
}

function renderSelector(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
	const onSelect = vi.fn();
	const onReasoningChange = vi.fn();
	render(
		<I18nProvider>
			<ModelSelector
				models={props.models ?? []}
				onSelect={onSelect}
				onReasoningChange={onReasoningChange}
				{...props}
			/>
		</I18nProvider>,
	);
	return { onSelect, onReasoningChange };
}

describe("ModelSelector", () => {
	test("groups models by provider and only labels the context window when known", () => {
		renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", {
					displayName: "GPT-5.4",
					contextWindowTokens: 272_000,
				}),
				availableModel(providerAId, "Provider A", "gpt-5.4-mini"),
				availableModel(providerBId, "Provider B", "claude-opus"),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		const groups = screen.getAllByRole("group");
		expect(groups.map((group) => group.getAttribute("label"))).toEqual([
			"Provider A",
			"Provider B",
		]);

		const picker = screen.getByRole("combobox", { name: "Model" });
		expect(
			within(picker)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["Select a model", "GPT-5.4", "gpt-5.4-mini", "claude-opus"]);

		expect(screen.getByText("272K context")).toBeVisible();
	});

	test("omits the context window label when the selected model does not advertise one", () => {
		renderSelector({
			models: [availableModel(providerAId, "Provider A", "gpt-5.4-mini")],
			providerId: providerAId,
			modelId: "gpt-5.4-mini",
		});

		expect(screen.queryByText(/context$/)).toBeNull();
	});

	test("renders no reasoning control when the model advertises none", () => {
		renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", { reasoning: { kind: "none" } }),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		expect(screen.queryByText("Reasoning effort")).toBeNull();
		expect(screen.queryByText("Thinking budget")).toBeNull();
		expect(screen.getAllByRole("combobox")).toHaveLength(1);
	});

	test("renders exactly the advertised effort levels", () => {
		renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", {
					reasoning: { kind: "effort", levels: ["low", "medium", "high"] },
				}),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
		expect(
			within(effort)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["Provider default", "low", "medium", "high"]);
	});

	test("renders the budget control with an off option bounded by the advertised range", () => {
		renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", {
					reasoning: { kind: "budget", minBudgetTokens: 1000, maxBudgetTokens: 4000 },
				}),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		const budget = screen.getByRole("combobox", { name: /Thinking budget/ });
		const offOption = within(budget).getByRole("option", { name: "Off" });
		expect(offOption).toHaveValue("0");
		const optionLabels = within(budget)
			.getAllByRole("option")
			.map((option) => option.textContent);
		expect(optionLabels).toContain("1K tokens");
		expect(optionLabels).toContain("4K tokens");
		expect(optionLabels).not.toContain("8K tokens");
	});

	test("renders both reasoning controls when the model advertises both", () => {
		renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", {
					reasoning: {
						kind: "both",
						levels: ["low", "high"],
						minBudgetTokens: 1000,
						maxBudgetTokens: 4000,
					},
				}),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeVisible();
		expect(screen.getByRole("combobox", { name: /Thinking budget/ })).toBeVisible();
	});

	test("reports model and effort selections through their callbacks", () => {
		const { onSelect, onReasoningChange } = renderSelector({
			models: [
				availableModel(providerAId, "Provider A", "gpt-5.4", {
					reasoning: { kind: "effort", levels: ["low", "medium", "high"] },
				}),
				availableModel(providerBId, "Provider B", "claude-opus", {
					reasoning: { kind: "effort", levels: ["low", "high"] },
				}),
			],
			providerId: providerAId,
			modelId: "gpt-5.4",
		});

		fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
			target: { value: `${providerBId}\u0000claude-opus` },
		});
		expect(onSelect).toHaveBeenCalledWith(providerBId, "claude-opus");

		fireEvent.change(screen.getByRole("combobox", { name: "Reasoning effort" }), {
			target: { value: "high" },
		});
		expect(onReasoningChange).toHaveBeenCalledWith({ effort: "high" });
	});
});
