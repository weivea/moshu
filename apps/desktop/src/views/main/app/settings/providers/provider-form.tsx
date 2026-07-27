import { Button } from "@heroui/react";
import type { ProviderSummary, ProviderType, UpdateProviderInput } from "@moshu/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";

import { ConfirmationDialog } from "../../confirmation-dialog";
import { useI18n } from "../../i18n";
import {
	CustomHeadersParseError,
	parseCustomHeaders,
	providerTypeOptions,
} from "../provider-shared";

export type ProviderFormAction = "save" | "test" | "delete";

export interface ProviderFormProps {
	provider: ProviderSummary;
	pendingAction?: ProviderFormAction;
	onSave(input: UpdateProviderInput): void;
	onTest(): void;
	onDelete(): void;
	onInvalid(messageKey: "providers.error.required" | "providers.error.customHeaders"): void;
}

export function ProviderForm({
	provider,
	pendingAction,
	onSave,
	onTest,
	onDelete,
	onInvalid,
}: ProviderFormProps) {
	const { t } = useI18n();
	const fieldId = useId();
	const [displayName, setDisplayName] = useState(provider.displayName);
	const [type, setType] = useState<ProviderType>(provider.type);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [apiKey, setApiKey] = useState("");
	const [customHeaders, setCustomHeaders] = useState("");
	const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] = useState(false);
	const isDisabled = pendingAction !== undefined;

	useEffect(() => {
		setDisplayName(provider.displayName);
		setType(provider.type);
		setBaseUrl(provider.baseUrl);
		setApiKey("");
		setCustomHeaders("");
	}, [provider]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (displayName.trim().length === 0 || baseUrl.trim().length === 0) {
			onInvalid("providers.error.required");
			return;
		}

		let headers: Record<string, string> | undefined;
		try {
			headers = parseCustomHeaders(customHeaders);
		} catch (error) {
			onInvalid(
				error instanceof CustomHeadersParseError
					? "providers.error.customHeaders"
					: "providers.error.required",
			);
			return;
		}

		const trimmedApiKey = apiKey.trim();
		onSave({
			schemaVersion: 1,
			providerId: provider.id,
			displayName: displayName.trim(),
			type,
			baseUrl: baseUrl.trim(),
			...(trimmedApiKey.length === 0 ? {} : { apiKey: trimmedApiKey }),
			...(customHeaders.trim().length === 0 ? {} : { customHeaders: headers ?? {} }),
		});
	};

	return (
		<form
			className="chat-card provider-form"
			onSubmit={submit}
			aria-label={t("providers.editTitle")}
		>
			<div className="provider-status-row">
				<div>
					<span className="chat-card__eyebrow">{t("providers.editTitle")}</span>
					<h2>{provider.displayName}</h2>
				</div>
				<label className="provider-toggle">
					<input
						type="checkbox"
						checked={provider.enabled}
						disabled={isDisabled}
						onChange={(event) =>
							onSave({
								schemaVersion: 1,
								providerId: provider.id,
								enabled: event.currentTarget.checked,
							})
						}
					/>
					<span>{provider.enabled ? t("providers.enabled") : t("providers.disabled")}</span>
				</label>
			</div>

			<label className="chat-field" htmlFor={`${fieldId}-name`}>
				<span>{t("providers.displayName")}</span>
				<input
					id={`${fieldId}-name`}
					required
					maxLength={120}
					value={displayName}
					disabled={isDisabled}
					onChange={(event) => setDisplayName(event.currentTarget.value)}
				/>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-type`}>
				<span>{t("providers.type")}</span>
				<select
					id={`${fieldId}-type`}
					value={type}
					disabled={isDisabled}
					onChange={(event) => setType(event.currentTarget.value as ProviderType)}
				>
					{providerTypeOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{t(option.label)}
						</option>
					))}
				</select>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-base-url`}>
				<span>{t("providers.baseUrl")}</span>
				<input
					id={`${fieldId}-base-url`}
					type="url"
					required
					value={baseUrl}
					disabled={isDisabled}
					onChange={(event) => setBaseUrl(event.currentTarget.value)}
				/>
				<small className="chat-field__hint">{t("providers.baseUrlHint")}</small>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-api-key`}>
				<span>{t("providers.apiKey")}</span>
				<input
					id={`${fieldId}-api-key`}
					type="password"
					autoComplete="off"
					value={apiKey}
					disabled={isDisabled}
					placeholder={t("providers.apiKeyConfigured", provider.apiKeyMask ?? "")}
					onChange={(event) => setApiKey(event.currentTarget.value)}
				/>
				<small className="chat-field__hint">{t("providers.apiKeyKeepHint")}</small>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-headers`}>
				<span>{t("providers.customHeaders")}</span>
				<textarea
					id={`${fieldId}-headers`}
					rows={2}
					value={customHeaders}
					placeholder="{}"
					disabled={isDisabled}
					onChange={(event) => setCustomHeaders(event.currentTarget.value)}
				/>
				<small className="chat-field__hint">
					{provider.customHeaderNames.length === 0
						? t("providers.customHeadersHint")
						: t("providers.customHeadersStored", provider.customHeaderNames.join(", "))}
				</small>
			</label>

			<p className="provider-form__danger-hint">{t("providers.delete.description")}</p>

			<div className="provider-form__actions">
				<ConfirmationDialog
					isOpen={isDeleteConfirmationOpen}
					isPending={pendingAction === "delete"}
					isTriggerDisabled={isDisabled}
					triggerLabel={t("providers.delete.action")}
					triggerClassName="confirmation-dialog-trigger confirmation-dialog-trigger--danger"
					title={t("providers.delete.title")}
					description={t("providers.delete.confirm", provider.displayName)}
					cancelLabel={t("action.cancel")}
					confirmLabel={t("providers.delete.action")}
					pendingLabel={t("providers.deleting")}
					onOpenChange={setIsDeleteConfirmationOpen}
					onConfirm={async () => {
						onDelete();
						setIsDeleteConfirmationOpen(false);
					}}
				/>
				<Button className="chat-button" isDisabled={isDisabled} onPress={onTest}>
					{pendingAction === "test" ? t("providers.testing") : t("providers.test")}
				</Button>
				<Button type="submit" className="chat-button chat-button--primary" isDisabled={isDisabled}>
					{pendingAction === "save" ? t("providers.saving") : t("providers.save")}
				</Button>
			</div>
		</form>
	);
}
