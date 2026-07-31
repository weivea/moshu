import { Button, Spinner } from "@heroui/react";
import { AppIcon } from "@moshu/ui";
import { useState } from "react";
import { useConnection } from "../app/connection";
import { useI18n } from "../app/i18n";
import type { MessageKey } from "../app/i18n";
import { isNativeTransportAvailable } from "../native";
import type { FatalConnectionCode, PairingWaitingInfo } from "../rpc/connection-controller";
import { CenteredState } from "../components/layout";

export function SplashScreen() {
	const { t } = useI18n();
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4">
			<Spinner aria-label={t("common.loading")} />
		</div>
	);
}

export function OnboardingScreen({ onScan }: { onScan: () => void }) {
	const { t } = useI18n();
	const requirements: MessageKey[] = [
		"onboarding.requirement.desktop",
		"onboarding.requirement.qr",
		"onboarding.requirement.single",
	];
	return (
		<div className="safe-top safe-x flex h-full flex-col justify-between px-6 pb-8 pt-10">
			<div className="flex flex-1 flex-col justify-center gap-6">
				<div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[var(--accent-soft)] text-[var(--accent)]">
					<AppIcon name="smartphone" size={32} />
				</div>
				<div className="space-y-2">
					<h1 className="text-2xl font-semibold text-[var(--text)]">{t("onboarding.title")}</h1>
					<p className="text-sm text-[var(--text-muted)]">{t("onboarding.body")}</p>
				</div>
				<ul className="space-y-3">
					{requirements.map((key) => (
						<li key={key} className="flex items-start gap-3 text-sm text-[var(--text)]">
							<span className="mt-0.5 text-[var(--accent)]">
								<AppIcon name="check" size={18} />
							</span>
							<span>{t(key)}</span>
						</li>
					))}
				</ul>
			</div>
			<Button variant="primary" size="lg" fullWidth onPress={onScan}>
				{t("onboarding.scan")}
			</Button>
		</div>
	);
}

export function ScanScreen({ onDone }: { onDone: () => void }) {
	const { t } = useI18n();
	const { controller } = useConnection();
	const [manual, setManual] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const cameraAvailable = isNativeTransportAvailable();

	async function pair(qr: string): Promise<void> {
		const trimmed = qr.trim();
		if (!trimmed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await controller.beginPairing(trimmed);
			onDone();
		} catch {
			// beginPairing already reset to unpaired; surface a non-secret hint.
			setError(t("scan.invalid"));
		} finally {
			setBusy(false);
		}
	}

	async function scanWithCamera(): Promise<void> {
		setError(null);
		try {
			const result = await controller.scanQr();
			if (result.status === "scanned") {
				await pair(result.qr);
			} else if (result.status === "unavailable") {
				setError(t("scan.cameraUnavailable"));
			}
		} catch {
			setError(t("scan.cameraUnavailable"));
		}
	}

	return (
		<div className="safe-top safe-x flex h-full flex-col gap-6 px-6 pb-8 pt-10">
			<div className="space-y-2">
				<h1 className="text-2xl font-semibold text-[var(--text)]">{t("scan.title")}</h1>
				<p className="text-sm text-[var(--text-muted)]">{t("scan.body")}</p>
			</div>

			{cameraAvailable ? (
				<Button variant="primary" size="lg" fullWidth isDisabled={busy} onPress={scanWithCamera}>
					{t("onboarding.scan")}
				</Button>
			) : null}

			<div className="space-y-2">
				<label htmlFor="manual-qr" className="text-sm font-medium text-[var(--text)]">
					{t("scan.manual")}
				</label>
				<textarea
					id="manual-qr"
					value={manual}
					onChange={(event) => setManual(event.target.value)}
					placeholder={t("scan.manualPlaceholder")}
					rows={3}
					className="w-full resize-none rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] p-3 text-[var(--text)] outline-none focus:border-[var(--accent)]"
				/>
				<Button
					variant="secondary"
					fullWidth
					isDisabled={busy || manual.trim().length === 0}
					onPress={() => void pair(manual)}
				>
					{t("scan.manualSubmit")}
				</Button>
			</div>

			{error ? (
				<p role="alert" className="text-sm text-[var(--danger)]">
					{error}
				</p>
			) : null}

			<Button variant="ghost" fullWidth isDisabled={busy} onPress={onDone}>
				{t("scan.cancel")}
			</Button>
		</div>
	);
}

