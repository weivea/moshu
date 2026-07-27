import type { AvailableModel, ThinkingLevel } from "@moshu/contracts";
import { useId } from "react";

import { useI18n } from "../i18n";

export interface ModelSelectorProps {
	models: readonly AvailableModel[];
	providerId?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	isDisabled?: boolean;
	onSelect(providerId: string, modelId: string): void;
	onThinkingLevelChange(level: ThinkingLevel | undefined): void;
}

export function ModelSelector({
	models,
	providerId,
	modelId,
	thinkingLevel,
	isDisabled = false,
	onSelect,
	onThinkingLevelChange,
}: ModelSelectorProps) {
	const { t } = useI18n();
	const selectId = useId();
	const thinkingId = useId();
	const selected = models.find(
		(entry) => entry.providerId === providerId && entry.model.id === modelId,
	);
	const groups = groupByProvider(models);

	return (
		<div className="model-selector">
			<label className="model-selector__field" htmlFor={selectId}>
				<span className="chat-live-region">{t("model.picker.label")}</span>
				<select
					id={selectId}
					value={selected === undefined ? "" : toOptionValue(selected)}
					disabled={isDisabled || models.length === 0}
					onChange={(event) => {
						const [nextProviderId, nextModelId] = splitOptionValue(event.currentTarget.value);
						if (nextProviderId !== undefined && nextModelId !== undefined) {
							onSelect(nextProviderId, nextModelId);
						}
					}}
				>
					<option value="" disabled>
						{models.length === 0 ? t("model.picker.empty") : t("model.picker.placeholder")}
					</option>
					{groups.map((group) => (
						<optgroup key={group.providerId} label={group.providerDisplayName}>
							{group.models.map((entry) => (
								<option key={toOptionValue(entry)} value={toOptionValue(entry)}>
									{entry.model.displayName}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>
			{selected === undefined || selected.model.thinkingLevels.length === 0 ? null : (
				<label className="model-selector__field" htmlFor={thinkingId}>
					<span className="chat-live-region">{t("model.reasoning.effortLabel")}</span>
					<select
						id={thinkingId}
						value={thinkingLevel ?? ""}
						disabled={isDisabled}
						onChange={(event) => {
							const value = event.currentTarget.value;
							onThinkingLevelChange(value.length === 0 ? undefined : (value as ThinkingLevel));
						}}
					>
						<option value="">{t("model.reasoning.effortDefault")}</option>
						{selected.model.thinkingLevels.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>
			)}
		</div>
	);
}

function groupByProvider(models: readonly AvailableModel[]) {
	const groups = new Map<
		string,
		{ providerId: string; providerDisplayName: string; models: AvailableModel[] }
	>();
	for (const model of models) {
		const group = groups.get(model.providerId) ?? {
			providerId: model.providerId,
			providerDisplayName: model.providerDisplayName,
			models: [],
		};
		group.models.push(model);
		groups.set(model.providerId, group);
	}
	return [...groups.values()];
}

function toOptionValue(model: AvailableModel): string {
	return `${model.providerId}\0${model.model.id}`;
}

function splitOptionValue(value: string): [string | undefined, string | undefined] {
	const separator = value.indexOf("\0");
	return separator < 0
		? [undefined, undefined]
		: [value.slice(0, separator), value.slice(separator + 1)];
}
