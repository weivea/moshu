import type { AvailableModel } from "@moshu/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";

const providerAId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5aa";
const providerBId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5bb";

function availableModel(providerId: string, name: string, modelId: string): AvailableModel {
	return {
		providerId,
		providerDisplayName: name,
		providerSource: "builtin",
		model: {
			id: modelId,
			enabled: true,
			displayName: modelId,
			api: "openai-responses",
			input: ["text"],
			reasoning: false,
			contextWindowTokens: 128_000,
			maxOutputTokens: 8_192,
			thinkingLevels: [],
		},
	};
}

function renderComposer(overrides: Partial<ChatComposerProps> = {}) {
	const onModelChange = vi.fn();
	const props: ChatComposerProps = {
		canSend: true,
		draft: "",
		isResponding: false,
		isStopping: false,
		availableModels: [],
		onDraftChange: vi.fn(),
		onModelChange,
		onSend: vi.fn(),
		onStop: vi.fn(),
		...overrides,
	};
	render(
		<I18nProvider>
			<ChatComposer {...props} />
		</I18nProvider>,
	);
	return { onModelChange };
}

describe("ChatComposer", () => {
	test("switching the model picker reports the new selection", () => {
		const modelA = availableModel(providerAId, "Provider A", "gpt-5.4");
		const { onModelChange } = renderComposer({
			availableModels: [modelA, availableModel(providerBId, "Provider B", "claude-opus")],
			selectedModel: modelA,
		});

		const picker = screen.getByRole("combobox", { name: "Model" });
		fireEvent.change(picker, { target: { value: `${providerBId}\u0000claude-opus` } });

		expect(onModelChange).toHaveBeenCalledWith({
			providerId: providerBId,
			modelId: "claude-opus",
		});
	});

	test("disables sending and the picker when no models are available", () => {
		renderComposer({ availableModels: [], canSend: false });

		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		const picker = screen.getByRole("combobox", { name: "Model" });
		expect(picker).toBeDisabled();
		expect(within(picker).getByRole("option", { name: "No models enabled" })).toBeVisible();
	});
});
