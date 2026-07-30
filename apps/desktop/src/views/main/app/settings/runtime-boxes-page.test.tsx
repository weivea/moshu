import type { RemoteAccessStatusOutput } from "@moshu/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { RuntimeBoxesSettingsPage } from "./runtime-boxes-page";

const rpcMocks = vi.hoisted(() => ({
	getRemoteAccessStatus: vi.fn(),
	listRuntimeBoxPairingClaims: vi.fn(),
	startRemoteAccessAuthentication: vi.fn(),
	createRuntimeBoxPairing: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
	desktopClient: rpcMocks,
}));

describe("RuntimeBoxesSettingsPage authentication status", () => {
	beforeEach(() => {
		localStorage.clear();
		rpcMocks.getRemoteAccessStatus.mockReset();
		rpcMocks.listRuntimeBoxPairingClaims.mockReset();
		rpcMocks.startRemoteAccessAuthentication.mockReset();
		rpcMocks.createRuntimeBoxPairing.mockReset();
		rpcMocks.listRuntimeBoxPairingClaims.mockResolvedValue({ items: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows and disables the signed-in action when Microsoft authentication is active", async () => {
		rpcMocks.getRemoteAccessStatus.mockResolvedValue(remoteAccessStatus(true));

		render(
			<I18nProvider>
				<RuntimeBoxesSettingsPage />
			</I18nProvider>,
		);

		expect(await screen.findByRole("button", { name: "Signed in" })).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Microsoft sign in" })).not.toBeInTheDocument();
	});

	test("keeps Microsoft sign in enabled when authentication is inactive", async () => {
		rpcMocks.getRemoteAccessStatus.mockResolvedValue(remoteAccessStatus(false));

		render(
			<I18nProvider>
				<RuntimeBoxesSettingsPage />
			</I18nProvider>,
		);

		expect(await screen.findByRole("button", { name: "Microsoft sign in" })).toBeEnabled();
	});

	test("counts down and clears an expired pairing code", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-29T13:00:00.000Z"));
		rpcMocks.getRemoteAccessStatus.mockResolvedValue({
			...remoteAccessStatus(true),
			enabled: true,
			state: "online",
		});
		rpcMocks.createRuntimeBoxPairing.mockResolvedValue({
			pairingId: "52aa0d10-f82d-47a1-91d4-0a97cbfd0905",
			code: "2KNeqXtxLMX9_ywjA1Kha4x33EXzP68t",
			expiresAt: "2026-07-29T13:05:00.000Z",
			runtimeBaseUrl: "https://example-41000.jpe1.devtunnels.ms",
		});

		render(
			<I18nProvider>
				<RuntimeBoxesSettingsPage />
			</I18nProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByText("Expires in 5:00")).toBeVisible();
		expect(screen.getByText("2KNeqXtxLMX9_ywjA1Kha4x33EXzP68t")).toBeVisible();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(screen.getByText("Expires in 4:59")).toBeVisible();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(299_000);
		});
		expect(screen.queryByText("2KNeqXtxLMX9_ywjA1Kha4x33EXzP68t")).not.toBeInTheDocument();
		expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
	});
});

function remoteAccessStatus(authenticated: boolean): RemoteAccessStatusOutput {
	return {
		enabled: false,
		authenticated,
		state: "disabled",
		runtimeIngressPort: 41_000,
		ingresses: [{ kind: "runtime", port: 41_000, ready: false }],
		trafficEstimate: {
			month: "2026-07",
			receivedBytes: 0,
			sentBytes: 0,
			totalBytes: 0,
			monthlyLimitBytes: 5 * 1024 * 1024 * 1024,
			warningLevel: "none",
			source: "runtime-rpc-application-payload-estimate",
		},
		serviceLimits: {
			maxTunnelsPerUser: 10,
			maxPortsPerTunnel: 10,
			maxBytesPerSecond: 20 * 1024 * 1024,
		},
	};
}