export function PairingClaimingScreen() {
	const { t } = useI18n();
	return <CenteredState title={t("conn.connecting")} body={t("conn.preparing")} />;
}

export function WaitingScreen({ info }: { info: PairingWaitingInfo }) {
	const { t } = useI18n();
	const { controller } = useConnection();
	return (
		<div className="safe-top safe-x flex h-full flex-col justify-between px-6 pb-8 pt-10">
			<div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
				<Spinner aria-label={t("conn.waiting.title")} />
				<div className="space-y-2">
					<h1 className="text-xl font-semibold text-[var(--text)]">{t("conn.waiting.title")}</h1>
					<p className="text-sm text-[var(--text-muted)]">{t("conn.waiting.body")}</p>
				</div>
				<dl className="card w-full space-y-3 p-4 text-left text-sm">
					<div className="flex items-center justify-between gap-3">
						<dt className="text-[var(--text-muted)]">{t("conn.waiting.device")}</dt>
						<dd className="font-medium text-[var(--text)]">{info.deviceDisplayName}</dd>
					</div>
					<div className="flex items-center justify-between gap-3">
						<dt className="text-[var(--text-muted)]">{t("conn.waiting.fingerprint")}</dt>
						<dd className="font-mono text-xs text-[var(--text)]">
							{info.serverPublicKeyFingerprint}
						</dd>
					</div>
				</dl>
			</div>
			<Button variant="ghost" fullWidth onPress={() => void controller.cancelPairing()}>
				{t("conn.waiting.cancel")}
			</Button>
		</div>
	);
}

export function ConnectingScreen({ reconnecting }: { reconnecting?: boolean }) {
	const { t } = useI18n();
	return (
		<CenteredState
			title={reconnecting ? t("conn.reconnecting") : t("conn.connecting")}
			body={t("conn.preparing")}
		/>
	);
}

export function OfflineScreen() {
	const { t } = useI18n();
	const { controller } = useConnection();
	return (
		<CenteredState icon="globe" title={t("conn.offline.title")} body={t("conn.offline.body")}>
			<Button variant="secondary" fullWidth onPress={() => void controller.retry()}>
				{t("conn.offline.retry")}
			</Button>
		</CenteredState>
	);
}

const fatalCopy: Record<FatalConnectionCode, { title: MessageKey; body: MessageKey }> = {
	"auth-revoked": { title: "error.authRevoked.title", body: "error.authRevoked.body" },
	"protocol-mismatch": { title: "error.protocolMismatch.title", body: "error.protocolMismatch.body" },
	"identity-mismatch": { title: "error.identityMismatch.title", body: "error.identityMismatch.body" },
	"url-invalid": { title: "error.urlInvalid.title", body: "error.urlInvalid.body" },
	"pairing-rejected": { title: "error.pairingRejected.title", body: "error.pairingRejected.body" },
};

/**
 * Fatal states are never blindly retried: a revoked/mismatched/invalid binding cannot be recovered
 * by reconnecting. The only safe action is to unpair and pair again, so we offer exactly that.
 */
export function FatalErrorScreen({ code }: { code: FatalConnectionCode }) {
	const { t } = useI18n();
	const { controller } = useConnection();
	const [busy, setBusy] = useState(false);
	const copy = fatalCopy[code];
	return (
		<CenteredState icon="settings" title={t(copy.title)} body={t(copy.body)}>
			<Button
				variant="danger"
				fullWidth
				isDisabled={busy}
				onPress={() => {
					setBusy(true);
					void controller.unpair();
				}}
			>
				{t("error.unpairAction")}
			</Button>
		</CenteredState>
	);
}
