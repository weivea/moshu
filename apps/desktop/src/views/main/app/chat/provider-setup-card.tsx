import { Button } from "@heroui/react";
import { type FormEvent, useId } from "react";
import { useI18n } from "../i18n";

export interface ProviderSetupCardProps {
	canSubmit: boolean;
	endpoint: string;
	errorMessage?: string | null;
	isLoading: boolean;
	model: string;
	apiKey: string;
	onApiKeyChange(value: string): void;
	onEndpointChange(value: string): void;
	onModelChange(value: string): void;
	onSubmit(): void;
}

export function ProviderSetupCard({
	apiKey,
	canSubmit,
	endpoint,
	errorMessage,
	isLoading,
	model,
	onApiKeyChange,
	onEndpointChange,
	onModelChange,
	onSubmit,
}: ProviderSetupCardProps) {
	const { t } = useI18n();
	const endpointId = useId();
	const modelId = useId();
	const apiKeyId = useId();

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onSubmit();
	}

	return (
		<section className="chat-card chat-card--form">
			<div className="chat-card__header">
				<div>
					<span className="chat-card__eyebrow">{t("chat.provider.eyebrow")}</span>
					<h2>{t("chat.provider.title")}</h2>
				</div>
				<p>{t("chat.provider.description")}</p>
			</div>

			<form className="chat-form" onSubmit={handleSubmit}>
				<label className="chat-field" htmlFor={endpointId}>
					<span>{t("chat.provider.endpoint")}</span>
					<input
						id={endpointId}
						name="endpoint"
						value={endpoint}
						onChange={(event) => onEndpointChange(event.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
				</label>

				<label className="chat-field" htmlFor={modelId}>
					<span>{t("chat.provider.model")}</span>
					<input
						id={modelId}
						name="model"
						value={model}
						onChange={(event) => onModelChange(event.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
				</label>

				<label className="chat-field" htmlFor={apiKeyId}>
					<span>{t("chat.provider.apiKey")}</span>
					<input
						id={apiKeyId}
						name="apiKey"
						type="password"
						value={apiKey}
						onChange={(event) => onApiKeyChange(event.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
				</label>

				<p className="chat-field__hint">{t("chat.provider.securityHint")}</p>

				{errorMessage ? (
					<p className="chat-notice chat-notice--danger" role="alert">
						{errorMessage}
					</p>
				) : null}

				<Button className="chat-button chat-button--primary" type="submit" isDisabled={!canSubmit}>
					{isLoading ? t("chat.provider.submitting") : t("chat.provider.submit")}
				</Button>
			</form>
		</section>
	);
}
