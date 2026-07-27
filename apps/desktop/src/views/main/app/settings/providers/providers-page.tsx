import { Button } from "@heroui/react";
import type { CreateProviderInput, ProviderSummary, UpdateProviderInput } from "@moshu/contracts";
import { useCallback, useEffect, useState } from "react";

import type { ChatTransport } from "../../chat/transport";
import { type MessageKey, useI18n } from "../../i18n";
import { providerTypeLabelKey } from "../provider-shared";
import { AddProviderDialog } from "./add-provider-dialog";
import { ProviderForm, type ProviderFormAction } from "./provider-form";
import { ProviderModelList } from "./provider-model-list";

export interface ProvidersSettingsPageProps {
	transport: ChatTransport;
}

type Feedback =
	| { tone: "info" | "danger"; message: string }
	| { tone: "info" | "danger"; messageKey: MessageKey; params?: string[] };

type PendingAction = ProviderFormAction | "create" | "fetch-models" | "save-models";

export function ProvidersSettingsPage({ transport }: ProvidersSettingsPageProps) {
	const { t } = useI18n();
	const [providers, setProviders] = useState<ProviderSummary[]>([]);
	const [selectedProviderId, setSelectedProviderId] = useState<string>();
	const [isLoading, setIsLoading] = useState(true);
	const [isAdding, setIsAdding] = useState(false);
	const [pendingAction, setPendingAction] = useState<PendingAction>();
	const [feedback, setFeedback] = useState<Feedback>();
	const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);

	useEffect(() => {
		let active = true;
		void transport
			.listProviders()
			.then((nextProviders) => {
				if (!active) {
					return;
				}
				setProviders(nextProviders);
				setSelectedProviderId((current) =>
					current !== undefined && nextProviders.some((provider) => provider.id === current)
						? current
						: nextProviders[0]?.id,
				);
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

	const replaceProvider = useCallback((provider: ProviderSummary) => {
		setProviders((current) =>
			current.map((candidate) => (candidate.id === provider.id ? provider : candidate)),
		);
	}, []);

	const run = useCallback(
		async (
			action: PendingAction,
			errorKey: MessageKey,
			execute: () => Promise<Feedback | undefined>,
		) => {
			setPendingAction(action);
			setFeedback(undefined);
			try {
				setFeedback(await execute());
			} catch {
				setFeedback({ tone: "danger", messageKey: errorKey });
			} finally {
				setPendingAction(undefined);
			}
		},
		[],
	);

	const createProvider = (input: CreateProviderInput) =>
		void run("create", "providers.error.create", async () => {
			const provider = await transport.createProvider(input);
			setProviders((current) => [...current, provider]);
			setSelectedProviderId(provider.id);
			setIsAdding(false);
			return { tone: "info", messageKey: "providers.status.created" };
		});

	const saveProvider = (input: UpdateProviderInput) =>
		void run("save", "providers.error.save", async () => {
			replaceProvider(await transport.updateProvider(input));
			return { tone: "info", messageKey: "providers.status.saved" };
		});

	const deleteProvider = (providerId: string) =>
		void run("delete", "providers.error.delete", async () => {
			await transport.deleteProvider(providerId);
			setProviders((current) => {
				const next = current.filter((provider) => provider.id !== providerId);
				setSelectedProviderId(next[0]?.id);
				return next;
			});
			return { tone: "info", messageKey: "providers.status.deleted" };
		});

	const testProvider = (providerId: string) =>
		void run("test", "providers.error.test", async () => {
			const result = await transport.testProvider({ schemaVersion: 1, providerId });
			if (result.ok) {
				return {
					tone: "info",
					messageKey: "providers.status.testPassed",
					params: [String(result.latencyMs)],
				};
			}
			return result.errorMessage === undefined
				? { tone: "danger", messageKey: "providers.error.test" }
				: { tone: "danger", message: result.errorMessage };
		});

	const fetchModels = (providerId: string) =>
		void run("fetch-models", "providers.error.fetchModels", async () => {
			const provider = await transport.fetchProviderModels(providerId);
			replaceProvider(provider);
			return {
				tone: "info",
				messageKey: "providers.status.modelsFetched",
				params: [String(provider.models.length)],
			};
		});

	const saveEnabledModels = (providerId: string, enabledModelIds: string[]) =>
		void run("save-models", "providers.error.saveModels", async () => {
			replaceProvider(await transport.setProviderModelsEnabled(providerId, enabledModelIds));
			return { tone: "info", messageKey: "providers.status.modelsSaved" };
		});

	return (
		<section className="settings-section providers-settings">
			<header className="settings-section__header">
				<h1>{t("providers.title")}</h1>
				<p>{t("providers.description")}</p>
			</header>

			{feedback === undefined ? null : (
				<div
					className={`chat-notice chat-notice--${feedback.tone}`}
					role={feedback.tone === "danger" ? "alert" : "status"}
				>
					{"message" in feedback
						? feedback.message
						: t(feedback.messageKey, ...(feedback.params ?? []))}
				</div>
			)}

			{isLoading ? (
				<p className="chat-loading" role="status">
					{t("providers.loading")}
				</p>
			) : (
				<div className="providers-settings__layout">
					<aside className="providers-settings__list" aria-label={t("providers.listLabel")}>
						{providers.length === 0 ? (
							<div className="providers-settings__empty">
								<p>{t("providers.empty")}</p>
								<p className="provider-models__hint">{t("providers.emptyHint")}</p>
							</div>
						) : (
							<ul>
								{providers.map((provider) => (
									<li key={provider.id}>
										<button
											type="button"
											className={
												provider.id === selectedProviderId
													? "providers-settings__item is-active"
													: "providers-settings__item"
											}
											aria-current={provider.id === selectedProviderId}
											onClick={() => {
												setSelectedProviderId(provider.id);
												setIsAdding(false);
											}}
										>
											<span className="providers-settings__item-name">{provider.displayName}</span>
											<span className="providers-settings__item-meta">
												{t(providerTypeLabelKey(provider.type))}
											</span>
											<span
												className={
													provider.enabled
														? "provider-status provider-status--ready"
														: "provider-status"
												}
											>
												{provider.enabled ? t("providers.enabled") : t("providers.disabled")}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						<Button
							className="chat-button"
							isDisabled={pendingAction !== undefined}
							onPress={() => setIsAdding(true)}
						>
							{t("providers.add")}
						</Button>
					</aside>

					<div className="providers-settings__detail">
						{isAdding ? (
							<AddProviderDialog
								isPending={pendingAction === "create"}
								onCancel={() => setIsAdding(false)}
								onSubmit={createProvider}
							/>
						) : selectedProvider === undefined ? (
							<p className="provider-models__hint">{t("providers.selectPrompt")}</p>
						) : (
							<>
								<ProviderForm
									provider={selectedProvider}
									{...(pendingAction === "save" ||
									pendingAction === "test" ||
									pendingAction === "delete"
										? { pendingAction }
										: {})}
									onSave={saveProvider}
									onTest={() => testProvider(selectedProvider.id)}
									onDelete={() => deleteProvider(selectedProvider.id)}
									onInvalid={(messageKey) => setFeedback({ tone: "danger", messageKey })}
								/>
								<ProviderModelList
									provider={selectedProvider}
									isFetching={pendingAction === "fetch-models"}
									isSaving={pendingAction === "save-models"}
									onFetch={() => fetchModels(selectedProvider.id)}
									onEnabledChange={(enabledModelIds) =>
										saveEnabledModels(selectedProvider.id, enabledModelIds)
									}
								/>
								<aside className="chat-card provider-security-card">
									<span className="chat-card__eyebrow">{t("providers.storageEyebrow")}</span>
									<h2>{t("providers.storageTitle")}</h2>
									<p>{t("providers.storageDescription")}</p>
								</aside>
							</>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
