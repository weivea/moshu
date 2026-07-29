import { Button } from "@heroui/react";
import type {
	CreateRuntimeBoxPairingOutput,
	RemoteAccessAuthAttempt,
	RemoteAccessStatusOutput,
	RuntimeBoxPairingClaim,
} from "@moshu/contracts";
import { useCallback, useEffect, useState } from "react";
import { desktopClient } from "../../lib/rpc";
import { useI18n } from "../i18n";
import { useRuntimeBoxes } from "../runtime-boxes";

export function RuntimeBoxesSettingsPage() {
	const { t } = useI18n();
	const runtimeBoxes = useRuntimeBoxes();
	const [remoteAccess, setRemoteAccess] = useState<RemoteAccessStatusOutput>();
	const [authAttempt, setAuthAttempt] = useState<RemoteAccessAuthAttempt>();
	const [pairing, setPairing] = useState<CreateRuntimeBoxPairingOutput>();
	const [claims, setClaims] = useState<RuntimeBoxPairingClaim[]>([]);
	const [pendingAction, setPendingAction] = useState<string>();
	const [errorMessage, setErrorMessage] = useState<string>();

	const loadRemoteAccess = useCallback(async () => {
		try {
			setRemoteAccess(await desktopClient.getRemoteAccessStatus());
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : t("runtimeBoxes.error.remoteAccess"),
			);
		}
	}, [t]);

	const loadClaims = useCallback(async () => {
		try {
			setClaims((await desktopClient.listRuntimeBoxPairingClaims()).items);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("runtimeBoxes.error.claims"));
		}
	}, [t]);

	useEffect(() => {
		void loadRemoteAccess();
		const timer = setInterval(() => void loadRemoteAccess(), 2_000);
		return () => clearInterval(timer);
	}, [loadRemoteAccess]);

	useEffect(() => {
		void loadClaims();
		const timer = setInterval(() => void loadClaims(), 1_000);
		return () => clearInterval(timer);
	}, [loadClaims]);

	useEffect(() => {
		if (authAttempt?.status !== "running") {
			return;
		}
		const timer = setInterval(() => {
			void desktopClient
				.getRemoteAccessAuthentication(authAttempt.attemptId)
				.then((attempt) => {
					setAuthAttempt(attempt);
					if (attempt.status === "succeeded") {
						void loadRemoteAccess();
					}
				})
				.catch((error: unknown) =>
					setErrorMessage(
						error instanceof Error ? error.message : t("runtimeBoxes.error.authentication"),
					),
				);
		}, 750);
		return () => clearInterval(timer);
	}, [authAttempt, loadRemoteAccess, t]);

	const runRemoteMutation = async (
		action: string,
		mutate: () => Promise<{ status: RemoteAccessStatusOutput }>,
	) => {
		setPendingAction(action);
		setErrorMessage(undefined);
		try {
			setRemoteAccess((await mutate()).status);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("runtimeBoxes.error.mutation"));
		} finally {
			setPendingAction(undefined);
		}
	};

	const createPairing = async () => {
		setPendingAction("pair");
		setErrorMessage(undefined);
		try {
			setPairing(await desktopClient.createRuntimeBoxPairing());
			await loadClaims();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : t("runtimeBoxes.error.pairing"));
		} finally {
			setPendingAction(undefined);
		}
	};

	return (
		<section className="settings-section runtime-boxes-settings">
			<header className="settings-section__header">
				<span className="chat-page__eyebrow">{t("runtimeBoxes.eyebrow")}</span>
				<h1>{t("runtimeBoxes.title")}</h1>
				<p>{t("runtimeBoxes.description")}</p>
			</header>

			{errorMessage ? (
				<p className="session-sidebar__error" role="alert">
					{errorMessage}
				</p>
			) : null}

			<section className="chat-card runtime-boxes-list" aria-label={t("runtimeBoxes.list")}>
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("runtimeBoxes.listEyebrow")}</span>
						<h2>{t("runtimeBoxes.list")}</h2>
					</div>
					<Button className="chat-button" onPress={() => void runtimeBoxes.refresh()}>
						{t("runtimeBoxes.refresh")}
					</Button>
				</div>
				{runtimeBoxes.snapshot.items.map((item) => {
					const descriptor = item.runtimeBox;
					const active = descriptor.runtimeBoxId === runtimeBoxes.snapshot.active.runtimeBoxId;
					return (
						<article className="runtime-box-card" key={descriptor.runtimeBoxId}>
							<div className="runtime-box-card__identity">
								<i className={item.connected ? "is-online" : "is-offline"} aria-hidden="true" />
								<div>
									<strong>{descriptor.displayName}</strong>
									<span>
										{descriptor.kind} · {descriptor.platform}/{descriptor.arch} ·{" "}
										{descriptor.runtimeBoxVersion}
									</span>
								</div>
							</div>
							<div className="runtime-box-card__actions">
								<span>{item.connected ? t("runtimeBoxes.online") : t("runtimeBoxes.offline")}</span>
								<Button
									className="chat-button"
									isDisabled={active}
									onPress={() => void runtimeBoxes.switchRuntimeBox(descriptor.runtimeBoxId)}
								>
									{active ? t("runtimeBoxes.active") : t("runtimeBoxes.switch")}
								</Button>
								{descriptor.kind === "remote"
									? item.deviceKeyIds.map((deviceKeyId) => (
											<Button
												key={deviceKeyId}
												className="chat-button chat-button--danger"
												onPress={() =>
													void desktopClient
														.revokeRuntimeBoxDevice({
															runtimeBoxId: descriptor.runtimeBoxId,
															deviceKeyId,
														})
														.then(() => runtimeBoxes.refresh())
												}
											>
												{t("runtimeBoxes.revoke")}
											</Button>
										))
									: null}
							</div>
						</article>
					);
				})}
			</section>

			<section className="chat-card remote-access-card">
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("remoteAccess.eyebrow")}</span>
						<h2>{t("remoteAccess.title")}</h2>
					</div>
					<strong>{remoteAccess?.state ?? t("remoteAccess.loading")}</strong>
				</div>
				<p>{t("remoteAccess.description")}</p>
				{remoteAccess?.publicUrl ? <code>{remoteAccess.publicUrl}</code> : null}
				{remoteAccess?.lastError ? <p role="alert">{remoteAccess.lastError}</p> : null}
				<div className="provider-form__actions">
					<Button
						className="chat-button"
						isDisabled={pendingAction !== undefined || authAttempt?.status === "running"}
						onPress={() =>
							void desktopClient.startRemoteAccessAuthentication().then(setAuthAttempt)
						}
					>
						{t("remoteAccess.authenticate")}
					</Button>
					<Button
						className="chat-button chat-button--primary"
						isDisabled={pendingAction !== undefined || remoteAccess?.enabled === true}
						onPress={() =>
							void runRemoteMutation("enable", () => desktopClient.enableRemoteAccess())
						}
					>
						{t("remoteAccess.enable")}
					</Button>
					<Button
						className="chat-button"
						isDisabled={pendingAction !== undefined || remoteAccess?.enabled !== true}
						onPress={() =>
							void runRemoteMutation("disable", () => desktopClient.disableRemoteAccess())
						}
					>
						{t("remoteAccess.disable")}
					</Button>
					<Button
						className="chat-button"
						isDisabled={pendingAction !== undefined}
						onPress={() =>
							void runRemoteMutation("recreate", () => desktopClient.recreateRemoteAccess())
						}
					>
						{t("remoteAccess.recreate")}
					</Button>
				</div>
				{authAttempt ? <pre className="runtime-box-auth-output">{authAttempt.message}</pre> : null}
			</section>

			<section className="chat-card pairing-card">
				<div className="chat-card__header chat-card__header--compact">
					<div>
						<span className="chat-card__eyebrow">{t("runtimeBoxes.pairingEyebrow")}</span>
						<h2>{t("runtimeBoxes.pairingTitle")}</h2>
					</div>
					<Button
						className="chat-button chat-button--primary"
						isDisabled={pendingAction !== undefined || remoteAccess?.state !== "online"}
						onPress={() => void createPairing()}
					>
						{t("runtimeBoxes.addRemote")}
					</Button>
				</div>
				{pairing ? (
					<div className="pairing-code">
						<strong>{pairing.code}</strong>
						{pairing.runtimeBaseUrl ? <code>{pairing.runtimeBaseUrl}</code> : null}
						<span>{pairing.expiresAt}</span>
					</div>
				) : (
					<p>{t("runtimeBoxes.pairingHint")}</p>
				)}
				{claims.map((claim) => (
					<article className="pairing-claim" key={claim.pairingId}>
						<div>
							<strong>{claim.displayName}</strong>
							<span>
								{claim.platform}/{claim.arch}
							</span>
							<code>{claim.publicKeyFingerprint}</code>
						</div>
						<div className="provider-form__actions pairing-claim__actions">
							<Button
								className="chat-button chat-button--primary"
								onPress={() =>
									void desktopClient
										.approveRuntimeBoxPairing({
											pairingId: claim.pairingId,
											expectedPublicKeyFingerprint: claim.publicKeyFingerprint,
										})
										.then(async () => {
											await loadClaims();
											await runtimeBoxes.refresh();
										})
								}
							>
								{t("runtimeBoxes.approve")}
							</Button>
							<Button
								className="chat-button"
								onPress={() =>
									void desktopClient
										.rejectRuntimeBoxPairing({ pairingId: claim.pairingId })
										.then(loadClaims)
								}
							>
								{t("runtimeBoxes.reject")}
							</Button>
						</div>
					</article>
				))}
			</section>
		</section>
	);
}
