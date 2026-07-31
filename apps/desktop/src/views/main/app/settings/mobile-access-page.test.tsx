import type {
	CreateMobilePairingOutput,
	MobileAccessStatusOutput,
	MobileDevice,
	MobilePairingClaim,
} from "@moshu/contracts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { MobileAccessSettingsPage } from "./mobile-access-page";

const rpcMocks = vi.hoisted(() => ({
	getMobileAccessStatus: vi.fn(),
	createMobilePairing: vi.fn(),
	listMobilePairingClaims: vi.fn(),
	approveMobilePairing: vi.fn(),
	rejectMobilePairing: vi.fn(),
	listMobileDevices: vi.fn(),
	revokeMobileDevice: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
	desktopClient: rpcMocks,
}));

vi.mock("qrcode", () => ({
	default: {
		toString: vi.fn(async () => "<svg data-testid='qr'></svg>"),
	},
}));

describe("MobileAccessSettingsPage", () => {
	beforeEach(() => {
		localStorage.clear();
		for (const mock of Object.values(rpcMocks)) {
			mock.mockReset();
		}
		rpcMocks.getMobileAccessStatus.mockResolvedValue(mobileStatus({ ready: true }));
		rpcMocks.listMobilePairingClaims.mockResolvedValue({ items: [] });
		rpcMocks.listMobileDevices.mockResolvedValue({ items: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("disables pairing when Remote Access is off", async () => {
		rpcMocks.getMobileAccessStatus.mockResolvedValue(
			mobileStatus({ ready: false, enabled: false }),
		);

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		expect(await screen.findByText("Remote Access is off")).toBeVisible();
		expect(screen.getByRole("button", { name: "Show QR code" })).toBeDisabled();
	});

	test("keeps pairing disabled until the Mobile ingress is ready with a public URL", async () => {
		rpcMocks.getMobileAccessStatus.mockResolvedValue(mobileStatus({ ready: false, enabled: true }));

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		expect(
			await screen.findByText(
				"Waiting for the Mobile ingress to come online and publish its public URL before you can create a pairing code.",
			),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "Show QR code" })).toBeDisabled();
		expect(rpcMocks.createMobilePairing).not.toHaveBeenCalled();
	});

	test("keeps pairing disabled while Remote Access is disabling even though the URL is still live", async () => {
		// enabled=false persists before the async stop clears readiness, so ready/publicUrl still look
		// live. The button must be disabled immediately and no pairing request may be attempted.
		rpcMocks.getMobileAccessStatus.mockResolvedValue(mobileStatus({ ready: true, enabled: false }));

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		const button = await screen.findByRole("button", { name: "Show QR code" });
		expect(button).toBeDisabled();
		expect(rpcMocks.createMobilePairing).not.toHaveBeenCalled();
	});

	test("disables the create button when Remote Access flips off mid-session while the URL lingers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-29T13:00:00.000Z"));
		rpcMocks.getMobileAccessStatus.mockResolvedValue(mobileStatus({ ready: true, enabled: true }));

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(screen.getByRole("button", { name: "Show QR code" })).toBeEnabled();

		// Remote Access disabled; the ingress stop is still pending so ready/publicUrl remain visible.
		rpcMocks.getMobileAccessStatus.mockResolvedValue(mobileStatus({ ready: true, enabled: false }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(screen.getByRole("button", { name: "Show QR code" })).toBeDisabled();
	});

	test("surfaces a fail-closed error when the ingress refuses a pairing", async () => {
		rpcMocks.createMobilePairing.mockRejectedValue(
			Object.assign(new Error("MOBILE_INGRESS_NOT_READY: not exposed"), {
				code: "MOBILE_INGRESS_NOT_READY",
			}),
		);

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		const button = await screen.findByRole("button", { name: "Show QR code" });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);

		expect(await screen.findByText(/is not exposed yet/)).toBeVisible();
	});

	test("shows a pairing code with a countdown and never persists the payload", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-29T13:00:00.000Z"));
		rpcMocks.createMobilePairing.mockResolvedValue(pairingOutput());

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		fireEvent.click(screen.getByRole("button", { name: "Show QR code" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(screen.getByText("Expires in 5:00")).toBeVisible();
		expect(screen.getByText(PAIRING_CODE)).toBeVisible();

		// The one-time code and QR payload must never touch persistent storage.
		const serialized = JSON.stringify(localStorage);
		expect(serialized).not.toContain(PAIRING_CODE);
		expect(serialized).not.toContain("moshu-mobile-pairing");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(screen.getByText("Expires in 4:59")).toBeVisible();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(299_000);
		});
		expect(screen.queryByText(PAIRING_CODE)).not.toBeInTheDocument();
		expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
	});

	test("expires a legacy pairing that never received a public URL and lets the operator recreate", async () => {
		// A pre-fix / degraded pairing can arrive without a reachable public URL. It must never linger
		// as a blank QR — the UI expires it, surfaces the not-ready error, and re-enables creation.
		rpcMocks.createMobilePairing.mockResolvedValue({ ...pairingOutput(), mobileUrl: "" });

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		const button = await screen.findByRole("button", { name: "Show QR code" });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);

		expect(await screen.findByText(/is not exposed yet/)).toBeVisible();
		expect(screen.queryByText(PAIRING_CODE)).not.toBeInTheDocument();
		expect(screen.queryByText(/Expires in/)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show QR code" })).toBeEnabled();
	});

	test("approves a claim by pinning its fingerprint", async () => {
		rpcMocks.listMobilePairingClaims.mockResolvedValue({ items: [pendingClaim()] });
		rpcMocks.approveMobilePairing.mockResolvedValue({ device: approvedDevice() });

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Approve fingerprint" }));

		await waitFor(() =>
			expect(rpcMocks.approveMobilePairing).toHaveBeenCalledWith({
				pairingId: "2f2b7d20-0b1a-4a5b-9f3a-1a2b3c4d5e6f",
				expectedPublicKeyFingerprint: "fp-abc123",
			}),
		);
	});

	test("rejects a claim", async () => {
		rpcMocks.listMobilePairingClaims.mockResolvedValue({ items: [pendingClaim()] });
		rpcMocks.rejectMobilePairing.mockResolvedValue({ rejected: true });

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

		await waitFor(() =>
			expect(rpcMocks.rejectMobilePairing).toHaveBeenCalledWith({
				pairingId: "2f2b7d20-0b1a-4a5b-9f3a-1a2b3c4d5e6f",
			}),
		);
	});

	test("revokes a paired device by client and key id", async () => {
		rpcMocks.listMobileDevices.mockResolvedValue({ items: [approvedDevice()] });
		rpcMocks.revokeMobileDevice.mockResolvedValue({ revoked: true });

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

		await waitFor(() =>
			expect(rpcMocks.revokeMobileDevice).toHaveBeenCalledWith({
				mobileClientId: "11111111-2222-3333-4444-555555555555",
				deviceKeyId: "device-key-1",
			}),
		);
	});

	test("pages through the device roster with load more", async () => {
		rpcMocks.listMobileDevices.mockImplementation(async (input?: { cursor?: string }) => {
			if (input?.cursor === undefined) {
				return { items: [approvedDevice()], nextCursor: "cursor-1" };
			}
			if (input.cursor === "cursor-1") {
				return { items: [secondDevice()] };
			}
			return { items: [] };
		});

		render(
			<I18nProvider>
				<MobileAccessSettingsPage />
			</I18nProvider>,
		);

		expect(await screen.findByText("Jane's iPhone")).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Load more devices" }));

		expect(await screen.findByText("Sam's iPad")).toBeVisible();
		expect(screen.getByText("Jane's iPhone")).toBeVisible();
		await waitFor(() =>
			expect(rpcMocks.listMobileDevices).toHaveBeenCalledWith({ cursor: "cursor-1" }),
		);
	});
});

