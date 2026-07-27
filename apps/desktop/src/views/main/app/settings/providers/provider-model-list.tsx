import { Button } from "@heroui/react";
import type { ProviderModel, ProviderSummary } from "@moshu/contracts";
import { useId, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { formatTokenCount } from "../provider-shared";

export interface ProviderModelListProps {
	provider: ProviderSummary;
	isFetching: boolean;
	isSaving: boolean;
	onFetch(): void;
	onEnabledChange(enabledModelIds: string[]): void;
}

export function ProviderModelList({
	provider,
	isFetching,
	isSaving,
	onFetch,
	onEnabledChange,
}: ProviderModelListProps) {
	const { t } = useI18n();
	const searchId = useId();
	const [query, setQuery] = useState("");
	const enabledCount = provider.models.filter((model) => model.enabled).length;
	const visibleModels = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (normalized.length === 0) {
			return provider.models;
		}
		return provider.models.filter(
			(model) =>
				model.id.toLocaleLowerCase().includes(normalized) ||
				(model.displayName ?? "").toLocaleLowerCase().includes(normalized),
		);
	}, [provider.models, query]);

	const toggleModel = (modelId: string, enabled: boolean) => {
		const next = provider.models
			.filter((model) => (model.id === modelId ? enabled : model.enabled))
			.map((model) => model.id);
		onEnabledChange(next);
	};

	return (
		<section className="chat-card provider-models">
			<div className="provider-models__header">
				<div>
					<span className="chat-card__eyebrow">{t("providers.models")}</span>
					<h2>
						{t(
							"providers.models.enabledCount",
							String(enabledCount),
							String(provider.models.length),
						)}
					</h2>
					{provider.modelsFetchedAt === undefined ? null : (
						<p className="provider-models__timestamp">
							{t("providers.models.fetchedAt", new Date(provider.modelsFetchedAt).toLocaleString())}
						</p>
					)}
				</div>
				<Button
					className="chat-button chat-button--primary"
					isDisabled={isFetching || isSaving}
					onPress={onFetch}
				>
					{isFetching ? t("providers.models.fetching") : t("providers.models.fetch")}
				</Button>
			</div>

			{provider.models.length === 0 ? (
				<div className="provider-models__empty">
					<p>{t("providers.models.empty")}</p>
					<p className="provider-models__hint">{t("providers.models.emptyHint")}</p>
				</div>
			) : (
				<>
					<div className="provider-models__toolbar">
						<label className="chat-field chat-field--inline" htmlFor={searchId}>
							<span className="chat-live-region">{t("providers.models.searchLabel")}</span>
							<input
								id={searchId}
								type="search"
								value={query}
								placeholder={t("providers.models.searchPlaceholder")}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</label>
						<div className="provider-models__bulk">
							<Button
								className="chat-button chat-button--inline"
								isDisabled={isSaving}
								onPress={() => onEnabledChange(provider.models.map((model) => model.id))}
							>
								{t("providers.models.selectAll")}
							</Button>
							<Button
								className="chat-button chat-button--inline"
								isDisabled={isSaving}
								onPress={() => onEnabledChange([])}
							>
								{t("providers.models.selectNone")}
							</Button>
						</div>
					</div>

					{visibleModels.length === 0 ? (
						<p className="provider-models__hint">{t("providers.models.noMatches")}</p>
					) : (
						<ul className="provider-models__list">
							{visibleModels.map((model) => (
								<li className="provider-models__item" key={model.id}>
									<label>
										<input
											type="checkbox"
											checked={model.enabled}
											disabled={isSaving}
											aria-label={t("providers.models.enableLabel", model.displayName ?? model.id)}
											onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
										/>
										<span className="provider-models__name">
											<strong>{model.displayName ?? model.id}</strong>
											{model.displayName === undefined ? null : (
												<code className="provider-models__id">{model.id}</code>
											)}
										</span>
									</label>
									<ModelBadges model={model} />
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}

function ModelBadges({ model }: { model: ProviderModel }) {
	const { t } = useI18n();
	const badges: string[] = [];

	if (model.contextWindowTokens !== undefined) {
		badges.push(t("providers.models.context", formatTokenCount(model.contextWindowTokens)));
	}
	if (model.maxOutputTokens !== undefined) {
		badges.push(t("providers.models.output", formatTokenCount(model.maxOutputTokens)));
	}
	if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0) {
		badges.push(t("providers.models.effort", String(model.reasoningEfforts.length)));
	}
	if (model.thinking !== undefined) {
		badges.push(t("providers.models.thinking"));
	}
	if (model.kind !== undefined) {
		badges.push(model.kind);
	}
	if (model.supportedEndpoints !== undefined) {
		badges.push(...model.supportedEndpoints);
	}

	return badges.length === 0 ? null : (
		<div className="provider-models__badges">
			{badges.map((badge) => (
				<span className="provider-models__badge" key={badge}>
					{badge}
				</span>
			))}
		</div>
	);
}
