import { Button } from "@heroui/react";
import { type FormEvent, useEffect, useState } from "react";

import type { ChatProviderStatus, ChatTransport } from "./chat/transport";
import { DEFAULT_PROVIDER_ENDPOINT } from "./chat/transport";
import { ConfirmationDialog } from "./confirmation-dialog";
import { type MessageKey, useI18n } from "./i18n";
import { SettingsNavigation } from "./settings-navigation";

export interface ProviderSettingsPageProps {
	transport: ChatTransport;
	onBackToChat(): void;
}

type ProviderFeedback =
	| {
			tone: "info" | "danger";
			message: string;
	  }
	| {
			tone: "info" | "danger";
			messageKey: MessageKey;
			params?: string[];
	  };

export function ProviderSettingsPage({ transport, onBackToChat }: ProviderSettingsPageProps) {
	const { t } = useI18n();
	const [status, setStatus] = useState<ChatProviderStatus>();
	const [endpoint, setEndpoint] = useState(DEFAULT_PROVIDER_ENDPOINT);
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [pendingAction, setPendingAction] = useState<"save" | "test" | "delete">();
	const [feedback, setFeedback] = useState<ProviderFeedback>();
	const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] = useState(false);

	useEffect(() => {
		let active = true;
		void transport
			.getProviderStatus()
			.then((nextStatus) => {
				if (!active) {
					return;
				}
				setStatus(nextStatus);
				setEndpoint(nextStatus.endpoint);
				setModel(nextStatus.model);
			})
			.catch(() => {
				if (active) {
					setFeedback({ tone: "danger", messageKey: "providers.error.load" });
				}
			})
			.finally(() => {
				if (active) {
					setIsLoading(false);
				}
			});

		return () => {
			active = false;
		};
	}, [transport]);

	const getConfiguration = () => {
		const trimmedApiKey = apiKey.trim();
		return {
			endpoint: endpoint.trim(),
			model: model.trim(),
			...(trimmedApiKey.length === 0 ? {} : { apiKey: trimmedApiKey }),
		};
	};

	const validate = (): boolean => {
		if (endpoint.trim().length === 0 || model.trim().length === 0) {
			setFeedback({ tone: "danger", messageKey: "providers.error.required" });
			return false;
		}
		if (!status?.configured && apiKey.trim().length === 0) {
			setFeedback({ tone: "danger", messageKey: "providers.error.apiKeyRequired" });
			return false;
		}
		if (
			status?.configured &&
			apiKey.trim().length === 0 &&
			hasDifferentOrigin(status.endpoint, endpoint.trim())
		) {
			setFeedback({ tone: "danger", messageKey: "providers.error.apiKeyOriginRequired" });
			return false;
		}
		return true;
	};

	const saveProvider = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!validate()) {
			return;
		}

		setPendingAction("save");
		setFeedback(undefined);
		try {
			const nextStatus = await transport.configureProvider(getConfiguration());
			setStatus(nextStatus);
			setEndpoint(nextStatus.endpoint);
			setModel(nextStatus.model);
			setApiKey("");
			setFeedback({ tone: "info", messageKey: "providers.status.saved" });
		} catch {
			setFeedback({ tone: "danger", messageKey: "providers.error.save" });
		} finally {
			setPendingAction(undefined);
		}
	};

	const testProvider = async () => {
		if (!validate()) {
			return;
		}

		setPendingAction("test");
		setFeedback(undefined);
		try {
			const result = await transport.testProvider(getConfiguration());
			setFeedback(
				result.ok
					? {
							tone: "info",
							messageKey: "providers.status.testPassed",
							params: [String(result.latencyMs)],
						}
					: result.errorMessage
						? { tone: "danger", message: result.errorMessage }
						: { tone: "danger", messageKey: "providers.error.test" },
			);
		} catch {
			setFeedback({ tone: "danger", messageKey: "providers.error.test" });
		} finally {
			setPendingAction(undefined);
		}
	};

	const deleteProvider = async () => {
		setPendingAction("delete");
		setFeedback(undefined);
		try {
			const nextStatus = await transport.deleteProvider();
			setStatus(nextStatus);
			setEndpoint(nextStatus.endpoint);
			setModel(nextStatus.model);
			setApiKey("");
			setFeedback({ tone: "info", messageKey: "providers.status.deleted" });
		} catch {
			setFeedback({ tone: "danger", messageKey: "providers.error.delete" });
		} finally {
			setPendingAction(undefined);
			setIsDeleteConfirmationOpen(false);
		}
	};

	return (
		<section className="provider-settings-page">
			<SettingsNavigation />

			<header className="provider-settings-page__header">
				<div>
					<span className="chat-page__eyebrow">{t("providers.eyebrow")}</span>
					<h1>{t("providers.title")}</h1>
					<p>{t("providers.description")}</p>
				</div>
				<Button className="chat-button" onPress={onBackToChat}>
					{t("providers.backToChat")}
				</Button>
			</header>

			{isLoading ? (
				<p className="chat-loading" role="status">
					{t("providers.loading")}
				</p>
			) : (
				<div className="provider-settings-grid">
					<form className="chat-card provider-form" onSubmit={(event) => void saveProvider(event)}>
						<div className="provider-status-row">
							<div>
								<span className="chat-card__eyebrow">{t("providers.providerType")}</span>
								<h2>{t("providers.openAiCompatible")}</h2>
							</div>
							<span
								className={
									status?.configured ? "provider-status provider-status--ready" : "provider-status"
								}
							>
								{status?.configured ? t("providers.configured") : t("providers.notConfigured")}
							</span>
						</div>

						<label className="chat-field">
							<span>{t("providers.endpoint")}</span>
							<input
								type="url"
								required
								value={endpoint}
								disabled={pendingAction !== undefined}
								onChange={(event) => setEndpoint(event.currentTarget.value)}
							/>
						</label>

						<label className="chat-field">
							<span>{t("providers.model")}</span>
							<input
								required
								maxLength={200}
								value={model}
								disabled={pendingAction !== undefined}
								placeholder={t("providers.modelPlaceholder")}
								onChange={(event) => setModel(event.currentTarget.value)}
							/>
						</label>

						<label className="chat-field">
							<span>{t("providers.apiKey")}</span>
							<input
								type="password"
								autoComplete="off"
								aria-label={t("providers.apiKey")}
								value={apiKey}
								disabled={pendingAction !== undefined}
								placeholder={
									status?.configured
										? t("providers.apiKeyConfigured", status.apiKeyMask ?? "")
										: t("providers.apiKeyPlaceholder")
								}
								onChange={(event) => setApiKey(event.currentTarget.value)}
							/>
							<small className="chat-field__hint">
								{status?.configured
									? t("providers.apiKeyKeepHint")
									: t("providers.apiKeyLocalHint")}
							</small>
						</label>

						{feedback ? (
							<div
								className={`chat-notice chat-notice--${feedback.tone}`}
								role={feedback.tone === "danger" ? "alert" : "status"}
							>
								{"message" in feedback
									? feedback.message
									: t(feedback.messageKey, ...(feedback.params ?? []))}
							</div>
						) : null}

						<div className="provider-form__actions">
							<Button
								className="chat-button"
								isDisabled={pendingAction !== undefined}
								onPress={() => void testProvider()}
							>
								{pendingAction === "test" ? t("providers.testing") : t("providers.test")}
							</Button>
							<Button
								type="submit"
								className="chat-button chat-button--primary"
								isDisabled={pendingAction !== undefined}
							>
								{pendingAction === "save" ? t("providers.saving") : t("providers.save")}
							</Button>
						</div>
					</form>

					<aside className="chat-card provider-security-card">
						<span className="chat-card__eyebrow">{t("providers.storageEyebrow")}</span>
						<h2>{t("providers.storageTitle")}</h2>
						<p>{t("providers.storageDescription")}</p>
						{status?.configured ? (
							<div className="provider-danger-zone">
								<h3>{t("providers.delete.title")}</h3>
								<p>{t("providers.delete.description")}</p>
								<ConfirmationDialog
									isOpen={isDeleteConfirmationOpen}
									isPending={pendingAction === "delete"}
									isTriggerDisabled={pendingAction !== undefined}
									triggerLabel={t("providers.delete.action")}
									triggerClassName="confirmation-dialog-trigger confirmation-dialog-trigger--danger"
									title={t("providers.delete.title")}
									description={t("providers.delete.confirm")}
									cancelLabel={t("action.cancel")}
									confirmLabel={t("providers.delete.action")}
									pendingLabel={t("providers.deleting")}
									onOpenChange={setIsDeleteConfirmationOpen}
									onConfirm={deleteProvider}
								/>
							</div>
						) : null}
					</aside>
				</div>
			)}
		</section>
	);
}

function hasDifferentOrigin(currentEndpoint: string, nextEndpoint: string): boolean {
	try {
		return new URL(currentEndpoint).origin !== new URL(nextEndpoint).origin;
	} catch {
		return false;
	}
}
