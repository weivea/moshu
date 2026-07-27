import { Button } from "@heroui/react";
import type { CreateProviderInput, CustomProviderApi } from "@moshu/contracts";
import { type FormEvent, useId, useState } from "react";

import { useI18n } from "../../i18n";
import {
	CustomHeadersParseError,
	parseCustomHeaders,
	providerTypeOptions,
} from "../provider-shared";

export interface AddProviderDialogProps {
	isPending: boolean;
	onCancel(): void;
	onSubmit(input: CreateProviderInput): void;
}

export function AddProviderDialog({ isPending, onCancel, onSubmit }: AddProviderDialogProps) {
	const { t } = useI18n();
	const fieldId = useId();
	const [displayName, setDisplayName] = useState("");
	const [api, setApi] = useState<CustomProviderApi>("openai-completions");
	const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
	const [apiKey, setApiKey] = useState("");
	const [customHeaders, setCustomHeaders] = useState("");
	const [error, setError] = useState<string>();

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (displayName.trim().length === 0 || baseUrl.trim().length === 0) {
			setError(t("providers.error.required"));
			return;
		}
		if (apiKey.trim().length === 0) {
			setError(t("providers.error.apiKeyRequired"));
			return;
		}

		let headers: Record<string, string> | undefined;
		try {
			headers = parseCustomHeaders(customHeaders);
		} catch (parseError) {
			setError(
				parseError instanceof CustomHeadersParseError
					? t("providers.error.customHeaders")
					: t("providers.error.create"),
			);
			return;
		}

		setError(undefined);
		onSubmit({
			schemaVersion: 2,
			displayName: displayName.trim(),
			api,
			baseUrl: baseUrl.trim(),
			apiKey: apiKey.trim(),
			...(headers === undefined ? {} : { customHeaders: headers }),
		});
	};

	return (
		<form
			className="chat-card provider-form"
			onSubmit={submit}
			aria-label={t("providers.addTitle")}
		>
			<h2>{t("providers.addTitle")}</h2>

			<label className="chat-field" htmlFor={`${fieldId}-name`}>
				<span>{t("providers.displayName")}</span>
				<input
					id={`${fieldId}-name`}
					required
					maxLength={120}
					value={displayName}
					placeholder={t("providers.displayNamePlaceholder")}
					disabled={isPending}
					onChange={(event) => setDisplayName(event.currentTarget.value)}
				/>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-type`}>
				<span>{t("providers.type")}</span>
				<select
					id={`${fieldId}-type`}
					value={api}
					disabled={isPending}
					onChange={(event) => setApi(event.currentTarget.value as CustomProviderApi)}
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
					disabled={isPending}
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
					placeholder={t("providers.apiKeyPlaceholder")}
					disabled={isPending}
					onChange={(event) => setApiKey(event.currentTarget.value)}
				/>
				<small className="chat-field__hint">{t("providers.apiKeyLocalHint")}</small>
			</label>

			<label className="chat-field" htmlFor={`${fieldId}-headers`}>
				<span>{t("providers.customHeaders")}</span>
				<textarea
					id={`${fieldId}-headers`}
					rows={2}
					value={customHeaders}
					placeholder="{}"
					disabled={isPending}
					onChange={(event) => setCustomHeaders(event.currentTarget.value)}
				/>
				<small className="chat-field__hint">{t("providers.customHeadersHint")}</small>
			</label>

			{error === undefined ? null : (
				<div className="chat-notice chat-notice--danger" role="alert">
					{error}
				</div>
			)}

			<div className="provider-form__actions">
				<Button className="chat-button" isDisabled={isPending} onPress={onCancel}>
					{t("action.cancel")}
				</Button>
				<Button type="submit" className="chat-button chat-button--primary" isDisabled={isPending}>
					{isPending ? t("providers.creating") : t("providers.create")}
				</Button>
			</div>
		</form>
	);
}
