import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "./i18n";
import { LocalProfileProvider, useLocalProfile } from "./local-profile";
import { ProfileSettingsPage } from "./profile-settings-page";
import { AppearanceProvider } from "./providers";

beforeEach(() => {
	localStorage.clear();
	Object.defineProperty(window.navigator, "language", {
		configurable: true,
		value: "en-US",
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	});
});

describe("ProfileSettingsPage", () => {
	test("persists and publishes the local username", () => {
		render(
			<I18nProvider>
				<AppearanceProvider>
					<LocalProfileProvider>
						<MemoryRouter initialEntries={["/settings/profile"]}>
							<ProfileSettingsPage />
							<ProfileProbe />
						</MemoryRouter>
					</LocalProfileProvider>
				</AppearanceProvider>
			</I18nProvider>,
		);

		expect(screen.getByRole("link", { name: "LLM Provider" })).toHaveAttribute(
			"href",
			"/settings/providers",
		);
		expect(screen.getByTestId("profile-name")).toHaveTextContent("Local user");
		fireEvent.change(screen.getByLabelText("Username"), {
			target: { value: "Jian" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

		expect(screen.getByTestId("profile-name")).toHaveTextContent("Jian");
		expect(localStorage.getItem("moshu.localProfile.v1")).toBe('{"username":"Jian"}');
		expect(screen.getByText("Saved")).toBeVisible();
	});
});

function ProfileProbe() {
	const profile = useLocalProfile();
	return <output data-testid="profile-name">{profile.username ?? "Local user"}</output>;
}
