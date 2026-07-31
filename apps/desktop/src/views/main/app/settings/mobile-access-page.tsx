import { Button } from "@heroui/react";
import type {
	CreateMobilePairingOutput,
	MobileAccessStatusOutput,
	MobileDevice,
	MobilePairingClaim,
} from "@moshu/contracts";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";

export function MobileAccessSettingsPage() {
	const { t } = useI18n();
	const [status, setStatus] = useState<MobileAccessStatusOutput>();
	const [pairing, setPairing] = useState<CreateMobilePairingOutput>();
	const [qrImageUrl, setQrImageUrl] = useState<string>();
	const [pairingRemainingSeconds, setPairingRemainingSeconds] = useState<number>();
	const [claims, setClaims] = useState<MobilePairingClaim[]>([]);
	const [devices, setDevices] = useState<MobileDevice[]>([]);
	const [devicesNextCursor, setDevicesNextCursor] = useState<string>();
	const [devicesPageCount, setDevicesPageCount] = useState(1);
	const [pendingAction, setPendingAction] = useState<string>();
	const [errorMessage, setErrorMessage] = useState<string>();

	const loadStatus = useCallback(async () => {
		try {
			setStatus(await desktopClient.getMobileAccessStatus());
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.status"));
		}
	}, [t]);

	const loadClaims = useCallback(async () => {
		try {
			setClaims((await desktopClient.listMobilePairingClaims()).items);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.claims"));
		}
	}, [t]);

	// The device roster is a lifetime audit log, so the server paginates it (active devices first).
	// We walk every page the operator has expanded so polling keeps the whole visible set fresh, and
	// dedupe by client id in case a device shifts between the active/revoked groups mid-walk.
	const loadDevices = useCallback(async () => {
		try {
			const collected = new Map<string, MobileDevice>();
			let cursor: string | undefined;
			let nextCursor: string | undefined;
			for (let page = 0; page < devicesPageCount; page += 1) {
				const result = await desktopClient.listMobileDevices(
					cursor === undefined ? {} : { cursor },
				);
				for (const device of result.items) {
					collected.set(device.mobileClientId, device);
				}
				nextCursor = result.nextCursor;
				if (nextCursor === undefined) {
					break;
				}
				cursor = nextCursor;
			}
			setDevices([...collected.values()]);
			setDevicesNextCursor(nextCursor);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.devices"));
		}
	}, [t, devicesPageCount]);

	useEffect(() => {
		void loadStatus();
		const timer = setInterval(() => void loadStatus(), 2_000);
		return () => clearInterval(timer);
	}, [loadStatus]);

	useEffect(() => {
		void loadClaims();
		const timer = setInterval(() => void loadClaims(), 1_500);
		return () => clearInterval(timer);
	}, [loadClaims]);

	useEffect(() => {
		void loadDevices();
		const timer = setInterval(() => void loadDevices(), 2_500);
		return () => clearInterval(timer);
	}, [loadDevices]);

	// Render the QR from the ephemeral payload only in memory. It is never written to localStorage or
	// logs, and it is cleared as soon as the pairing is discarded or the component unmounts.
	useEffect(() => {
		const qr = pairing?.qr;
		if (qr === undefined) {
			setQrImageUrl(undefined);
			return;
		}
		let active = true;
		QRCode.toString(JSON.stringify(qr), {
			type: "svg",
			errorCorrectionLevel: "M",
			margin: 2,
		})
			.then((svg) => {
				if (active) {
					setQrImageUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
				}
			})
			.catch(() => {
				if (active) {
					setQrImageUrl(undefined);
				}
			});
		return () => {
			active = false;
		};
	}, [pairing]);

	useEffect(() => {
		if (pairing === undefined) {
			setPairingRemainingSeconds(undefined);
			return;
		}
		const expiresAtMs = Date.parse(pairing.expiresAt);
		const updateCountdown = () => {
			const remainingMs = expiresAtMs - Date.now();
			if (remainingMs <= 0) {
				setPairing((current) => (current?.pairingId === pairing.pairingId ? undefined : current));
				setPairingRemainingSeconds(undefined);
				return;
			}
			setPairingRemainingSeconds(Math.ceil(remainingMs / 1_000));
		};
		updateCountdown();
		const timer = setInterval(updateCountdown, 1_000);
		return () => clearInterval(timer);
	}, [pairing]);

	const createPairing = async () => {
		setPendingAction("pair");
		setErrorMessage(undefined);
		try {
			const created = await desktopClient.createMobilePairing();
			if (created.qr === undefined) {
				// The server only returns a pairing once the Mobile ingress can publish a reachable URL.
				// A QR-less response means the ingress dropped mid-request — surface it instead of
				// leaving a code that could never be scanned.
				setPairing(undefined);
				setErrorMessage(t("mobileAccess.error.ingressNotReady"));
				return;
			}
			setPairing(created);
			await loadClaims();
		} catch (error) {
			setErrorMessage(
				isIngressNotReadyError(error)
					? t("mobileAccess.error.ingressNotReady")
					: error instanceof Error
						? error.message
						: t("mobileAccess.error.pairing"),
			);
		} finally {
			setPendingAction(undefined);
		}
	};

	const loadMoreDevices = () => {
		setDevicesPageCount((count) => count + 1);
	};

	const approveClaim = async (claim: MobilePairingClaim) => {
		setErrorMessage(undefined);
		try {
			await desktopClient.approveMobilePairing({
				pairingId: claim.pairingId,
				expectedPublicKeyFingerprint: claim.publicKeyFingerprint,
			});
			await loadClaims();
			await loadDevices();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.decision"));
		}
	};

	const rejectClaim = async (claim: MobilePairingClaim) => {
		setErrorMessage(undefined);
		try {
			await desktopClient.rejectMobilePairing({ pairingId: claim.pairingId });
			await loadClaims();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.decision"));
		}
	};

	const revokeDevice = async (device: MobileDevice) => {
		const deviceKeyId = device.deviceKeyIds[0];
		if (deviceKeyId === undefined) {
			return;
		}
		setErrorMessage(undefined);
		try {
			await desktopClient.revokeMobileDevice({
				mobileClientId: device.mobileClientId,
				deviceKeyId,
			});
			await loadDevices();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("mobileAccess.error.revoke"));
		}
	};

	const ingressLabel =
		status === undefined
			? t("mobileAccess.loading")
			: !status.remoteAccessEnabled
				? t("mobileAccess.disabled")
				: status.ingressReady
					? t("mobileAccess.ready")
					: t("mobileAccess.notReady");

	// A pairing QR is only reachable once the Mobile ingress is live and has published its public URL,
	// so the create action stays disabled until both hold — the server fails closed regardless.
	const canCreatePairing = status?.ingressReady === true && typeof status.publicUrl === "string";

	return (
		<section className="settings-section mobile-access-settings">
			<header className="settings-section__header">
				<span className="chat-page__eyebrow">{t("mobileAccess.eyebrow")}</span>
				<h1>{t("mobileAccess.title")}</h1>
				<p>{t("mobileAccess.description")}</p>
			</header>

			{errorMessage ? (
				<p className="session-sidebar__error" role="alert">
					{errorMessage}
				</p>
			) : null}

			<section
				className="chat-card mobile-access-status"
				aria-label={t("mobileAccess.statusTitle")}
			>
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("mobileAccess.statusEyebrow")}</span>
						<h2>{t("mobileAccess.statusTitle")}</h2>
					</div>
					<strong>{ingressLabel}</strong>
				</div>
				{status ? (
					<dl className="mobile-access-status__grid">
						<div>
							<dt>{t("mobileAccess.transport")}</dt>
							<dd>{status.transportSecurity}</dd>
						</div>
						<div>
							<dt>{t("mobileAccess.protocol")}</dt>
							<dd>
								v{status.protocolMinVersion}–v{status.protocolMaxVersion}
							</dd>
						</div>
						{status.publicUrl ? (
							<div>
								<dt>{t("mobileAccess.publicUrl")}</dt>
								<dd>
									<code>{status.publicUrl}</code>
								</dd>
							</div>
						) : null}
					</dl>
				) : null}
			</section>

			<section className="chat-card mobile-access-pairing">
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("mobileAccess.pairingEyebrow")}</span>
						<h2>{t("mobileAccess.pairingTitle")}</h2>
					</div>
					<Button
						className="chat-button chat-button--primary"
						isDisabled={pendingAction !== undefined || !canCreatePairing}
						onPress={() => void createPairing()}
					>
						{t("mobileAccess.createPairing")}
					</Button>
				</div>
				{canCreatePairing ? null : (
					<p className="mobile-access-pairing__hint" role="status">
						{t("mobileAccess.notReadyHint")}
					</p>
				)}
				{pairing ? (
					<div className="mobile-access-qr">
						{pairing.qr === undefined ? (
							<p role="status">{t("mobileAccess.pairingWaitingUrl")}</p>
						) : qrImageUrl ? (
							<img
								className="mobile-access-qr__image"
								src={qrImageUrl}
								alt={t("mobileAccess.qrAlt")}
							/>
						) : (
							<p role="status">{t("mobileAccess.qrUnavailable")}</p>
						)}
						<div className="mobile-access-qr__meta">
							<span className="mobile-access-qr__code-label">{t("mobileAccess.code")}</span>
							<strong className="mobile-access-qr__code">{pairing.code}</strong>
							{pairing.mobileUrl ? <code>{pairing.mobileUrl}</code> : null}
							{pairingRemainingSeconds === undefined ? null : (
								<span>{t("mobileAccess.expiresIn", formatCountdown(pairingRemainingSeconds))}</span>
							)}
							{pairing.qr ? (
								<details className="mobile-access-qr__payload">
									<summary>{t("mobileAccess.payload")}</summary>
									<pre>{JSON.stringify(pairing.qr, null, 2)}</pre>
								</details>
							) : null}
						</div>
					</div>
				) : (
					<p>{t("mobileAccess.pairingHint")}</p>
				)}
			</section>

			<section
				className="chat-card mobile-access-claims"
				aria-label={t("mobileAccess.claimsTitle")}
			>
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("mobileAccess.claimsEyebrow")}</span>
						<h2>{t("mobileAccess.claimsTitle")}</h2>
					</div>
				</div>
				{claims.length === 0 ? (
					<p>{t("mobileAccess.claimsEmpty")}</p>
				) : (
					claims.map((claim) => (
						<article className="pairing-claim" key={claim.pairingId}>
							<div>
								<strong>{claim.displayName}</strong>
								<span>
									{claim.platform} · {claim.model} · {claim.appVersion}
								</span>
								<code>{claim.publicKeyFingerprint}</code>
							</div>
							<div className="provider-form__actions pairing-claim__actions">
								<Button
									className="chat-button chat-button--primary"
									onPress={() => void approveClaim(claim)}
								>
									{t("mobileAccess.approve")}
								</Button>
								<Button className="chat-button" onPress={() => void rejectClaim(claim)}>
									{t("mobileAccess.reject")}
								</Button>
							</div>
						</article>
					))
				)}
			</section>

			<section
				className="chat-card mobile-access-devices"
				aria-label={t("mobileAccess.devicesTitle")}
			>
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("mobileAccess.devicesEyebrow")}</span>
						<h2>{t("mobileAccess.devicesTitle")}</h2>
					</div>
				</div>
				{devices.length === 0 ? (
					<p>{t("mobileAccess.devicesEmpty")}</p>
				) : (
					devices.map((device) => (
						<article className="mobile-device-card" key={device.mobileClientId}>
							<div className="mobile-device-card__identity">
								<div>
									<strong>{device.displayName}</strong>
									<span>
										{device.platform} · {device.model} · {device.appVersion}
									</span>
									<span>
										{device.lastSeenAt
											? t("mobileAccess.lastSeen", formatTimestamp(device.lastSeenAt))
											: t("mobileAccess.neverSeen")}
									</span>
								</div>
							</div>
							<div className="mobile-device-card__actions">
								{device.revoked ? (
									<span>{t("mobileAccess.revoked")}</span>
								) : (
									<Button
										className="chat-button chat-button--danger"
										onPress={() => void revokeDevice(device)}
									>
										{t("mobileAccess.revoke")}
									</Button>
								)}
							</div>
						</article>
					))
				)}
				{devicesNextCursor === undefined ? null : (
					<div className="mobile-access-devices__more">
						<Button className="chat-button" onPress={() => loadMoreDevices()}>
							{t("mobileAccess.loadMore")}
						</Button>
					</div>
				)}
			</section>
		</section>
	);
}

function isIngressNotReadyError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "MOBILE_INGRESS_NOT_READY" || error.message.includes("MOBILE_INGRESS_NOT_READY");
}

function formatCountdown(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTimestamp(iso: string): string {
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) {
		return iso;
	}
	return new Date(parsed).toLocaleString();
}
