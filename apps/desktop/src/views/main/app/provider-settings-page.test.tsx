import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
	ChatProviderConfiguration,
	ChatProviderStatus,
	ChatTransport,
} from "./chat/transport";
import { I18nProvider, useI18n } from "./i18n";
import { ProviderSettingsPage } from "./provider-settings-page";

beforeEach(() => {
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	vi.restoreAllMocks();
});

describe("ProviderSettingsPage", () => {
	test("preserves a saved API key while updating and testing Provider fields", async () => {
		const transport = new FakeProviderTransport();

		renderProviderSettings(transport);

		expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
			"href",
			"/settings/profile",
		);
		expect(await screen.findByText("Configured")).toBeVisible();
		const apiKeyInput = screen.getByLabelText("API key");
		expect(apiKeyInput).toHaveAttribute("type", "password");
		expect(apiKeyInput).toHaveAttribute("placeholder", "Saved key: ********cret");

		fireEvent.change(screen.getByLabelText("Model"), {
			target: { value: "updated-model" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

		expect(await screen.findByText("Connection succeeded in 12 ms.")).toBeVisible();
		expect(transport.testCalls).toEqual([
			{
				endpoint: "https://api.openai.com/v1",
				model: "updated-model",
			},
		]);

		fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
		expect(await screen.findByText("Provider settings saved.")).toBeVisible();
		expect(transport.configureCalls).toEqual([
			{
				endpoint: "https://api.openai.com/v1",
				model: "updated-model",
			},
		]);
	});

	test("replaces and deletes a saved API key", async () => {
		const transport = new FakeProviderTransport();

		renderProviderSettings(transport);
		await screen.findByText("Configured");

		fireEvent.change(screen.getByLabelText("API key"), {
			target: { value: "sk-replacement" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));
		await screen.findByText("Provider settings saved.");

		expect(transport.configureCalls[0]?.apiKey).toBe("sk-replacement");
		fireEvent.click(screen.getByRole("button", { name: "Delete Provider" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(transport.deleteCalls).toBe(0);
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete Provider" }));

		expect(await screen.findByText("Provider deleted.")).toBeVisible();
		expect(transport.deleteCalls).toBe(1);
		expect(screen.getByText("Not configured")).toBeVisible();
	});

	test("requires a new key before testing another Endpoint origin", async () => {
		const transport = new FakeProviderTransport();

		renderProviderSettings(transport);
		await screen.findByText("Configured");
		fireEvent.change(screen.getByLabelText("Base URL"), {
			target: { value: "https://untrusted.example/v1" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

		expect(
			await screen.findByText(
				"Enter a new API key before changing the Endpoint to another origin.",
			),
		).toBeVisible();
		expect(transport.testCalls).toEqual([]);
	});

	test("preserves unsaved fields when the language changes", async () => {
		const transport = new FakeProviderTransport();
		renderProviderSettings(transport, true);

		await screen.findByText("Configured");
		const endpointInput = screen.getByLabelText("Base URL");
		const modelInput = screen.getByLabelText("Model");
		const apiKeyInput = screen.getByLabelText("API key");
		fireEvent.change(endpointInput, {
			target: { value: "https://api.openai.com/v1/draft" },
		});
		fireEvent.change(modelInput, {
			target: { value: "draft-model" },
		});
		fireEvent.change(apiKeyInput, {
			target: { value: "sk-draft" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Toggle test locale" }));
		expect(await screen.findByText("已配置")).toBeVisible();
		expect(endpointInput).toHaveValue("https://api.openai.com/v1/draft");
		expect(modelInput).toHaveValue("draft-model");
		expect(apiKeyInput).toHaveValue("sk-draft");
		expect(transport.statusCalls).toBe(1);
	});
});

function renderProviderSettings(transport: ChatTransport, showLocaleToggle = false) {
	return render(
		<I18nProvider>
			<MemoryRouter initialEntries={["/settings/providers"]}>
				{showLocaleToggle ? <LocaleToggle /> : null}
				<ProviderSettingsPage transport={transport} onBackToChat={() => {}} />
			</MemoryRouter>
		</I18nProvider>,
	);
}

function LocaleToggle() {
	const { toggleLocale } = useI18n();
	return (
		<button type="button" onClick={toggleLocale}>
			Toggle test locale
		</button>
	);
}

class FakeProviderTransport implements ChatTransport {
	readonly configureCalls: ChatProviderConfiguration[] = [];
	readonly testCalls: ChatProviderConfiguration[] = [];
	deleteCalls = 0;
	statusCalls = 0;
	#status: ChatProviderStatus = {
		configured: true,
		endpoint: "https://api.openai.com/v1",
		model: "gpt-4.1-mini",
		askMode: "Ask",
		apiKeyMask: "********cret",
	};

	async getProviderStatus() {
		this.statusCalls += 1;
		return { ...this.#status };
	}

	async configureProvider(input: ChatProviderConfiguration) {
		this.configureCalls.push(input);
		this.#status = {
			configured: true,
			endpoint: input.endpoint,
			model: input.model,
			askMode: "Ask",
			apiKeyMask: "********cret",
		};
		return { ...this.#status };
	}

	async testProvider(input: ChatProviderConfiguration) {
		this.testCalls.push(input);
		return { ok: true, latencyMs: 12 };
	}

	async deleteProvider() {
		this.deleteCalls += 1;
		this.#status = {
			configured: false,
			endpoint: "https://api.openai.com/v1",
			model: "",
			askMode: "Ask",
		};
		return { ...this.#status };
	}

	async createSession(): Promise<never> {
		throw new Error("Not used.");
	}

	async getSession(): Promise<never> {
		throw new Error("Not used.");
	}

	async listSessions() {
		return [];
	}

	async renameSession(): Promise<never> {
		throw new Error("Not used.");
	}

	async setSessionArchived(): Promise<never> {
		throw new Error("Not used.");
	}

	async deleteSession(): Promise<void> {}

	async send(): Promise<never> {
		throw new Error("Not used.");
	}

	async cancel(): Promise<void> {}

	subscribe() {
		return () => {};
	}
}
