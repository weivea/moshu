import { Button } from "@heroui/react";
import type {
	AuthChallenge,
	AuthNotification,
	ProviderAuthAttempt,
	ProviderAuthType,
	ProviderSummary,
} from "@moshu/contracts";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import type { ChatTransport } from "../../chat/transport";
import { useI18n } from "../../i18n";

const pollDelayMs = 750;

export interface ProviderAuthPanelProps {
	provider: ProviderSummary;
	transport: ChatTransport;
	onProviderChanged(): Promise<void> | void;
}

export function ProviderAuthPanel({
	provider,
	transport,
	onProviderChanged,
}: ProviderAuthPanelProps) {
	const { t } = useI18n();
	const fieldId = useId();
	const [attempt, setAttempt] = useState<ProviderAuthAttempt>();
	const [response, setResponse] = useState("");
	const [pending, setPending] = useState<"start" | "respond" | "cancel" | "logout">();
	const [error, setError] = useState<string>();
	const mounted = useRef(true);
	const previousProviderId = useRef(provider.id);
	const activeAttemptId = useRef<string | undefined>(undefined);
	activeAttemptId.current =
		attempt !== undefined && !isTerminal(attempt.status) ? attempt.id : undefined;

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const attemptId = activeAttemptId.current;
			window.setTimeout(() => {
				if (!mounted.current && attemptId !== undefined) {
					void transport.cancelProviderAuth(attemptId).catch(() => undefined);
				}
			}, 0);
		};
	}, [transport]);

	useEffect(() => {
		if (attempt === undefined || isTerminal(attempt.status)) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void transport
				.getProviderAuth(attempt.id)
				.then(async (next) => {
					if (cancelled) return;
					setAttempt(next);
					if (next.status === "completed") await onProviderChanged();
				})
				.catch(() => {
					if (!cancelled) {
						setError(t("providers.auth.error"));
						setAttempt((current) => (current === undefined ? current : { ...current }));
					}
				});
		}, pollDelayMs);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [attempt, onProviderChanged, t, transport]);

	useEffect(() => {
		if (previousProviderId.current === provider.id) return;
		previousProviderId.current = provider.id;
		setAttempt(undefined);
		setResponse("");
		setError(undefined);
	}, [provider.id]);

	const start = async (authType: ProviderAuthType) => {
		setPending("start");
		setError(undefined);
		try {
			const next = await transport.startProviderAuth(provider.id, authType);
			setAttempt(next);
			if (next.status === "completed") await onProviderChanged();
		} catch {
			setError(t("providers.auth.error"));
		} finally {
			setPending(undefined);
		}
	};

	const respond = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const challenge = attempt?.challenge;
		if (attempt === undefined || challenge === undefined) return;
		const value = response;
		setResponse("");
		setPending("respond");
		setError(undefined);
		try {
			setAttempt(await transport.respondProviderAuth(attempt.id, challenge.id, value));
		} catch {
			setError(t("providers.auth.error"));
		} finally {
			setPending(undefined);
		}
	};

	const cancel = async () => {
		if (attempt === undefined) return;
		setPending("cancel");
		try {
			setAttempt(await transport.cancelProviderAuth(attempt.id));
		} finally {
			setPending(undefined);
		}
	};

	const logout = async () => {
		setPending("logout");
		setError(undefined);
		try {
			if (activeAttemptId.current !== undefined) {
				await transport.cancelProviderAuth(activeAttemptId.current);
			}
			await transport.logoutProvider(provider.id);
			setAttempt(undefined);
			setResponse("");
			await onProviderChanged();
		} catch {
			setError(t("providers.auth.logoutError"));
		} finally {
			setPending(undefined);
		}
	};

	return (
		<section className="chat-card provider-auth" aria-labelledby={`${fieldId}-title`}>
			<div className="provider-auth__header">
				<div>
					<h2 id={`${fieldId}-title`}>{t("providers.auth.title")}</h2>
					<p>
						{provider.credential.configured
							? t(
									"providers.auth.configured",
									provider.credential.type === "oauth"
										? t("providers.auth.oauth")
										: t("providers.auth.apiKey"),
									provider.credential.label ?? provider.displayName,
								)
							: t("providers.auth.notConfigured")}
					</p>
				</div>
				<span
					className={
						provider.credential.configured
							? "provider-status provider-status--ready"
							: "provider-status"
					}
				>
					{provider.credential.configured
						? t("providers.auth.ready")
						: t("providers.auth.required")}
				</span>
			</div>

			<div className="provider-auth__actions">
				{provider.authMethods.map((method) => (
					<Button
						key={method}
						className="chat-button"
						isDisabled={
							pending !== undefined || (attempt !== undefined && !isTerminal(attempt.status))
						}
						onPress={() => void start(method)}
					>
						{provider.credential.configured
							? t("providers.auth.replace", authLabel(method, t))
							: t("providers.auth.login", authLabel(method, t))}
					</Button>
				))}
				{provider.credential.configured ? (
					<Button
						className="chat-button chat-button--danger"
						isDisabled={pending !== undefined}
						onPress={() => void logout()}
					>
						{pending === "logout" ? t("providers.auth.loggingOut") : t("providers.auth.logout")}
					</Button>
				) : null}
			</div>

			{attempt === undefined ? null : (
				<div className="provider-auth__attempt">
					<p className="provider-auth__status" role="status" aria-live="polite">
						{attempt.error ?? t(`providers.auth.status.${attempt.status}`)}
					</p>
					<NotificationList notifications={attempt.notifications} transport={transport} />
					{attempt.challenge === undefined ? null : (
						<form onSubmit={respond}>
							<AuthChallengeField
								challenge={attempt.challenge}
								fieldId={fieldId}
								value={response}
								onChange={setResponse}
							/>
							<Button
								type="submit"
								className="chat-button chat-button--primary"
								isDisabled={
									pending !== undefined || !canSubmitChallenge(attempt.challenge, response)
								}
							>
								{pending === "respond"
									? t("providers.auth.submitting")
									: t("providers.auth.submit")}
							</Button>
						</form>
					)}
					{isTerminal(attempt.status) ? null : (
						<Button
							className="chat-button"
							isDisabled={pending !== undefined}
							onPress={() => void cancel()}
						>
							{t("providers.auth.cancel")}
						</Button>
					)}
				</div>
			)}
			{error === undefined ? null : (
				<p className="chat-notice chat-notice--danger" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

function AuthChallengeField({
	challenge,
	fieldId,
	value,
	onChange,
}: {
	challenge: AuthChallenge;
	fieldId: string;
	value: string;
	onChange(value: string): void;
}) {
	const { t } = useI18n();
	const id = `${fieldId}-challenge`;
	return (
		<label className="chat-field" htmlFor={id}>
			<span>{challenge.message}</span>
			{challenge.type === "select" ? (
				<select id={id} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
					<option value="">{t("providers.auth.selectPrompt")}</option>
					{challenge.options.map((option) => (
						<option key={option.id} value={option.id}>
							{option.label}
							{option.description === undefined ? "" : ` — ${option.description}`}
						</option>
					))}
				</select>
			) : (
				<input
					id={id}
					type={challenge.type === "secret" ? "password" : "text"}
					autoComplete="off"
					value={value}
					placeholder={challenge.placeholder}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
			)}
		</label>
	);
}

function NotificationList({
	notifications,
	transport,
}: {
	notifications: AuthNotification[];
	transport: ChatTransport;
}) {
	const { t } = useI18n();
	if (notifications.length === 0) return null;
	const occurrences = new Map<AuthNotification["type"], number>();
	return (
		<ul className="provider-auth__notifications" aria-label={t("providers.auth.updates")}>
			{notifications.map((notification) => {
				const occurrence = occurrences.get(notification.type) ?? 0;
				occurrences.set(notification.type, occurrence + 1);
				return (
					<li key={`${notification.type}-${occurrence}`}>
						<Notification notification={notification} transport={transport} />
					</li>
				);
			})}
		</ul>
	);
}

function Notification({
	notification,
	transport,
}: {
	notification: AuthNotification;
	transport: ChatTransport;
}) {
	const { t } = useI18n();
	if (notification.type === "info") {
		return (
			<>
				<p>{notification.message}</p>
				{notification.links?.map((link) => (
					<ExternalLink key={link.url} url={link.url} transport={transport}>
						{link.label ?? link.url}
					</ExternalLink>
				))}
			</>
		);
	}
	if (notification.type === "auth_url") {
		return (
			<>
				{notification.instructions === undefined ? null : <p>{notification.instructions}</p>}
				<ExternalLink url={notification.url} transport={transport}>
					{t("providers.auth.openBrowser")}
				</ExternalLink>
				<code>{notification.url}</code>
			</>
		);
	}
	if (notification.type === "device_code") {
		return (
			<>
				<p>{t("providers.auth.deviceCode")}</p>
				<code>{notification.userCode}</code>
				<ExternalLink url={notification.verificationUri} transport={transport}>
					{notification.verificationUri}
				</ExternalLink>
				{notification.expiresInSeconds === undefined ? null : (
					<small>{t("providers.auth.expires", String(notification.expiresInSeconds))}</small>
				)}
			</>
		);
	}

	function ExternalLink({
		url,
		transport,
		children,
	}: {
		url: string;
		transport: ChatTransport;
		children: ReactNode;
	}) {
		return (
			<a
				href={url}
				target="_blank"
				rel="noreferrer"
				onClick={(event) => {
					event.preventDefault();
					void transport.openExternalUrl(url);
				}}
			>
				{children}
			</a>
		);
	}
	return <p>{notification.message}</p>;
}

function isTerminal(status: ProviderAuthAttempt["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function canSubmitChallenge(challenge: AuthChallenge, response: string): boolean {
	return challenge.type === "text" || response.length > 0;
}

function authLabel(method: ProviderAuthType, t: ReturnType<typeof useI18n>["t"]): string {
	return method === "oauth" ? t("providers.auth.oauth") : t("providers.auth.apiKey");
}
