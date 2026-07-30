import type {
	AuthChallenge,
	ProviderAuthAttempt,
	ProviderAuthType,
	ProviderSummary,
} from "@moshu/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ChatTransport } from "../../chat/transport";
import { I18nProvider } from "../../i18n";
import { ProviderAuthPanel } from "./provider-auth-panel";

const providerId = "01984df0-cf17-7e6e-9a7d-4d98c1f0d5aa";
const attemptId = "01984df0-cf18-7c89-9d11-3686130434c8";
const challengeId = "01984df0-cf19-7bb2-a5cd-69e8a802db2f";
const now = "2026-07-25T04:15:28.349Z";

afterEach(() => {
	vi.useRealTimers();
});

describe("ProviderAuthPanel", () => {
	test("submits an API key input-only, clears it, polls once at a time, and refreshes on success", async () => {
		const fake = new FakeAuthTransport();
		const changed = vi.fn();
		renderPanel(fake, changed);
		expect(screen.getByText("Authentication required")).toHaveClass("provider-status--warning");

		fireEvent.click(screen.getByRole("button", { name: "Connect with API key" }));
		await screen.findByLabelText("API key");
		const input = screen.getByLabelText("API key");
		fireEvent.change(input, { target: { value: "fake-renderer-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(fake.secretWasReceived).toBe(true));
		expect(screen.queryByDisplayValue("fake-renderer-secret")).toBeNull();
		expect(document.body.textContent).not.toContain("fake-renderer-secret");
		fake.nextGet = attempt("api_key", "completed");
		await waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 2_000 });
		expect(fake.getInFlightMax).toBe(1);
	});

	test("renders OAuth links, device code, select and manual-code challenges without interpreting URLs", async () => {
		const fake = new FakeAuthTransport();
		fake.oauthChallenge = {
			id: challengeId,
			type: "select",
			message: "Choose tenant",
			options: [{ id: "tenant-a", label: "Tenant A", description: "Primary" }],
		};
		renderPanel(fake, vi.fn());

		fireEvent.click(screen.getByRole("button", { name: "Connect with OAuth" }));
		expect(await screen.findByText("DEVICE-CODE")).toBeVisible();
		expect(screen.getByRole("link", { name: "Open secure sign-in page" })).toHaveAttribute(
			"href",
			"http://127.0.0.1:8765/callback?state=opaque",
		);
		fireEvent.click(screen.getByRole("link", { name: "Open secure sign-in page" }));
		expect(fake.openedUrls).toEqual(["http://127.0.0.1:8765/callback?state=opaque"]);
		fireEvent.change(screen.getByLabelText("Choose tenant"), { target: { value: "tenant-a" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByLabelText("Paste provider code")).toBeVisible();
	});

	test("submits an empty text challenge when the provider allows the default value", async () => {
		const fake = new FakeAuthTransport();
		fake.oauthChallenge = {
			id: challengeId,
			type: "text",
			message: "GitHub Enterprise URL/domain (blank for github.com)",
			placeholder: "company.ghe.com",
		};
		renderPanel(fake, vi.fn());

		fireEvent.click(screen.getByRole("button", { name: "Connect with OAuth" }));
		expect(
			await screen.findByLabelText("GitHub Enterprise URL/domain (blank for github.com)"),
		).toHaveValue("");
		const submit = screen.getByRole("button", { name: "Continue" });
		expect(submit).toBeEnabled();
		fireEvent.click(submit);

		await waitFor(() => expect(fake.responses).toEqual([""]));
	});

	test("cancels on abandonment and cancels before logout", async () => {
		const fake = new FakeAuthTransport();
		const view = renderPanel(fake, vi.fn());
		fireEvent.click(screen.getByRole("button", { name: "Connect with API key" }));
		await screen.findByLabelText("API key");
		view.unmount();
		await waitFor(() => expect(fake.cancelCalls).toEqual([attemptId]));

		const configured = { ...provider(), credential: { configured: true, type: "oauth" as const } };
		renderPanel(fake, vi.fn(), configured);
		fireEvent.click(screen.getByRole("button", { name: "Replace OAuth" }));
		await screen.findByLabelText("API key");
		fireEvent.click(screen.getByRole("button", { name: "Log out" }));
		await waitFor(() => expect(fake.logoutCalls).toEqual([providerId]));
		expect(fake.cancelCalls).toEqual([attemptId, attemptId]);
	});
});

class FakeAuthTransport {
	secretWasReceived = false;
	cancelCalls: string[] = [];
	logoutCalls: string[] = [];
	nextGet = attempt("api_key", "authenticating");
	getInFlight = 0;
	getInFlightMax = 0;
	oauthChallenge?: AuthChallenge;
	openedUrls: string[] = [];
	responses: string[] = [];

	async startProviderAuth(_providerId: string, authType: ProviderAuthType) {
		return attempt(authType, "waiting_for_interaction", {
			challenge:
				authType === "oauth" ? (this.oauthChallenge ?? secretChallenge()) : secretChallenge(),
			...(authType === "oauth"
				? {
						notifications: [
							{ type: "info" as const, message: "Provider sign-in" },
							{
								type: "auth_url" as const,
								url: "http://127.0.0.1:8765/callback?state=opaque",
							},
							{
								type: "device_code" as const,
								userCode: "DEVICE-CODE",
								verificationUri: "https://example.test/device",
								expiresInSeconds: 600,
							},
							{ type: "progress" as const, message: "Waiting" },
						],
					}
				: {}),
		});
	}

	async getProviderAuth() {
		this.getInFlight += 1;
		this.getInFlightMax = Math.max(this.getInFlightMax, this.getInFlight);
		await Promise.resolve();
		this.getInFlight -= 1;
		return this.nextGet;
	}

	async respondProviderAuth(_attemptId: string, _challengeId: string, value: string) {
		this.responses.push(value);
		if (value === "fake-renderer-secret") this.secretWasReceived = true;
		if (value === "tenant-a") {
			return attempt("oauth", "waiting_for_interaction", {
				challenge: {
					id: challengeId,
					type: "manual_code",
					message: "Paste provider code",
				},
			});
		}
		return attempt("api_key", "authenticating");
	}

	async cancelProviderAuth(cancelAttemptId: string) {
		this.cancelCalls.push(cancelAttemptId);
		return attempt("api_key", "cancelled");
	}

	async logoutProvider(logoutProviderId: string) {
		this.logoutCalls.push(logoutProviderId);
	}

	async openExternalUrl(url: string) {
		this.openedUrls.push(url);
	}
}

function renderPanel(
	fake: FakeAuthTransport,
	onChanged: () => void,
	value: ProviderSummary = provider(),
) {
	return render(
		<I18nProvider>
			<ProviderAuthPanel
				provider={value}
				transport={fake as unknown as ChatTransport}
				onProviderChanged={onChanged}
			/>
		</I18nProvider>,
	);
}

function provider(): ProviderSummary {
	return {
		schemaVersion: 2,
		id: providerId,
		displayName: "Example",
		source: "builtin",
		enabled: true,
		authMethods: ["api_key", "oauth"],
		credential: { configured: false },
		customHeaderNames: [],
		models: [],
	};
}

function secretChallenge(): AuthChallenge {
	return { id: challengeId, type: "secret", message: "API key" };
}

function attempt(
	authType: ProviderAuthType,
	status: ProviderAuthAttempt["status"],
	overrides: Partial<ProviderAuthAttempt> = {},
): ProviderAuthAttempt {
	return {
		schemaVersion: 2,
		id: attemptId,
		providerId,
		authType,
		status,
		createdAt: now,
		updatedAt: now,
		notifications: [],
		...overrides,
	};
}