const PAIRING_CODE = "2KNeqXtxLMX9_ywjA1Kha4x33EXzP68t";

function mobileStatus(options: { ready: boolean; enabled?: boolean }): MobileAccessStatusOutput {
	const enabled = options.enabled ?? true;
	return {
		schemaVersion: 1,
		remoteAccessEnabled: enabled,
		remoteAccessState: enabled ? "online" : "disabled",
		ingressPort: 41_001,
		ingressReady: options.ready,
		publicUrl: options.ready ? "https://example-41001.jpe1.devtunnels.ms/mobile" : undefined,
		protocolMinVersion: 1,
		protocolMaxVersion: 1,
		transportSecurity: "relay-tls",
		supportedTransportSecurity: ["relay-tls"],
	};
}

function pairingOutput(): CreateMobilePairingOutput {
	return {
		pairingId: "2f2b7d20-0b1a-4a5b-9f3a-1a2b3c4d5e6f",
		code: PAIRING_CODE,
		expiresAt: "2026-07-29T13:05:00.000Z",
		mobileUrl: "https://example-41001.jpe1.devtunnels.ms/mobile",
		qr: {
			v: 1,
			kind: "moshu-mobile-pairing",
			mobileUrl: "https://example-41001.jpe1.devtunnels.ms/mobile",
			pairingId: "2f2b7d20-0b1a-4a5b-9f3a-1a2b3c4d5e6f",
			code: PAIRING_CODE,
			agentServerId: "99999999-8888-7777-6666-555555555555",
			agentServerPublicKey: "a".repeat(43),
			agentServerPublicKeyFingerprint: "server-fp-xyz789",
			expiresAt: "2026-07-29T13:05:00.000Z",
			protocolMinVersion: 1,
			protocolMaxVersion: 1,
		},
	};
}

function pendingClaim(): MobilePairingClaim {
	return {
		pairingId: "2f2b7d20-0b1a-4a5b-9f3a-1a2b3c4d5e6f",
		deviceKeyId: "device-key-1",
		displayName: "Jane's iPhone",
		model: "iPhone 15 Pro",
		platform: "ios",
		appVersion: "1.0.0",
		publicKeyFingerprint: "fp-abc123",
		claimedAt: "2026-07-29T13:00:30.000Z",
		expiresAt: "2026-07-29T13:05:00.000Z",
	};
}

function approvedDevice(): MobileDevice {
	return {
		schemaVersion: 1,
		mobileClientId: "11111111-2222-3333-4444-555555555555",
		displayName: "Jane's iPhone",
		model: "iPhone 15 Pro",
		platform: "ios",
		appVersion: "1.0.0",
		deviceKeyIds: ["device-key-1"],
		approvedAt: "2026-07-29T13:01:00.000Z",
		lastSeenAt: "2026-07-29T13:02:00.000Z",
		revoked: false,
	};
}

function secondDevice(): MobileDevice {
	return {
		schemaVersion: 1,
		mobileClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		displayName: "Sam's iPad",
		model: "iPad Pro",
		platform: "ipados",
		appVersion: "1.0.0",
		deviceKeyIds: ["device-key-2"],
		approvedAt: "2026-07-28T13:01:00.000Z",
		revoked: true,
	};
}
